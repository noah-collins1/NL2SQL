# Schema RAG V2 - Dual Retrieval with Score Fusion

## Overview

Schema RAG V2 improves retrieval accuracy for large databases (85+ tables) by using **dual retrieval** (tables + columns) with **score fusion**. This approach captures both high-level table relevance and specific column-level signals.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Question                                   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        1. Embed Question                                     │
│                        (Python /embed endpoint)                              │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
┌───────────────────────────┐     ┌───────────────────────────┐
│ 2a. Table Retrieval       │     │ 2b. Column Retrieval       │
│   - topK=15               │     │   - topK=50                │
│   - threshold=0.20        │     │   - threshold=0.18         │
│   - entity_type='table'   │     │   - entity_type='column'   │
└─────────────┬─────────────┘     └─────────────┬─────────────┘
              │                                 │
              │                                 ▼
              │                   ┌───────────────────────────┐
              │                   │ 3. Aggregate Column Scores │
              │                   │   per table:               │
              │                   │   colScore = top1 + 0.5*top2│
              │                   │   (generic cols: 0.7x)     │
              │                   └─────────────┬─────────────┘
              │                                 │
              └─────────────┬───────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        4. Score Fusion                                       │
│                        finalScore = 0.6*tableScore + 0.4*colScore            │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        5. Select Top 10 Tables                               │
│                        (by fused score)                                      │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        6. FK Expansion (Relevance-Gated)                     │
│                        - Only add if in evidence set (top20, score>=0.20)   │
│                        - Cap: +3 tables, max 12 total                        │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        7. Build SchemaContextPacket                          │
│                        - m_schema_compact for prompts                        │
│                        - FK edges between selected tables                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Embedding Schema (Decoupled Text Formats)

Schema RAG V2 uses **separate text formats** for vector retrieval vs LLM prompts:

1. **stable_embed_text** - Minimal, stable format for vector embeddings (retrieval)
2. **m_schema_compact** - Rich, prompt-optimized format for LLM context

This decoupling ensures that embedding vectors remain stable across prompt iterations, preventing the need to re-embed 85+ tables when prompt format changes.

### stable_embed_text (for vector embedding)

Stable, minimal text that captures core semantics without prompt-specific formatting:

**Table example:**
```
employees: Employee master data including personal info, department, and salary
Module: HR
Synonyms: staff, workers, personnel
Key columns: employee_id PK, first_name, last_name, email, department_id FK, hire_date, status
```

**Column example:**
```
employees.first_name
Type: text
Table: employees (Employee master data)
Description: Employee First Name
```

### m_schema_compact (for LLM prompts)

Dense, low-token format optimized for inclusion in LLM prompts:

```
leave_requests (leave_id bigint PK, employee_id bigint FK→employees, leave_type_id bigint FK→leave_types, start_date date, end_date date, status text, approved_by bigint FK→employees, created_at timestamptz)
```

### Legacy embed_text (V1)

The original rich semantic text is still supported for backwards compatibility:

**Table example:**
```
TABLE: public.employees
MODULE: HR
DESCRIPTION: Employee master data including personal info, department, and salary
SYNONYMS: staff, workers, personnel
COLUMNS: employee_id (bigint) [PK], first_name (text), last_name (text), email (text), department_id (bigint) [FK->public.departments.department_id, NULL], ...
RELATIONSHIPS:
- department_id -> public.departments.department_id (Department reference)
- position_id -> public.positions.position_id (Job position reference)
- manager_id -> public.employees.employee_id (Manager reference - self-referential)
```

## Configuration

### Default Parameters

```typescript
const DEFAULT_RETRIEVAL_CONFIG_V2 = {
  // Table retrieval
  tableTopK: 15,           // Max tables from pgvector
  tableThreshold: 0.20,    // Min cosine similarity for tables

  // Column retrieval
  columnTopK: 50,          // Max columns from pgvector
  columnThreshold: 0.18,   // Min cosine similarity for columns

  // Score fusion
  tableWeight: 0.6,        // Weight for table score
  columnWeight: 0.4,       // Weight for column score
  genericDownweight: 0.7,  // Multiplier for generic columns (id, status, etc.)

  // Final selection
  maxTables: 10,           // Max tables after fusion

  // FK expansion (relevance-gated)
  fkExpansionCap: 3,       // Max FK additions
  fkEvidenceThreshold: 0.20,  // Min score to be in evidence set
  fkEvidenceTopK: 20,      // Top K tables for evidence set

  // Final cap
  finalMaxTables: 12,      // Absolute max after FK expansion
}
```

## Tuning Guide

### When to Adjust Parameters

| Symptom | Likely Cause | Adjustment |
|---------|--------------|------------|
| Missing relevant tables | Thresholds too high | Lower tableThreshold to 0.15-0.18 |
| Too many irrelevant tables | Thresholds too low | Raise tableThreshold to 0.22-0.25 |
| Cross-module queries failing | Column signals weak | Increase columnWeight to 0.5, lower columnThreshold |
| FK neighbors not included | Evidence gate too strict | Lower fkEvidenceThreshold to 0.15 |
| Too many FK expansions | Cap too high | Lower fkExpansionCap to 2 |
| Generic columns dominating | Downweight too weak | Lower genericDownweight to 0.5 |

### Metrics to Track

Log these metrics for every retrieval:

```typescript
interface RetrievalMetrics {
  // Table retrieval
  table_retrieval_count: number
  table_similarities: Array<{ table: string; similarity: number }>

  // Column retrieval
  column_retrieval_count: number
  column_hits_per_table: Record<string, number>

  // Score fusion
  tables_from_table_retrieval: number
  tables_from_column_only: number

  // FK expansion
  fk_expansion_candidates: number
  fk_expansion_added: number
  fk_expansion_blocked_no_evidence: number

  // Final
  final_table_count: number
  final_tables: string[]
}
```

### A/B Testing Approach

1. **Create test question set** with known-correct table sets (50+ questions)
2. **Run retrieval with current config**, log metrics
3. **Calculate precision/recall**:
   - Precision = correct tables / retrieved tables
   - Recall = correct tables / expected tables
4. **Adjust one parameter at a time**, re-run
5. **Track F1 score** to balance precision/recall

### Example Tuning Session

```
Question: "Show employees who have pending leave requests"
Expected tables: employees, leave_requests, leave_types

Run 1 (default config):
- Table retrieval: employees(0.75), leave_requests(0.68), leave_types(0.52), departments(0.45)
- Column retrieval: leave_requests.status(0.71), employees.employee_id(0.55), ...
- Final: employees, leave_requests, leave_types, departments
- Precision: 3/4 = 75%
- Recall: 3/3 = 100%

Run 2 (raise tableThreshold to 0.50):
- Table retrieval: employees(0.75), leave_requests(0.68), leave_types(0.52)
- Final: employees, leave_requests, leave_types
- Precision: 3/3 = 100%
- Recall: 3/3 = 100%
```

## SQL Lint Validator

Before running EXPLAIN, the system performs deterministic **SQL linting** to catch common structural errors that can be fixed without wasting LLM retry attempts.

### Lint Checks

| Code | Severity | Description |
|------|----------|-------------|
| `unbalanced_parens` | error | Mismatched parentheses |
| `unclosed_quote` | error | Unclosed string literal |
| `trailing_comma_select` | error | Trailing comma in SELECT clause |
| `trailing_comma_groupby` | error | Trailing comma in GROUP BY clause |
| `trailing_comma_orderby` | error | Trailing comma in ORDER BY clause |
| `join_without_condition` | error | JOIN without ON condition |
| `undefined_alias` | error | Reference to undefined table alias |
| `aggregate_without_groupby` | warn | Aggregate function without GROUP BY |
| `non_aggregate_in_select` | warn | Non-aggregate in SELECT with GROUP BY |
| `duplicate_alias` | warn | Same alias used for multiple tables |
| `ambiguous_column` | warn | Unqualified column in multi-table query |

### Integration

```typescript
import { lintSQL, LintResult } from "./sql_lint.js"

const lintResult = lintSQL(sql)
if (lintResult.hasErrors) {
  // Skip EXPLAIN - lint errors are deterministic
  // Trigger repair with lint issues
}
```

## Join Hint Format Configuration

Join hints can be formatted in different ways depending on the query complexity. Configure via environment variable:

```bash
# Options: "edges" | "paths" | "both" | "none"
export JOIN_HINT_FORMAT="edges"
```

### Formats

**edges** (default) - Simple FK relationship list:
```
## Join Hints (FK Edges)
- employees.department_id → departments.department_id
- leave_requests.employee_id → employees.employee_id
```

**paths** - Suggested join sequences for multi-hop queries:
```
## Suggested Join Paths
- employees → leave_requests → leave_types
  ON: employees.employee_id = leave_requests.employee_id AND leave_requests.leave_type_id = leave_types.leave_type_id
```

**both** - Include both edges and paths
**none** - Omit join hints entirely

## Error-Driven Column Candidates (Table-Aware)

When EXPLAIN fails with SQLSTATE 42703 (undefined column), the system performs **table-aware** candidate search:

1. **Extract table context** from the failed SQL:
   - Parse `SELECT x.column_name FROM table AS x` to identify that `column_name` should be in `table`
   - Resolve aliases to table names

2. **Search within table scope first**:
   - If table context is known, search only that table's columns
   - Prioritize exact matches within the target table

3. **Fall back to global search** if table is unknown:
   - Group candidates by table
   - Present alternatives with table context

4. **Generate column whitelist** for repair prompt:
   - List valid columns for the target table
   - Add "YOU MUST choose from these columns only" instruction

### Example Repair Prompt (Table-Aware)

```
## Previous SQL Failed PostgreSQL Validation

**Error Code:** 42703
**Message:** column e.employee_name does not exist

**Table Context:** employees (alias: e)

**Valid Columns for 'employees':**
- employee_id (bigint) PK
- first_name (text)
- last_name (text)
- email (text)
- department_id (bigint) FK→departments

**Possible Matches:**
- employees.first_name (similar meaning - 0.85)
- employees.last_name (similar meaning - 0.82)

YOU MUST choose from the columns listed above. Do not invent column names.
```

## Execution Error Classification

The system classifies execution errors into distinct categories for proper retry gating and logging:

### Error Classes

| Class | Description | Retry? | Examples |
|-------|-------------|--------|----------|
| `infra_failure` | Connection, pool, resource errors | Never | 08xxx (connection), 53xxx (resources), 58xxx (system) |
| `query_timeout` | Query canceled by statement_timeout | Maybe | 57014 (query_canceled) |
| `validation_block` | Security/permission failures | Never | 42501 (insufficient_privilege) |
| `sql_error` | SQL syntax/semantic errors | Yes | 42601 (syntax), 42703 (undefined column) |
| `unknown` | Unclassified error | Never | Log for investigation |

### Retry Gating Logic

```typescript
const errorClassification = classifyExecutionError(sqlstate, message)

if (errorClassification.errorClass === "infra_failure") {
  // Never retry - system/connection issue
  // Don't waste attempts on infrastructure problems
  return failImmediately()
}

if (errorClassification.errorClass === "query_timeout") {
  // May retry - LLM should simplify the query
  if (attempt < maxAttempts) continue
}

if (errorClassification.errorClass === "sql_error") {
  // Retry with repair prompt
  if (attempt < maxAttempts) continue
}
```

### SQLSTATE Classification Reference

**Infrastructure (Never Retry)**
- `08xxx` - Connection exceptions (08000, 08003, 08006)
- `53xxx` - Insufficient resources (53100=disk full, 53200=OOM, 53300=too many connections)
- `54xxx` - Program limit exceeded
- `58xxx` - System errors
- `F0xxx` - Config file errors
- `XXxxx` - Internal errors

**Timeout (Conditional Retry)**
- `57014` - Query canceled (statement_timeout)
- `57P01` - Admin shutdown
- `57P02` - Crash shutdown

**SQL Errors (Retry with Repair)**
- `42601` - Syntax error
- `42P01` - Undefined table
- `42703` - Undefined column
- `42P09` - Ambiguous column
- `42804` - Datatype mismatch
- `42883` - Undefined function
- `42803` - Grouping error
- `22xxx` - Data exceptions (division by zero, etc.)

### Exam Logging

Failures are logged with structured classification for analysis:

```json
{
  "query_id": "abc123",
  "failure_type": "infra_failure",
  "error_class": "infra_failure",
  "sqlstate": "53300",
  "failure_details": "Infrastructure: Too many connections"
}
```

## Files Reference

| File | Purpose |
|------|---------|
| `mcp-server-nl2sql/src/schema_introspector.ts` | DB-agnostic schema introspection |
| `mcp-server-nl2sql/src/schema_embedder.ts` | Generate stable_embed_text + m_schema_compact |
| `mcp-server-nl2sql/src/schema_retriever_v2.ts` | Dual retrieval + score fusion |
| `mcp-server-nl2sql/src/schema_types.ts` | TypeScript types for V2 retrieval + join hints |
| `mcp-server-nl2sql/src/column_candidates.ts` | Table-aware column suggestions |
| `mcp-server-nl2sql/src/sql_lint.ts` | Deterministic SQL structural linting |
| `mcp-server-nl2sql/src/sql_autocorrect.ts` | Fuzzy column/table autocorrection |
| `mcp-server-nl2sql/src/nl_query_tool.ts` | Main orchestration with retry gating |
| `mcp-server-nl2sql/src/config.ts` | Configuration + error classification |
| `mcp-server-nl2sql/scripts/populate_embeddings.ts` | Embedding population script |
| `python-sidecar/config.py` | Prompt templates + join hint format |
| `enterprise-erp/migrations/001_embeddings_v2.sql` | DDL for new embeddings table |
| `enterprise-erp/module_mapping.json` | Table-to-module mapping |

## Setup Instructions

### 1. Run DDL Migration

```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f enterprise-erp/migrations/001_embeddings_v2.sql
```

### 2. Populate Embeddings

```bash
cd mcp-server-nl2sql
npm run build

# Start Python sidecar (required for embeddings)
cd ../python-sidecar
python app.py &

# Run population script
cd ../mcp-server-nl2sql
DATABASE_URL="postgresql://user:pass@host:5432/enterprise_erp" \
npx tsx scripts/populate_embeddings.ts \
  --database-id=enterprise_erp \
  --schemas=public \
  --module-file=../enterprise-erp/module_mapping.json \
  --batch-size=50
```

### 3. Verify Embeddings

```sql
SELECT * FROM rag.retrieval_stats;

-- Expected output:
-- database_id   | entity_type | module  | embedding_count | generic_count
-- enterprise_erp | table       | HR      | 15              | 0
-- enterprise_erp | column      | HR      | 150             | 45
-- enterprise_erp | table       | Finance | 12              | 0
-- enterprise_erp | column      | Finance | 120             | 36
-- ...
```

### 4. Test Retrieval

```typescript
import { getSchemaRetrieverV2 } from './schema_retriever_v2.js'

const retriever = getSchemaRetrieverV2(pool, logger)
const { packet, metrics } = await retriever.retrieveSchemaContext(
  "Which employees have pending leave requests?",
  "enterprise_erp"
)

console.log("Selected tables:", packet.tables.map(t => t.table_name))
console.log("Metrics:", metrics)
```

## Performance Expectations

| Metric | Target |
|--------|--------|
| Embedding latency | 30-50ms |
| Table retrieval | 5-10ms |
| Column retrieval | 10-15ms |
| Score fusion | <5ms |
| FK expansion | 5-10ms |
| Total retrieval | 50-100ms |
| Accuracy (F1) | >80% |

## Changelog

### v2.1.0 (2026-01-31)

**Task A: Decoupled Embedding Text**
- Added `generateStableTableEmbedText()` and `generateStableColumnEmbedText()` functions
- Stable format for vector embeddings is separate from prompt-optimized format
- Prevents re-embedding when prompt format changes

**Task B: SQL Lint Validator**
- Added `sql_lint.ts` with deterministic structural checks
- Catches unbalanced parens, unclosed quotes, trailing commas, JOIN without ON
- Runs before EXPLAIN to avoid wasting retries on structural issues

**Task C: Table-Aware Column Candidates**
- `column_candidates.ts` now extracts table context from failed SQL
- Resolves aliases to table names for scoped candidate search
- Generates column whitelist with "YOU MUST choose from these columns" instruction

**Task D: Join Hint Format Configuration**
- Added `JOIN_HINT_FORMAT` environment variable
- Options: "edges" (default), "paths", "both", "none"
- Filters hints to only include selected tables

**Task E: Execution Error Classification**
- Added `ExecutionErrorClass` type: infra_failure, query_timeout, validation_block, sql_error
- Retry gating: infrastructure errors fail immediately without wasting attempts
- Enhanced exam logging with `error_class` field

### v2.0.0 (2026-01-20)

- Initial dual retrieval + score fusion implementation
- Error-driven column candidates
- Relevance-gated FK expansion
