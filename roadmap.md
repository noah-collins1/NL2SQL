# NL2SQL Architecture Roadmap

## Architecture Overview

**Goal:** Implement Option A: TypeScript Smithery Postgres MCP server extended with a stateless `nl_query` tool that routes:

```
User/Chat → nl_query(NL JSON) → TS MCP → Python sidecar → Ollama (Hrida) → SQL → TS validation → Postgres → results
```

## Why This Change

LibreChat's multi-agent chain (Hrida agent → executor agent → MCP query tool) is fragile:
- Agents are stateful → context drains/pollutes
- Even when Hrida generates good SQL, executor layer fails:
  - Quote escaping bugs (single → double quotes)
  - "Tool simulation" (showing JSON without executing)
  - Hallucinated results

**Solution:** Eliminate the executor layer entirely. Make NL→SQL→execute a single stateless tool call.

## Fixed Constraints

1. **MCP server:** TypeScript (Smithery fork)
2. **AI logic:** Python (all AI code)
3. **Model runtime:** Ollama hosting Hrida (NL2SQL)
4. **Security boundary:** Python sidecar does NOT talk to Postgres (TS owns DB creds + execution)
5. **Safety:** Read-only DB role + strict server-side SQL validation

## Current State → Destination

- **Today:** MCPtest (2 tables, 100 companies, 1,000 revenue records)
- **Future:** Enterprise-scale (1,000+ tables, multi-tenant, governance, PII controls)
- **Requirement:** MVP works now, doesn't paint us into a corner later

---

## Critical Bottlenecks at Scale

### 🔴 1. Schema Metadata Collection (100-500ms → 5s at scale)

**The problem:**
- `INFORMATION_SCHEMA` queries on 1,000-table databases take 2-5 seconds
- Postgres rebuilds these views on each query (not materialized)
- 1,000 tables × 20 columns avg = 20,000 rows to scan

**What breaks first:**
- Cold start after server restart: 5-10 second wait
- Cache invalidation during peak hours: users wait
- Multi-tenant: each DB needs separate cache warmup

**Solutions:**
- Pre-warm cache on server startup (async background task)
- Later: maintain `schema_catalog` table:
  ```sql
  CREATE TABLE mcp_schema_cache (
    table_name TEXT,
    column_name TEXT,
    data_type TEXT,
    description TEXT,
    domain TEXT,
    last_updated TIMESTAMP,
    PRIMARY KEY (table_name, column_name)
  );
  ```
  - Query time: <50ms even for 10,000 tables
  - Refresh incrementally (only changed tables)
  - Update via migration scripts

### 🟡 2. TS→Python HTTP Latency (Actually 10-50ms)

**Reality check:**
- Localhost HTTP: 1-2ms ✓
- JSON serialization (large schema): 5-20ms
- Python deserialization: 5-10ms
- **Total: 10-50ms per round-trip**

**At scale:**
- 1,000-table schema → 500KB-2MB JSON
- Serialization: 20-50ms
- Under load (100 concurrent): P95 latency jumps to 3-5s

**Solutions:**
- **gRPC + Protobuf:** 5-10x faster serialization
- **Keep payloads minimal:** Send table IDs, Python looks up details from cache
- **Connection pooling:** HTTP keep-alive, pre-established connections

### 🟡 3. Ollama Concurrency (Single-Request-at-a-Time)

**The killer constraint:**
- Ollama processes one request at a time by default
- User A: 2 seconds
- User B: queued, waits 2 seconds
- User C: queued, waits 4 seconds
- **P99 latency explodes under load**

**Solutions:**
1. **Multiple Ollama instances** (recommended):
   ```
   Ollama 1: localhost:11434
   Ollama 2: localhost:11435
   Ollama 3: localhost:11436
   Ollama 4: localhost:11437
   ```
   - Throughput: 4x
   - Cost: 4x GPU memory (7B model = ~8GB × 4 = 32GB VRAM)

2. **Request batching** (advanced):
   - Queue 5-10 requests
   - Send batch to Ollama
   - Amortize overhead

3. **Priority queuing:**
   - Simple queries (COUNT) → fast lane
   - Complex queries (multi-JOIN) → slow lane
   - VIP users → express lane

---

## Schema Relevance Pipeline

Your three-stage funnel is solid. Refinements:

### Stage 1: Keyword/Heuristic Filter

**Add: Query intent classification**
```python
intent = classify_intent(question)
# Returns: "count", "list", "aggregate", "compare", "trend", "detail"

if intent == "count":
    prefer_tables_without_joins = True
elif intent == "trend":
    prefer_tables_with_date_columns = True
```

**Add: Column-level filtering**
```python
# User asks: "revenue in 2023"
entities = ["revenue", "2023"]

# Match:
# - Tables: company_revenue_annual ✓
# - Columns: revenue_millions ✓, year ✓
# Score += 1 for each match
```

**Target:** 1,000 tables → ~50 candidates (<50ms)

### Stage 2: Semantic Ranking

**Optimization: Pre-compute embeddings**
```python
# Offline (daily):
# - Embed all table descriptions → vector DB
# - Pre-compute embeddings for common question patterns

# Runtime:
# 1. Check if question matches known pattern (fuzzy match)
# 2. If yes: use pre-computed embedding (0ms)
# 3. If no: embed query (100ms), cache for next time

# Result: 90% of queries skip embedding step
```

**Alternative: Hybrid search**
- BM25 (keyword, ~10ms) + Semantic similarity (100ms)
- Use BM25 for first-pass, semantic for final ranking

**Target:** ~50 tables → ~10 tables (~100ms)

### Stage 3: Relationship Expansion

**Add: Distance limit + relevance scoring**
```python
def expand_relationships(selected_tables, max_distance=2):
    for table in selected_tables:
        related = get_fks(table, max_hops=2)

        # Score by:
        # - Distance (1 hop = 1.0, 2 hops = 0.5)
        # - FK usage frequency
        # - Table size (small lookup tables score higher)

        # Keep only top 5 related tables per seed
        return top_n(related, n=5, by=score)
```

**Add: Junction table detection**
```python
if is_junction_table(table):
    # Always include both sides of M:M
    include(left_table, junction_table, right_table)
```

**Target:** Completeness without bloating prompt (<10ms)

---

## TS↔Python Contract (Long-Term Stability)

### Request Interface
```typescript
interface NLQueryRequest {
  // Core
  question: string;
  database_id: string;  // For multi-DB later

  // Context (optional)
  user_id?: string;
  session_id?: string;
  previous_query_id?: string;  // Follow-up questions

  // Schema hints (optional)
  table_hints?: string[];
  domain_hint?: string;  // "finance", "hr", "operations"

  // Constraints
  max_rows?: number;        // Default 100, max 10000
  timeout_seconds?: number; // Default 30
  read_only?: boolean;      // Default true

  // Debugging
  explain?: boolean;
  trace?: boolean;
}
```

### Response Interface
```typescript
interface NLQueryResponse {
  // Metadata
  query_id: string;
  question: string;
  database_id: string;

  // SQL Generation
  sql_generated: string;
  sql_valid: boolean;
  validation_errors?: string[];

  // Execution (set by TS after)
  executed?: boolean;
  execution_time_ms?: number;
  rows_returned?: number;
  rows?: Record<string, any>[];

  // Confidence & Notes
  confidence_score: number;  // 0.0-1.0
  notes?: string;

  // Audit trail
  tables_selected: string[];
  tables_used_in_sql: string[];

  // Trace (optional)
  trace?: {
    stage1_tables: string[];
    stage2_tables: string[];
    stage3_tables: string[];
    hrida_latency_ms: number;
    total_latency_ms: number;
  };

  // Error handling
  error?: {
    type: string;  // "generation", "validation", "execution"
    message: string;
    recoverable: boolean;
  };
}
```

**Why this contract:**
- ✅ Versionable (optional fields, add without breaking)
- ✅ Traceable (query_id links request→response)
- ✅ Debuggable (trace shows exactly what happened)
- ✅ Future-proof (database_id, previous_query_id)
- ✅ Observable (latency per component)

---

## Caching Boundaries

### Cache in TypeScript (TS MCP Server)

1. **Schema metadata (full)**
   - What: Complete INFORMATION_SCHEMA dump
   - Why: TS needs for SQL validation after Python returns SQL
   - TTL: 15 minutes
   - Storage: In-memory Map or Redis

2. **SQL validation results**
   - What: (sql_hash → valid/invalid + reason)
   - TTL: 1 hour
   - Storage: In-memory Map (~10MB)

3. **Query result cache** (optional)
   - What: (sql_hash → result rows)
   - TTL: 5-30 minutes
   - Storage: Redis (can be large)

4. **Connection pool**
   - What: Postgres connections
   - Size: 10-50 connections
   - Library: `pg-pool`

### Cache in Python (AI Sidecar)

1. **Table embeddings**
   - What: Vector representations of table descriptions
   - TTL: 24 hours or until schema change
   - Storage: In-memory numpy/FAISS
   - Size: ~1KB per table × 1,000 = 1MB

2. **Query embeddings** (common patterns)
   - What: Pre-computed for frequent questions
   - TTL: Indefinite (refresh weekly)
   - Storage: In-memory dict

3. **Schema metadata** (lightweight)
   - What: Table/column names, descriptions (no stats)
   - TTL: 15 minutes (sync with TS)
   - Storage: In-memory dict
   - Size: ~10KB per table × 1,000 = 10MB

4. **NL → SQL memoization**
   - What: (question_hash → SQL)
   - TTL: 1 hour
   - Storage: Redis (shared across Python instances)
   - Hit rate: 20-40% in production

5. **FK relationship graph**
   - What: Pre-computed adjacency matrix
   - TTL: 24 hours
   - Storage: In-memory dict
   - Size: ~1KB per table × 1,000 = 1MB

### Cache Coherency Strategy

**Master-Slave Pattern:**
```
TS (Master) ──schema update event──> Python (Slave)
```

**On schema change:**
1. TS detects change (DDL trigger or periodic check)
2. TS invalidates its cache
3. TS sends: `POST /invalidate_cache?database_id=mcptest`
4. Python flushes all schema-related caches
5. Both rebuild from source of truth (Postgres)

---

## Hidden Risks & Mitigations

### 🔴 Risk 1: Python SPOF

**Scenario:** Python crashes → all queries fail

**Mitigation:**
- Multiple Python instances behind load balancer
- TS keeps pool of endpoints:
  ```typescript
  const pythonPool = [
    'http://localhost:8001',
    'http://localhost:8002',
    'http://localhost:8003'
  ];
  ```
- Health checks every 30s
- Circuit breaker (fail fast if Python down)

### 🔴 Risk 2: Model Updates Break Behavior

**Scenario:** Update Ollama → Hrida changes → SQL errors spike

**Mitigation:**
- Pin model version: `ollama pull HridaAI/hrida-t2sql:v1.2.3` (not `:latest`)
- Canary testing: route 5% traffic to new version
- Model version in audit logs
- Rollback if errors spike

### 🟡 Risk 3: Schema Cache Poisoning

**Scenario:** Bad schema cached → all queries fail for 15 min

**Mitigation:**
- Validation on cache load
- Graceful degradation (fetch fresh on error)
- Admin endpoint to force refresh

### 🟡 Risk 4: SQL Injection via Prompt Injection

**Scenario:** User asks: "Show all users; DROP TABLE companies; --"

**Mitigation layers:**
1. Reject multiple statements
2. Whitelist SELECT only
3. Postgres read-only user
4. Separate schema for query user

### 🟡 Risk 5: Inference Cost Explosion

**Scenario:** Users spam queries → Ollama pegged at 100%

**Mitigation:**
- Rate limiting (per user): 10 queries/min
- Queue with priority
- Request timeout (30s)
- Cost monitoring + alerts

### 🟢 Risk 6: Thundering Herd on Cache Miss

**Scenario:** Cache expires → 100 requests rebuild simultaneously

**Mitigation: Cache stampede protection**
```typescript
const cacheLock = new Map<string, Promise>();

// First request fetches, others wait
if (existingFetch) return await existingFetch;
```

---

## MVP Path (6 Phases)

### Phase 1: Single-DB, Hardcoded Schema (Week 1-2)

**Goal:** Prove TS↔Python↔Ollama pipeline works

**Scope:**
- MCPtest only
- Hardcode schema in Python
- Skip Stage 2 (semantic)
- Skip Stage 3 (FK expansion)
- Single Ollama instance
- In-memory caches only

**Architecture:**
```
MCP Server (TS)         Python Sidecar
┌─────────────┐         ┌────────────────┐
│ nl_query()  │────────>│ Stage 1:       │
│             │  HTTP   │  Keyword filter│
│ validate()  │<────────│                │
│             │  SQL    │ Ollama call    │
│ execute()   │         │  (temp=0.0)    │
└─────────────┘         └────────────────┘
      │
      v
  Postgres
```

**Target:** 85-90% success on Test 3 questions

### Phase 2: Dynamic Schema Loading (Week 3-4)

**Add:**
- TS fetches schema from INFORMATION_SCHEMA
- TS sends compressed schema to Python
- Cache in both TS and Python
- Admin endpoint: `/reload_schema`

**Test:** MCPtest + new DB (different schema)

### Phase 3: Multi-Table Queries (Week 5-6)

**Add:**
- Stage 3: Relationship expansion
- Pre-compute FK graph
- Cache FK graph (24h TTL)

**Test:** All JOIN queries from Test 3

### Phase 4: Semantic Search (Week 7-8)

**Add:**
- Embed table descriptions offline
- Stage 2: Semantic ranking
- Hybrid search: BM25 + semantic

**Test:** Ambiguous queries, synonyms

### Phase 5: Scale & Production (Week 9-12)

**Add:**
- Multiple Ollama instances + LB
- Redis for shared caching
- gRPC (optional)
- Structured logging (OpenTelemetry)
- Monitoring (Grafana)
- Rate limiting
- SQL cost gating (EXPLAIN)

**Test:** 100 concurrent users, failure scenarios

### Phase 6: Advanced Features (Week 13+)

**Add:**
- Write operations (preview + approval)
- Multi-tenant isolation
- Per-user permissions

---

## Critical Success Metrics

### MVP Success (After Phase 3):
- ✅ 90%+ success rate on Test 3 questions
- ✅ <3 second P95 latency (end-to-end)
- ✅ Zero executor bugs (quote escaping, tool simulation, hallucination)
- ✅ Supports any Postgres database

### Production Ready (After Phase 5):
- ✅ 95%+ success rate
- ✅ <2 second P95 latency (normal load)
- ✅ <5 second P99 latency (peak load)
- ✅ 100 concurrent users
- ✅ 99.9% uptime

### Enterprise Ready (After Phase 6):
- ✅ 99%+ success rate
- ✅ Multi-tenant
- ✅ Full audit trail
- ✅ Controlled write operations
- ✅ Cost per query <$0.01

---

## Decision Points

### Now vs Later

**Do NOW:**
- HTTP/JSON for TS↔Python (fast to implement)
- Hardcode MCPtest schema in Phase 1
- Single Ollama instance
- INFORMATION_SCHEMA + caching

**Do LATER (when needed):**
- gRPC (when latency becomes issue)
- Multiple Ollama instances (when load increases)
- `schema_catalog` table (when >100 tables)
- Stage 2/3 (when simple keyword filtering fails)

### Enterprise-Ready "Seams" (Design Now)

Even if implementing later, these interfaces must be right:

1. **Request/Response Contract:** Include `database_id`, `query_id`, `trace`
2. **Cache Invalidation:** TS → Python endpoint from day one
3. **SQL Validation:** Pluggable validators (easy to add rules)
4. **Audit Logging:** Log everything (question, SQL, result, latency)
5. **Error Types:** Structured errors (`generation`, `validation`, `execution`)

---

## Conclusion

**Your architecture is sound.** The risks are manageable. Start with Phase 1 MVP and expand incrementally.

**Timeline:**
- Phase 1-2: Prove concept (2-4 weeks) → 85-90%
- Phase 3-4: Scale complexity (4-8 weeks) → 90-95%
- Phase 5-6: Production + enterprise (8-12 weeks) → 95-99%

**What will break first:**
1. Schema metadata collection (fixable with cache + `schema_catalog`)
2. Python HTTP latency (fixable with gRPC)
3. Ollama concurrency (fixable with multiple instances)

All of these are known, manageable, and have clear solutions.
