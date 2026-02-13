# TypeScript MCP Server: Validation and RAG Process

**Last Updated:** 2026-02-01
**Current Accuracy:** 56.7% (34/60 on Enterprise ERP)
**Purpose:** Technical documentation of the validation pipeline to identify accuracy bottlenecks

---

## Executive Summary

The TypeScript MCP server implements a multi-stage pipeline:
1. **Schema RAG** - Retrieve relevant tables via vector similarity
2. **SQL Generation** - Python sidecar calls Hrida LLM with retrieved schema
3. **Validation Loop** - TypeScript validates + repairs SQL up to 3 times
4. **Execution** - Run validated SQL against PostgreSQL

**Key Hypothesis:** The current architecture has fundamental limitations that cap accuracy at ~56%. This document details each component to identify culprits.

---

## Architecture Overview

```
Question
    │
    ▼
┌───────────────────────────────────────────────────────────────────┐
│  STAGE 1: Schema RAG (schema_retriever.ts)                        │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  1. Embed question via Python sidecar (nomic-embed-text)    │  │
│  │  2. Query pgvector for top-K similar tables (threshold 0.25)│  │
│  │  3. FK expansion: add related tables (capped for hubs)      │  │
│  │  4. Build SchemaContextPacket with M-Schema format          │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────────┘
                               │ SchemaContextPacket
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│  STAGE 2: SQL Generation (python_client.ts → Python sidecar)      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  1. Build prompt: question + M-Schema + FK edges            │  │
│  │  2. Call Ollama (HridaAI/hrida-t2sql, temp=0.0)             │  │
│  │  3. Extract SQL from response                               │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬────────────────────────────────────┘
                               │ Generated SQL
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│  STAGE 3: Validation Loop (nl_query_tool.ts)                      │
│                                                                   │
│  ┌─── Attempt 1..3 ────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  3a. STRUCTURAL VALIDATION (sql_validator.ts)               │  │
│  │      - Must start with SELECT                               │  │
│  │      - No dangerous keywords (DROP, DELETE, etc.)           │  │
│  │      - No dangerous functions (pg_read_file, etc.)          │  │
│  │      - Table allowlist enforcement                          │  │
│  │      - Auto-add LIMIT if missing                            │  │
│  │                                                             │  │
│  │  3b. SQL LINT (sql_lint.ts)                                 │  │
│  │      - Deterministic syntax pattern checks                  │  │
│  │      - Common mistakes detection                            │  │
│  │                                                             │  │
│  │  3c. EXPLAIN CHECK                                          │  │
│  │      - Run EXPLAIN (FORMAT JSON) on PostgreSQL              │  │
│  │      - Catches: undefined table (42P01), undefined column   │  │
│  │        (42703), syntax errors (42601), type mismatches      │  │
│  │                                                             │  │
│  │  3d. AUTOCORRECT (sql_autocorrect.ts)                       │  │
│  │      - Attempt deterministic fixes for 42703/42P01          │  │
│  │      - Case mismatch, fuzzy column name match               │  │
│  │                                                             │  │
│  │  3e. MINIMAL WHITELIST REPAIR (column_candidates.ts)        │  │
│  │      - For 42703: extract alias.column from error           │  │
│  │      - Resolve alias → table using FROM/JOIN analysis       │  │
│  │      - Build whitelist: that table + 1-hop FK neighbors     │  │
│  │      - Send targeted repair prompt to Python sidecar        │  │
│  │                                                             │  │
│  └─── If error and attempts remain → loop ─────────────────────┘  │
│                                                                   │
└──────────────────────────────┬────────────────────────────────────┘
                               │ Valid SQL
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│  STAGE 4: Execute Query                                           │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  1. Set statement_timeout                                   │  │
│  │  2. Execute SQL                                             │  │
│  │  3. Return rows + metadata                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

---

## Stage 1: Schema RAG (`schema_retriever.ts`)

### Process

1. **Embed Question**
   - Call Python sidecar `/embed` endpoint
   - Uses `nomic-embed-text` model (768 dimensions)

2. **Vector Similarity Search**
   ```sql
   SELECT table_name, table_schema, module, table_gloss, fk_degree, is_hub,
          1 - (embedding <=> $1::vector) AS similarity
   FROM rag.schema_embeddings
   WHERE entity_type = 'table'
     AND 1 - (embedding <=> $1::vector) >= 0.25
   ORDER BY embedding <=> $1::vector
   LIMIT 15
   ```

3. **FK Expansion**
   - For each retrieved table (sorted by similarity, top 3)
   - Query `rag.schema_fks` for related tables
   - **Hub table capping**: Tables with >8 FK relationships limited to 5 expansions
   - Decay factor: FK-expanded tables get `similarity * 0.8`

4. **Build SchemaContextPacket**
   - Fetch column metadata from `rag.schema_columns`
   - Render M-Schema format: `table_name (col1 TYPE PK, col2 TYPE FK→other_table, ...)`
   - Collect FK edges between selected tables

### Configuration

```typescript
DEFAULT_RETRIEVAL_CONFIG = {
    topK: 15,           // Max tables from vector search
    threshold: 0.25,    // Min similarity
    maxTables: 10,      // Final cap after expansion
    fkExpansionLimit: 3,// FK expansions to process
    hubFKCap: 5,        // Max expansions for hub tables
    fkMinSimilarity: 0.20
}
```

### Potential Issues (Accuracy Impact)

| Issue | Impact | Evidence |
|-------|--------|----------|
| **Threshold too high** | Misses relevant tables with similarity 0.20-0.25 | `retrieval_miss` failures in exam logs |
| **Embedding quality** | nomic-embed-text may not capture SQL semantics well | Different phrasing of same question yields different tables |
| **FK expansion blind spots** | Some join paths require 2+ hops not covered | `join_path_miss` failures |
| **Hub table capping** | Critical hub tables (employees, customers) may be under-represented | Questions about employees fail retrieval |

---

## Stage 2: SQL Generation (Python Sidecar)

### Prompt Construction

```python
# Simplified prompt structure
"""
### Task
Generate SQL for: {question}

### Database: enterprise_erp
### Available Tables
{m_schema_blocks}

### Relationships
{fk_edges}

### Rules
- Use ONLY tables listed above
- Do not invent columns
- Add LIMIT

### SQL
"""
```

### Model

- **Model**: `HridaAI/hrida-t2sql:latest`
- **Temperature**: 0.0 (deterministic)
- **Timeout**: 60 seconds

### Potential Issues (Accuracy Impact)

| Issue | Impact | Evidence |
|-------|--------|----------|
| **LLM invents columns** | 20% of failures are `column_miss` | Exam logs show LLM using `employee_name` when column is `first_name || last_name` |
| **LLM ignores M-Schema** | Generates SQL using column names not in context | Hard questions fail despite correct table retrieval |
| **Complex joins confuse LLM** | Multi-table JOINs (4+) have low success | Hard questions: 13.3% success vs Easy: 95% |
| **No example SQL** | LLM has no reference for correct patterns | Same semantic errors repeat across questions |

---

## Stage 3: Validation Loop (`nl_query_tool.ts`)

### Structural Validation (`sql_validator.ts`)

Uses a **state machine tokenizer** to correctly handle:
- Single/double quoted strings with escaping
- Dollar-quoted strings (`$tag$...$tag$`)
- Line comments (`--`) and block comments (`/* */`)

**Checks performed:**
1. Must start with SELECT (no DML/DDL)
2. Single statement only
3. No dangerous keywords (`DROP`, `DELETE`, `INSERT`, `UPDATE`, etc.)
4. No dangerous functions (`pg_read_file`, `pg_sleep`, `dblink`, etc.)
5. Table allowlist (only tables from RAG retrieval)
6. Auto-add `LIMIT 1000` if missing

### SQL Lint (`sql_lint.ts`)

**Deterministic pattern checks:**
- Unclosed quotes
- Unbalanced parentheses
- Missing JOIN conditions (Cartesian product detection)
- Invalid aggregate usage
- Common syntax mistakes

### EXPLAIN Check

Runs `EXPLAIN (FORMAT JSON)` to validate SQL structure:
- **42P01**: Undefined table → triggers repair
- **42703**: Undefined column → triggers minimal whitelist repair
- **42601**: Syntax error → triggers repair
- **42804**: Type mismatch → triggers repair

### Minimal Whitelist Repair (`column_candidates.ts`)

**For 42703 (undefined column) errors:**

1. **Extract alias.column from error**
   ```typescript
   // Error: column "p.project_name" does not exist
   extractAliasColumnFromError(error) → { alias: "p", column: "project_name" }
   ```

2. **Resolve alias to table**
   ```typescript
   // SQL: SELECT p.project_name FROM projects p
   resolveAliasToTable(sql, "p") → "projects"
   ```

3. **Build minimal whitelist**
   - Include ONLY the resolved table's columns
   - Include 1-hop FK neighbor tables' columns
   - This is MUCH smaller than full schema context

4. **Format for repair prompt**
   ```
   ## Column Whitelist for `projects`
   Use only these exact column names:
     project_id, name, status, start_date, end_date, ...

   If you need a column not listed above, you may JOIN these related tables:
     **project_resources:** project_resource_id, project_id, employee_id, ...
     **project_budgets:** budget_id, project_id, amount, ...

   **Rules:**
   - Do not invent columns.
   - If a concept is not available, join a table that has it.
   ```

### Repair Loop Configuration

```typescript
REPAIR_CONFIG = {
    maxAttempts: 3,
    confidencePenaltyPerAttempt: 0.1,
    explainTimeout: 5000,  // 5 seconds for EXPLAIN
}
```

### Error Classification

| Error Class | SQLSTATEs | Action |
|-------------|-----------|--------|
| `infra_failure` | 08xxx, 53xxx | Fail immediately, don't retry |
| `validation_block` | 42501 (permission) | Fail immediately |
| `query_timeout` | 57014 | May retry with simpler query |
| `sql_error` | 42xxx (except 42501) | Retry with error context |

### Potential Issues (Accuracy Impact)

| Issue | Impact | Evidence |
|-------|--------|----------|
| **Max 3 attempts insufficient** | Some errors need 4+ repairs | Exam logs show "max attempts reached" |
| **Repair prompt too verbose** | LLM gets confused by too much context | Repair sometimes makes SQL worse |
| **Minimal whitelist doesn't catch all cases** | Unqualified column references missed | Some 42703 errors don't trigger whitelist |
| **Autocorrect too conservative** | Only fixes exact case mismatches | Fuzzy matches often skipped |
| **Pre-execution validation DISABLED** | False positives caused it to be turned off | Line 431: `PRE_EXECUTION_VALIDATION_ENABLED = false` |

---

## Failure Taxonomy

Based on exam results (60 questions):

| Failure Type | Count | Percentage | Root Cause |
|--------------|-------|------------|------------|
| **column_miss** | 12 | 20.0% | LLM invents column names not in schema |
| **execution_error** | 3 | 5.0% | SQL errors not caught by validation |
| **llm_reasoning** | varies | varies | Wrong logic, wrong tables joined |
| **join_path_miss** | varies | varies | Multi-hop joins not retrievable |
| **retrieval_miss** | varies | varies | Correct tables not in top-K |

### Difficulty Breakdown

| Difficulty | Success Rate | Main Issues |
|------------|--------------|-------------|
| Easy (20) | 95.0% | Simple single-table queries work well |
| Medium (25) | 52.0% | 2-3 table joins start failing |
| Hard (15) | 13.3% | Complex aggregations, 4+ tables fail |

---

## Identified Bottlenecks

### 1. Column Hallucination (20% of failures)

**Problem**: The LLM generates column names that don't exist, even when the correct column is in the M-Schema.

**Examples:**
- Uses `employee_name` instead of `first_name || ' ' || last_name`
- Uses `project_status` instead of `status`
- Uses `amount_total` instead of `total_amount`

**Why it happens:**
- M-Schema format may not be explicit enough
- LLM training data has different column naming conventions
- Repair whitelist only triggers AFTER EXPLAIN fails

**Potential fixes:**
1. Add explicit column renaming hints to prompt
2. Pre-validate column names BEFORE sending to LLM
3. Train custom NL2SQL model on enterprise schema

### 2. Complex Join Failures (Hard questions: 13.3%)

**Problem**: Questions requiring 3+ table JOINs or complex aggregations fail.

**Examples:**
- "Generate trial balance for current period" (5 tables needed)
- "Show project profitability: budget vs actual" (4 tables)
- "Employee training completion rates by department" (4 tables)

**Why it happens:**
- FK expansion limited to 1 hop
- M-Schema doesn't show multi-hop join paths
- LLM struggles to compose complex SQL

**Potential fixes:**
1. Add multi-hop join path suggestions to prompt
2. Increase FK expansion depth for specific question patterns
3. Break complex questions into sub-queries

### 3. V2 Retriever Regression

**Problem**: V2 dual retrieval (table + column embedding) caused regression from 53% to 37%.

**Why it was disabled:**
- Column similarity scores created noise
- Score fusion weights (0.6 table + 0.4 column) not optimal
- FK gating blocked valid expansions

**Status**: V2 disabled, using V1 only

### 4. Embedding Quality Variance

**Problem**: Embedding quality varies by module/domain.

**Evidence from regression analysis:**
- HR module: 71% → 57% (regression)
- Projects module: 33% → 83% (improvement)

**Root cause**: `nomic-embed-text` general-purpose embeddings don't capture database-specific semantics.

---

## Recommendations for Brainstorming

### Near-term (without model changes)

1. **Enable pre-execution column validation (carefully)**
   - Currently disabled due to false positives
   - Could add conservative mode that only flags exact mismatches

2. **Expand minimal whitelist to 2-hop FK neighbors**
   - Current: 1-hop
   - More context for LLM to find correct join path

3. **Add column synonym mapping**
   - Map common LLM outputs to actual column names
   - e.g., `employee_name → first_name || ' ' || last_name`

4. **Increase max repair attempts for hard questions**
   - Currently: 3 for all
   - Could increase to 5 for questions detected as complex

### Medium-term (requires more work)

5. **Fine-tune embedding model**
   - Create enterprise-specific training data
   - Include column descriptions, business glossary

6. **Add few-shot examples to prompt**
   - Include 2-3 example question→SQL pairs
   - Match by question similarity

7. **Implement query decomposition**
   - Break complex questions into sub-queries
   - Combine results

### Long-term

8. **Train custom NL2SQL model on enterprise data**
   - Use Hrida as base
   - Fine-tune on enterprise ERP question/SQL pairs

9. **Implement semantic validation**
   - Check that SQL result matches question intent
   - Use LLM to verify answers

---

## Key Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `schema_retriever.ts` | 542 | V1 Schema RAG retrieval |
| `schema_retriever_v2.ts` | - | V2 dual retrieval (DISABLED) |
| `sql_validator.ts` | 703 | Structural validation, state machine tokenizer |
| `sql_lint.ts` | - | Deterministic syntax checks |
| `sql_autocorrect.ts` | - | Deterministic error fixes |
| `column_candidates.ts` | 1137 | Column candidate finding, minimal whitelist |
| `nl_query_tool.ts` | 1731 | Main orchestration, repair loop |
| `schema_types.ts` | 589 | Type definitions, M-Schema rendering |

---

## How to Debug Failures

### 1. Run exam with detailed logging

```bash
cd mcp-server-nl2sql
EXAM_MODE=true npx tsx scripts/run_exam.ts
```

### 2. Check exam JSONL logs

```bash
cat exam_logs/exam_retrieval_$(date +%Y-%m-%d).jsonl | jq -r 'select(.execution_success == false) | "\(.question)\n  failure: \(.failure_type)\n  tables: \(.tables_retrieved | join(", "))\n"'
```

### 3. Trace single question

```typescript
// In nl_query_tool.ts, set trace: true
const result = await executeNLQuery({
    question: "Your test question",
    trace: true
}, context);
console.log(JSON.stringify(result.trace, null, 2));
```

---

## Appendix: Error SQLSTATE Reference

| SQLSTATE | Meaning | Repair Strategy |
|----------|---------|-----------------|
| 42601 | Syntax error | Generic repair with error message |
| 42703 | Undefined column | **Minimal whitelist repair** |
| 42P01 | Undefined table | Use correct table from schema |
| 42804 | Type mismatch | Fix comparison types |
| 42501 | Permission denied | **Fail immediately** |
| 08xxx | Connection error | **Fail immediately** |
| 53xxx | Resource error | **Fail immediately** |
| 57014 | Query timeout | Retry with simpler query |
