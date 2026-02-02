# NL2SQL MCP Server - TypeScript Layer

**Last Updated:** 2026-02-02

## Overview

TypeScript MCP server that converts natural language to SQL. Handles schema retrieval, parallel multi-candidate SQL generation, validation, repair loops, and execution.

**Database:** Enterprise ERP (60+ tables, 8 modules)
**Current Success Rate:** 75.0% (Easy: 95%, Medium: 72%, Hard: 53%)

## Architecture

```
User Question
     │
     ▼
┌─────────────────────────────────────┐
│  nl_query_tool.ts                   │
│  ├─ Schema RAG (V1 retriever)       │
│  ├─ HTTP POST to Python sidecar     │
│  │   └─ Multi-Candidate Generation  │
│  ├─ Candidate Evaluation & Selection│
│  │   ├─ Structural Validation       │
│  │   ├─ Lint Analysis               │
│  │   ├─ Parallel EXPLAIN            │
│  │   └─ Deterministic Scoring       │
│  ├─ Repair Loop (max 3 attempts)    │
│  │   └─ Minimal Whitelist (42703)   │
│  └─ Execute + Return Results        │
└─────────────────────────────────────┘
```

## Source Files

### Core Pipeline

| File | Purpose |
|------|---------|
| `index.ts` | MCP server entry, tool registration |
| `nl_query_tool.ts` | Main orchestration (generate → validate → repair → execute) |
| `config.ts` | Types, constants, error classification |
| `python_client.ts` | HTTP client to Python sidecar |
| `multi_candidate.ts` | **NEW** Multi-candidate generation, parsing, scoring, selection |

### Schema RAG

| File | Purpose |
|------|---------|
| `schema_retriever.ts` | **V1 retriever (ACTIVE)** - pgvector similarity search |
| `schema_retriever_v2.ts` | V2 dual retrieval (NOT IN USE - caused errors) |
| `schema_embedder.ts` | Embedding generation via Python sidecar |
| `schema_introspector.ts` | Database introspection |
| `schema_types.ts` | Schema type definitions, M-Schema format |

### SQL Validation

| File | Purpose |
|------|---------|
| `sql_validator.ts` | Core validation (SELECT-only, dangerous keywords, tables) |
| `sql_lint.ts` | SQL linting (syntax patterns, common errors) |
| `sql_autocorrect.ts` | Automatic SQL fixes (aliases, quotes) |
| `column_candidates.ts` | **Minimal whitelist repair** for 42703 errors |

## Key Features

### Schema RAG V1 (Active)

Retrieves relevant tables for each question:
1. Embed question via Python sidecar
2. Query pgvector for similar table descriptions
3. Expand via FK relationships
4. Build SchemaContextPacket with M-Schema format

### Minimal Whitelist Repair

For SQLSTATE 42703 (undefined column) errors:
1. Extract failing `alias.column` from error message
2. Resolve alias to table using FROM/JOIN analysis
3. Build whitelist with ONLY that table's columns + 1-hop FK neighbors
4. Send targeted repair prompt to Python sidecar

```typescript
// column_candidates.ts
buildMinimalWhitelist(errorMessage, sql, schemaContext)
// Returns: { resolvedTable, whitelist: { table: [columns] } }
```

### Parallel Multi-Candidate SQL Generation

Generates K SQL candidates in **parallel** and selects the best one using deterministic scoring.

**Key Files:**
- `multi_candidate.ts` - Scoring, evaluation, selection logic
- `nl_query_tool.ts` - Integration with main pipeline
- `python-sidecar/hrida_client.py` - Async parallel generation
- `python-sidecar/app.py` - Candidate orchestration

**Architecture:**
```
Question → Python Sidecar → K Parallel LLM Calls → Deduplicate → Return List
                              (temp=0.3)
         ← sql_candidates[] ←

TypeScript → Evaluate Each → Score → Select Best → Execute/Repair
```

**Configuration (`MULTI_CANDIDATE_CONFIG`):**
```typescript
{
  enabled: true,                    // Toggle on/off (env: MULTI_CANDIDATE_ENABLED)
  k_default: 4,                     // Default candidates (env: MULTI_CANDIDATE_K)
  k_easy: 2,                        // Easy questions
  k_hard: 6,                        // Hard questions
  max_candidates_to_explain: 4,     // Max parallel EXPLAIN runs
  per_query_time_budget_ms: 10000,  // 10s max total
  explain_timeout_ms: 2000,         // 2s per EXPLAIN
}
```

**Scoring (Deterministic, No LLM Judge):**
| Factor | Points |
|--------|--------|
| Base score | +100 |
| Lint error | -25 each |
| Lint warning | -5 each |
| EXPLAIN fail | -50 |
| GROUP BY matches question | +10 |
| ORDER BY + LIMIT matches "top/highest" | +10 |
| DISTINCT matches question | +5 |

**Flow:**
1. Classify question difficulty → K value
2. Python sidecar generates K candidates in parallel (async aiohttp)
3. Candidates deduplicated by normalized SQL
4. TypeScript receives `sql_candidates` list
5. For each candidate: structural validation, lint, EXPLAIN
6. Score and select best candidate
7. Execute or enter repair loop

**Toggle:**
```bash
# Disable multi-candidate
MULTI_CANDIDATE_ENABLED=false npm start

# Custom K value
MULTI_CANDIDATE_K=6 npm start
```

### Repair Loop

```
Attempt 1: Generate SQL
    │
    ├─ Lint Check (syntax patterns)
    ├─ EXPLAIN Check (PostgreSQL validation)
    │
    ▼ On Error
Attempt 2: Repair with error context
    │
    ├─ 42703? → Add minimal whitelist
    ├─ Other? → Add SQLSTATE hint
    │
    ▼ On Error
Attempt 3: Final repair attempt
    │
    ▼ On Error
Return safe failure
```

### SQL Validation Rules

| Check | Severity | Action |
|-------|----------|--------|
| No SELECT | error | fail_fast |
| Multiple statements | error | fail_fast |
| Dangerous keywords (DROP, DELETE, etc.) | error | fail_fast |
| Unknown table | error | rewrite |
| Missing LIMIT | warning | auto_fix |

## Configuration

### Environment Variables

```bash
# Schema RAG
USE_SCHEMA_RAG_V2=false  # V2 retriever (disabled - causes errors)

# Exam Mode
EXAM_MODE=false          # Enable exam logging

# Multi-Candidate Generation
MULTI_CANDIDATE_ENABLED=true    # Toggle multi-candidate (default: true)
MULTI_CANDIDATE_K=4             # Default K value (default: 4)
MULTI_CANDIDATE_K_EASY=2        # K for easy questions (default: 2)
MULTI_CANDIDATE_K_HARD=6        # K for hard questions (default: 6)
MULTI_CANDIDATE_TIME_BUDGET_MS=10000  # Total time budget (default: 10000)
MULTI_CANDIDATE_EXPLAIN_TIMEOUT_MS=2000  # Per-candidate EXPLAIN timeout (default: 2000)
```

### Repair Config

```typescript
const REPAIR_CONFIG = {
  maxAttempts: 3,
  confidencePenaltyPerAttempt: 0.1,
}
```

## Running

### Build
```bash
npm run build
```

### Run Exam
```bash
npx tsx scripts/run_exam.ts
```

### Populate Embeddings
```bash
npx tsx scripts/populate_embeddings.ts
```

## Error Classification

### Fail-Fast (Never Retry)

| SQLSTATE | Meaning |
|----------|---------|
| 08xxx | Connection error |
| 42501 | Permission denied |
| 53xxx | Resource error |

### Repairable (Retry with Context)

| SQLSTATE | Meaning | Repair Strategy |
|----------|---------|-----------------|
| 42601 | Syntax error | Fix based on message |
| 42P01 | Undefined table | Use correct table from schema |
| 42703 | Undefined column | **Minimal whitelist** |
| 42804 | Type mismatch | Fix comparison types |

## Performance

| Difficulty | Success Rate |
|------------|--------------|
| Easy (20) | 95.0% |
| Medium (25) | 72.0% |
| Hard (15) | 53.3% |
| **Overall** | **75.0%** |

## Current Error Patterns

| Error Type | Count | Cause |
|------------|-------|-------|
| column_miss | 5 (8.3%) | LLM invents column names |
| llm_reasoning | 7 (11.7%) | Syntax errors, complex queries |
| execution_error | 2 (3.3%) | Gibberish output |

## Known Issues

1. **Column hallucination** - LLM invents columns not in schema (e.g., `vendor_name` → `name`)
2. **PostgreSQL syntax** - Uses MySQL functions (`YEAR()` → `EXTRACT(YEAR FROM ...)`)
3. **Sales module weak** - Only 45.5% success rate
4. **Complex analytics** - Struggles with window functions, multi-step calculations

See `/STATUS.md` for full metrics and recent changes.
