# Schema RAG V2 Integration & Exam Playbook

## Integration Summary

### Feature Flags

```bash
# Enable V2 dual retrieval + score fusion
export USE_SCHEMA_RAG_V2=true

# Enable detailed exam logging
export EXAM_MODE=true

# Optional: Custom log directory
export EXAM_LOG_DIR=./exam_logs
```

### Files Modified

| File | Change |
|------|--------|
| `config.ts` | Added `USE_SCHEMA_RAG_V2`, `EXAM_MODE` flags |
| `config.ts` | Extended `PostgresErrorContext` with column candidates |
| `nl_query_tool.ts` | Conditional V1/V2 retriever selection |
| `nl_query_tool.ts` | Column candidate enrichment for 42703 errors |
| `nl_query_tool.ts` | Exam instrumentation (`logExamRetrievalMetrics`, `classifyExamFailure`) |

### Retriever Selection Logic

```typescript
if (useRAG) {
  if (USE_SCHEMA_RAG_V2) {
    // V2: Dual retrieval + score fusion
    const retrieverV2 = getSchemaRetrieverV2(pool, logger)
    const { packet, metrics } = await retrieverV2.retrieveSchemaContext(...)
  } else {
    // V1: Original single-entity retrieval
    const retriever = getSchemaRetriever(pool, logger)
    schemaContext = await retriever.retrieveSchemaContext(...)
  }
}
```

---

## 2. Exam Instrumentation Specification

### Log Output Format

**JSONL file**: `exam_logs/exam_retrieval_YYYY-MM-DD.jsonl`

Each line contains:

```json
{
  "timestamp": "2025-01-26T10:15:30.000Z",
  "query_id": "abc-123",
  "question": "Which employees have pending leave requests?",
  "retriever_version": "V2",

  "tables_retrieved": ["employees", "leave_requests", "leave_types"],
  "tables_from_table_retrieval": 2,
  "tables_from_column_only": 1,
  "tables_from_fk_expansion": 0,

  "table_scores": [
    {"table": "employees", "similarity": 0.72},
    {"table": "leave_requests", "similarity": 0.68},
    {"table": "departments", "similarity": 0.45}
  ],
  "column_hits_per_table": {
    "employees": 3,
    "leave_requests": 5,
    "leave_types": 2
  },

  "fk_expansion_candidates": 4,
  "fk_expansion_added": 0,
  "fk_expansion_blocked": 4,

  "config": {
    "table_threshold": 0.20,
    "column_threshold": 0.18,
    "table_weight": 0.6,
    "column_weight": 0.4
  },

  "embedding_latency_ms": 45,
  "total_retrieval_latency_ms": 82
}
```

### Failure Classification

The `classifyExamFailure()` function categorizes failures into 6 types:

| Failure Type | Signal | Root Cause |
|--------------|--------|------------|
| `retrieval_miss` | Expected table not in retrieved set | Threshold too high, embedding quality |
| `join_path_miss` | 42P01 on table that should be FK-reachable | FK expansion too strict |
| `column_miss` | 42703 undefined column | Wrong column name in LLM output |
| `value_miss` | MISSING_ENTITY or HALLUCINATED_VALUE | Semantic validation failure |
| `llm_reasoning` | Other 42xxx SQL errors | LLM generated bad SQL |
| `execution_error` | Other errors | Timeout, connection, etc. |

### How to Distinguish Failure Types

```
1. RETRIEVAL MISS
   - Check: Are all expected tables in `tables_retrieved`?
   - Signal: missing_tables.length > 0
   - Fix: Lower thresholds or improve embeddings

2. JOIN PATH MISS
   - Check: Did LLM try to use a table not in retrieved set?
   - Signal: SQLSTATE 42P01 + table was a valid FK neighbor
   - Fix: Lower fkEvidenceThreshold or raise fkExpansionCap

3. COLUMN MISS
   - Check: Did LLM use wrong column name?
   - Signal: SQLSTATE 42703
   - Fix: Improve column glosses or add column candidates

4. VALUE MISS
   - Check: Did LLM reference wrong entity/value?
   - Signal: Semantic validation error
   - Fix: Improve prompt or semantic validator

5. LLM REASONING
   - Check: Tables/columns correct but SQL logic wrong?
   - Signal: Other 42xxx errors (syntax, grouping, etc.)
   - Fix: Improve prompt examples or model

6. EXECUTION ERROR
   - Check: Non-SQL error?
   - Signal: Timeout, connection failure
   - Fix: Infrastructure, not retrieval
```

---

## 3. Running the Exam

### Pre-Exam Checklist

```bash
# 1. Apply DDL migration
psql -h $DB_HOST -U $DB_USER -d enterprise_erp \
  -f enterprise-erp/migrations/001_embeddings_v2.sql

# 2. Populate embeddings (requires Python sidecar running)
cd mcp-server-nl2sql
npm run build

# Start Python sidecar in background
cd ../python-sidecar && python app.py &

# Run population
DATABASE_URL="postgresql://..." \
npx tsx scripts/populate_embeddings.ts \
  --database-id=enterprise_erp \
  --module-file=../enterprise-erp/module_mapping.json

# 3. Verify embeddings
psql -c "SELECT * FROM rag.retrieval_stats;"

# 4. Run exam
USE_SCHEMA_RAG_V2=true EXAM_MODE=true npm run exam
```

### Exam Execution

```bash
# V1 baseline (for comparison)
USE_SCHEMA_RAG_V2=false EXAM_MODE=true npm run exam > exam_v1.log 2>&1

# V2 test
USE_SCHEMA_RAG_V2=true EXAM_MODE=true npm run exam > exam_v2.log 2>&1
```

### Post-Exam Analysis

```bash
# Count failures by type
cat exam_logs/exam_retrieval_*.jsonl | \
  jq -r '.failure_type // "success"' | sort | uniq -c

# Find retrieval misses
cat exam_logs/exam_retrieval_*.jsonl | \
  jq 'select(.failure_type == "retrieval_miss") | {question, missing_tables}'

# Compare table similarities for failed questions
cat exam_logs/exam_retrieval_*.jsonl | \
  jq 'select(.failure_type == "retrieval_miss") | .table_scores | sort_by(-.similarity) | .[0:10]'
```

---

## 4. Tuning Playbook

### Tuning Order (Priority)

After first V2 exam run, tune in this order:

```
1. tableThreshold (most impactful for retrieval_miss)
2. columnThreshold (if column signals are weak)
3. fkEvidenceThreshold (if join_path_miss is common)
4. tableWeight/columnWeight (if fusion ratio is wrong)
5. fkExpansionCap (rarely needs tuning)
```

### Decision Tree

```
IF retrieval_miss rate > 30%:
  → Lower tableThreshold by 0.05 (e.g., 0.20 → 0.15)
  → Re-run exam
  → IF precision drops significantly, raise back halfway

IF retrieval_miss rate 10-30%:
  → Check column_hits_per_table for missed tables
  → IF missed tables have low column hits:
    → Lower columnThreshold by 0.02-0.03
  → IF missed tables have zero column hits:
    → Check embed_text quality for those tables

IF join_path_miss rate > 10%:
  → Lower fkEvidenceThreshold by 0.05 (e.g., 0.20 → 0.15)
  → OR raise fkExpansionCap from 3 to 4

IF column_miss rate > 15%:
  → Check column candidate accuracy
  → Improve column glosses in embed_text
  → NOT a retrieval threshold issue

IF value_miss rate > 10%:
  → Improve semantic validator patterns
  → NOT a retrieval threshold issue

IF llm_reasoning rate > 20%:
  → Improve prompt examples
  → Consider prompt escalation on retry
  → NOT a retrieval threshold issue
```

### Threshold Signals

| Signal | Interpretation |
|--------|----------------|
| Too many tables retrieved (>12 avg) | Thresholds too low |
| Missing expected tables frequently | Thresholds too high |
| FK neighbors never added | fkEvidenceThreshold too high |
| Too many irrelevant FK neighbors | fkExpansionCap too high |
| Column hits dominate (tableWeight ineffective) | Raise tableWeight to 0.7 |
| Table hits dominate (missing column signals) | Raise columnWeight to 0.5 |

### When NOT to Tune Retrieval

**Escalate to different solution if:**

1. **Retrieval is correct but SQL wrong** → Prompt engineering, not retrieval
2. **Bridge tables needed** → Add bridge-table escalation (query-time)
3. **Value/entity matching failing** → Add value RAG or entity extraction
4. **Cross-module analytics consistently fail** → May need multi-hop retrieval

---

## 5. SchemaContextPacket Consumer Compatibility

### Validator (TypeScript)

No changes needed. Validator only uses `allowedTables` array which works identically for V1/V2.

### Python Sidecar

No changes needed. SchemaContextPacket structure is identical:
- `tables[]` with `m_schema`, `gloss`, etc.
- `fk_edges[]`
- `modules[]`

The only addition is `column_candidates` in `postgres_error` for repair prompts, which Python already handles gracefully (checks if present).

### Repair Loop

Works identically. Schema context is immutable across retries (stateless repair).

---

## 6. Quick Reference

### Enable V2 for Testing

```bash
export USE_SCHEMA_RAG_V2=true
export EXAM_MODE=true
```

### Disable V2 (Rollback)

```bash
export USE_SCHEMA_RAG_V2=false
# or simply unset the variable
unset USE_SCHEMA_RAG_V2
```

### Default V2 Config

```typescript
{
  tableTopK: 15,
  tableThreshold: 0.20,
  columnTopK: 50,
  columnThreshold: 0.18,
  tableWeight: 0.6,
  columnWeight: 0.4,
  genericDownweight: 0.7,
  maxTables: 10,
  fkExpansionCap: 3,
  fkEvidenceThreshold: 0.20,
  finalMaxTables: 12,
}
```

### Override V2 Config (if needed)

Modify `DEFAULT_RETRIEVAL_CONFIG_V2` in `schema_types.ts` or pass config to `getSchemaRetrieverV2()`.
