# NL2SQL MCP Server - Process Flow

> **Note:** This document describes the original MCPtest architecture. For current status with Enterprise ERP database and Schema RAG, see **`STATUS.md`**.

---

## End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                  │
│                                                                             │
│   LibreChat UI                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  User types: "What company had the highest revenue in 2020?"        │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ 1. User sends natural language question
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LIBRECHAT BACKEND                                  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  Claude/GPT receives message, sees MCP tools available              │  │
│   │  Decides to call: nl_query({ question: "What company..." })         │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ 2. MCP tool call via stdio
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TYPESCRIPT MCP SERVER                                   │
│                      (mcp-server-nl2sql)                                    │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  index.ts: Receives nl_query tool call                              │  │
│   │  ├── Extracts: question, max_rows, timeout, trace options           │  │
│   │  └── Calls: executeNLQuery(input, context)                          │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                   │                                         │
│                                   ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  nl_query_tool.ts: Main orchestration layer                         │  │
│   │  ├── Generates UUID for query tracking                              │  │
│   │  ├── Starts bounded repair loop (max 3 attempts)                    │  │
│   │  └── Coordinates: Python → Validator → EXPLAIN → Execute            │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ 3. HTTP POST /generate_sql
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PYTHON SIDECAR                                       │
│                         (FastAPI @ localhost:8001)                          │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  app.py: Receives generation request                                │  │
│   │                                                                     │  │
│   │  Stage 1: Keyword Filtering                                         │  │
│   │  ├── Extract keywords from question                                 │  │
│   │  ├── Match against table/column names                               │  │
│   │  └── Select relevant tables for prompt                              │  │
│   │                                                                     │  │
│   │  Stage 2: Prompt Composition                                        │  │
│   │  ├── Load HRIDA_BASE_PROMPT (versioned)                             │  │
│   │  ├── Inject filtered schema (tables, columns, types)                │  │
│   │  ├── Add question and constraints                                   │  │
│   │  └── If repair: append delta block with error context               │  │
│   │                                                                     │  │
│   │  Stage 3: Semantic Validation (Post-Generation)                     │  │
│   │  ├── Extract entities from question (company names, states, years)  │  │
│   │  ├── Verify entities appear in generated SQL                        │  │
│   │  ├── Detect hallucinated values not in question                     │  │
│   │  └── Auto-repair if semantic issues found (1 attempt)               │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ 4. Ollama API call
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OLLAMA                                          │
│                              (localhost:11434)                              │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  Model: HridaAI/hrida-t2sql:latest                                  │  │
│   │  Temperature: 0.0 (deterministic)                                   │  │
│   │                                                                     │  │
│   │  Input: Composed prompt with schema + question                      │  │
│   │  Output: Raw SQL query                                              │  │
│   │                                                                     │  │
│   │  Example Output:                                                    │  │
│   │  SELECT c.name, r.revenue_millions                                  │  │
│   │  FROM companies c                                                   │  │
│   │  JOIN company_revenue_annual r ON c.company_id = r.company_id       │  │
│   │  WHERE r.year = 2020                                                │  │
│   │  ORDER BY r.revenue_millions DESC                                   │  │
│   │  LIMIT 1;                                                           │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ 5. SQL + confidence returned
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TYPESCRIPT MCP SERVER (continued)                       │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  sql_validator.ts: Structural Validation                            │  │
│   │                                                                     │  │
│   │  State Machine Tokenizer:                                           │  │
│   │  ├── Tokenize SQL (handles strings, comments, dollar-quotes)        │  │
│   │  └── Separate code from literals safely                             │  │
│   │                                                                     │  │
│   │  Validation Rules:                                                  │  │
│   │  ├── NO_SELECT: Must start with SELECT                              │  │
│   │  ├── MULTIPLE_STATEMENTS: Only one statement allowed                │  │
│   │  ├── DANGEROUS_KEYWORD: Block DROP, INSERT, UPDATE, DELETE, etc.   │  │
│   │  ├── DANGEROUS_FUNCTION: Block pg_read_file, pg_sleep, etc.        │  │
│   │  ├── UNKNOWN_TABLE: Must use allowed tables only                    │  │
│   │  └── MISSING_LIMIT: Auto-add LIMIT if missing                       │  │
│   │                                                                     │  │
│   │  Actions:                                                           │  │
│   │  ├── fail_fast: Security violation → reject immediately            │  │
│   │  ├── rewrite: Send back to Python for repair                        │  │
│   │  └── auto_fix: Fix automatically (e.g., add LIMIT)                  │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                   │                                         │
│                          ┌────────┴────────┐                                │
│                          │ Validation OK?  │                                │
│                          └────────┬────────┘                                │
│                       No (rewrite)│         Yes                             │
│                    ┌──────────────┼──────────────┐                          │
│                    ▼              │              ▼                          │
│   ┌────────────────────┐         │    ┌─────────────────────────────────┐  │
│   │ Repair Loop        │         │    │ EXPLAIN-First Safety Check      │  │
│   │ ├── Send to Python │         │    │                                 │  │
│   │ │   /repair_sql    │         │    │ EXPLAIN (FORMAT JSON) <sql>     │  │
│   │ ├── Include error  │         │    │ ├── Catches syntax errors       │  │
│   │ │   context        │         │    │ ├── Catches undefined tables    │  │
│   │ └── Max 3 attempts │         │    │ ├── Catches type mismatches     │  │
│   └────────────────────┘         │    │ └── No actual execution         │  │
│            │                     │    └─────────────────────────────────┘  │
│            └─────────────────────┘                  │                       │
│                                            ┌────────┴────────┐              │
│                                            │ EXPLAIN OK?     │              │
│                                            └────────┬────────┘              │
│                                         No          │        Yes            │
│                                   ┌─────────────────┼─────────────────┐     │
│                                   ▼                 │                 ▼     │
│                    ┌────────────────────┐          │    ┌──────────────┐   │
│                    │ Check SQLSTATE     │          │    │ Execute SQL  │   │
│                    │ ├── Fail-fast?     │          │    │ on Postgres  │   │
│                    │ │   → Return error │          │    └──────────────┘   │
│                    │ └── Repairable?    │          │           │           │
│                    │     → Retry loop   │          │           ▼           │
│                    └────────────────────┘          │    ┌──────────────┐   │
│                                                    │    │ Return rows  │   │
│                                                    │    │ + metadata   │   │
│                                                    │    └──────────────┘   │
└────────────────────────────────────────────────────┼────────────────────────┘
                                                     │
                                                     │ 6. Query execution
                                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POSTGRESQL                                         │
│                           (MCPtest Database)                                │
│                                                                             │
│   Connection: postgresql://mcptest:***@172.28.91.130:5432/mcptest          │
│   Role: read (SELECT only)                                                  │
│                                                                             │
│   Tables:                                                                   │
│   ├── companies (company_id, name, founding_year, state)                   │
│   └── company_revenue_annual (company_id, year, revenue_millions)          │
│                                                                             │
│   Security Layers:                                                          │
│   ├── Database role: SELECT-only permissions                               │
│   ├── Statement timeout: Prevents long-running queries                     │
│   └── Read-only transaction: Extra safety                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Step-by-Step Flow

### Step 1: User Input (LibreChat)

```
User → LibreChat UI → "What company had the highest revenue in 2020?"
```

LibreChat displays the message and sends it to the configured LLM (Claude/GPT) along with available MCP tools.

### Step 2: LLM Tool Selection

The LLM sees the `nl_query` tool available and decides to use it:

```json
{
  "tool": "nl_query",
  "arguments": {
    "question": "What company had the highest revenue in 2020?",
    "max_rows": 100,
    "trace": false
  }
}
```

### Step 3: MCP Server Receives Call

**File:** `index.ts:428-530`

The TypeScript MCP server receives the tool call via stdio and:
1. Extracts input parameters
2. Creates database connection pool
3. Calls `executeNLQuery()`

### Step 4: Orchestration Layer

**File:** `nl_query_tool.ts:59-593`

The main orchestration function:

```typescript
async function executeNLQuery(input, context) {
  const queryId = uuidv4()  // Track this query

  // Bounded repair loop (max 3 attempts)
  while (attempt < maxAttempts) {
    // Step 4a: Call Python sidecar
    // Step 4b: Validate SQL
    // Step 4c: EXPLAIN check
    // Step 4d: Execute if all passes
  }
}
```

### Step 5: Python Sidecar - SQL Generation

**Endpoint:** `POST http://localhost:8001/generate_sql`

**Request:**
```json
{
  "question": "What company had the highest revenue in 2020?",
  "database_id": "mcptest",
  "max_rows": 100,
  "trace": false
}
```

**Processing:**
1. **Keyword Filter:** Extract "company", "revenue", "2020" → select relevant tables
2. **Prompt Build:** Compose prompt with schema + question
3. **Ollama Call:** Send to HridaAI model (temp=0.0)
4. **Semantic Check:** Verify SQL matches question intent
5. **Auto-Repair:** Fix semantic issues if found

**Response:**
```json
{
  "query_id": "abc-123",
  "sql_generated": "SELECT c.name, r.revenue_millions FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE r.year = 2020 ORDER BY r.revenue_millions DESC LIMIT 1;",
  "confidence_score": 0.95,
  "tables_selected": ["companies", "company_revenue_annual"],
  "tables_used_in_sql": ["companies", "company_revenue_annual"],
  "notes": null
}
```

### Step 6: Structural Validation

**File:** `sql_validator.ts`

The validator uses a state machine tokenizer to safely parse SQL:

```
Input: SELECT c.name FROM companies c WHERE state = 'CA; DROP TABLE'

Tokenization:
├── NORMAL: "SELECT c.name FROM companies c WHERE state = "
├── SINGLE_QUOTE: "'CA; DROP TABLE'"  ← semicolon is INSIDE string, safe
└── NORMAL: ""

Result: 1 statement, no dangerous keywords in code → PASS
```

**Validation Checks:**
| Check | Result | Action |
|-------|--------|--------|
| Starts with SELECT? | ✅ | Continue |
| Multiple statements? | ✅ No | Continue |
| Dangerous keywords? | ✅ None | Continue |
| Dangerous functions? | ✅ None | Continue |
| Unknown tables? | ✅ All allowed | Continue |
| Has LIMIT? | ⚠️ No | Auto-fix: add LIMIT 1000 |

### Step 7: EXPLAIN Safety Check

Before executing, run EXPLAIN to catch errors safely:

```sql
SET statement_timeout = 2000;  -- 2 second timeout
EXPLAIN (FORMAT JSON) SELECT c.name, r.revenue_millions ...
```

**Possible Outcomes:**
- ✅ Success → Safe to execute
- ❌ Syntax error (42601) → Retry with repair
- ❌ Undefined column (42703) → Retry with repair
- ❌ Permission denied (42501) → Fail fast, no retry

### Step 8: Query Execution

```sql
SET statement_timeout = 30000;  -- 30 second timeout
SELECT c.name, r.revenue_millions
FROM companies c
JOIN company_revenue_annual r ON c.company_id = r.company_id
WHERE r.year = 2020
ORDER BY r.revenue_millions DESC
LIMIT 1;
```

**Result:**
```json
[
  { "name": "Apex Industries", "revenue_millions": 9850 }
]
```

### Step 9: Response to LibreChat

The MCP server formats and returns the response:

```
Query: What company had the highest revenue in 2020?

SQL Generated:
SELECT c.name, r.revenue_millions
FROM companies c
JOIN company_revenue_annual r ON c.company_id = r.company_id
WHERE r.year = 2020
ORDER BY r.revenue_millions DESC
LIMIT 1;

Results (1 rows):
[
  { "name": "Apex Industries", "revenue_millions": 9850 }
]

Confidence: 95.0%
Execution Time: 45ms
```

### Step 10: User Sees Result

LibreChat displays the formatted response to the user.

---

## Repair Loop Flow

When validation or EXPLAIN fails with a repairable error:

```
┌──────────────────────────────────────────────────────────────────┐
│                        REPAIR LOOP                                │
│                        (Max 3 Attempts)                          │
└──────────────────────────────────────────────────────────────────┘

Attempt 1: Generate SQL
    │
    ├── Validation Error: UNKNOWN_TABLE (uses "customers" not "companies")
    │
    ▼
Attempt 2: Repair SQL (POST /repair_sql)
    │
    │   Request includes:
    │   ├── Original question
    │   ├── Previous SQL that failed
    │   ├── Validator issues: [{code: "UNKNOWN_TABLE", ...}]
    │   └── Attempt: 2
    │
    │   Python builds repair prompt:
    │   ├── Base prompt (same as before)
    │   └── Delta block: "Fix: Use 'companies' table, not 'customers'"
    │
    ├── EXPLAIN Error: 42703 (column "email" does not exist)
    │
    ▼
Attempt 3: Repair SQL again
    │
    │   Request includes:
    │   ├── Postgres error: {sqlstate: "42703", message: "column email..."}
    │   └── Attempt: 3
    │
    │   Python builds repair prompt:
    │   └── Delta block: "PostgreSQL Error: column 'email' does not exist"
    │
    ├── ✅ EXPLAIN passes
    ├── ✅ Execute succeeds
    │
    ▼
Return results with note: "[Repaired after 3 attempts]"
```

---

## Error Classification

### Fail-Fast Errors (No Retry)

| SQLSTATE | Meaning | Why No Retry |
|----------|---------|--------------|
| 08xxx | Connection error | Infrastructure issue |
| 42501 | Permission denied | Security - user lacks access |
| 53xxx | Resource exhausted | System capacity |
| 58xxx | System error | Database issue |

### Repairable Errors (Retry with Feedback)

| SQLSTATE | Meaning | Repair Strategy |
|----------|---------|-----------------|
| 42601 | Syntax error | Fix based on error position |
| 42P01 | Undefined table | Use allowed table name |
| 42703 | Undefined column | Check schema for correct column |
| 42804 | Type mismatch | Fix comparison types |

---

## Security Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                     SECURITY ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: Python Semantic Validation                            │
│  ├── Entity extraction and matching                             │
│  ├── Hallucination detection                                    │
│  └── Intent classification                                      │
│                                                                 │
│  Layer 2: TypeScript Structural Validation                      │
│  ├── SELECT-only enforcement                                    │
│  ├── Single statement check                                     │
│  ├── Dangerous keyword blocking                                 │
│  ├── Dangerous function blocking                                │
│  ├── Table allowlist enforcement                                │
│  └── LIMIT auto-injection                                       │
│                                                                 │
│  Layer 3: PostgreSQL EXPLAIN                                    │
│  ├── Catches runtime errors safely                              │
│  ├── No actual data access                                      │
│  └── 2-second timeout                                           │
│                                                                 │
│  Layer 4: Database Role                                          │
│  ├── User: mcptest (SELECT only)                                │
│  ├── No INSERT/UPDATE/DELETE permissions                        │
│  └── Schema-scoped access                                       │
│                                                                 │
│  Layer 5: Transaction Safety                                     │
│  ├── BEGIN TRANSACTION READ ONLY                                │
│  ├── Statement timeout enforcement                              │
│  └── Automatic rollback on error                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Summary

| Component | Location | Port | Purpose |
|-----------|----------|------|---------|
| LibreChat | ~/LibreChat-Local | 3080 | User interface |
| TypeScript MCP | ~/nl2sql-project/mcp-server-nl2sql | stdio | Tool registration, validation, orchestration |
| Python Sidecar | ~/nl2sql-project/python-sidecar | 8001 | SQL generation, semantic validation |
| Ollama | localhost | 11434 | HridaAI model inference |
| PostgreSQL | 172.28.91.130 | 5432 | Database (MCPtest) |

---

## Latency Breakdown (Typical)

| Stage | Target | Actual (P50) |
|-------|--------|--------------|
| Python → Ollama | <5000ms | ~600ms |
| TypeScript Validation | <50ms | ~5ms |
| EXPLAIN Check | <100ms | ~20ms |
| Query Execution | <500ms | ~50ms |
| **Total** | **<6000ms** | **~750ms** |

---

## Files Reference

```
nl2sql-project/
├── mcp-server-nl2sql/
│   └── src/
│       ├── index.ts           # MCP server, tool registration
│       ├── nl_query_tool.ts   # Main orchestration, repair loop
│       ├── sql_validator.ts   # State machine tokenizer, validation
│       ├── python_client.ts   # HTTP client to Python sidecar
│       └── config.ts          # Types, constants, error classification
│
├── python-sidecar/
│   ├── app.py                 # FastAPI endpoints
│   ├── hrida_client.py        # Ollama API client
│   ├── keyword_filter.py      # Stage 1 table selection
│   ├── semantic_validator.py  # Entity extraction, intent matching
│   └── config.py              # Prompts, schema
│
└── STATUS.md                  # Project status
```
