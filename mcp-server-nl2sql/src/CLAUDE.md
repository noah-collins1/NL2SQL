# NL2SQL MCP Server - TypeScript Layer

**Last Updated:** 2026-02-11

## Overview

TypeScript MCP server that converts natural language to SQL. Handles schema retrieval, parallel multi-candidate SQL generation, validation, repair loops, and execution.

**Database:** Enterprise ERP (60+ tables, 8 modules)
**Current Success Rate:** 88.3% (Easy: 100%, Medium: 88%, Hard: 73.3%) — single run 2026-02-11

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
| `multi_candidate.ts` | Multi-candidate generation, parsing, scoring, selection |

### Schema RAG

| File | Purpose |
|------|---------|
| `schema_retriever.ts` | **V1 retriever (ACTIVE)** - pgvector + BM25 hybrid search with RRF fusion |
| `schema_retriever_v2.ts` | V2 dual retrieval (NOT IN USE - caused errors) |
| `bm25_search.ts` | BM25 tsvector search + RRF fusion |
| `module_router.ts` | Question → module classification (keyword + embedding) |
| `column_pruner.ts` | Column pruning per table (PK/FK + linked + top-5) |
| `schema_embedder.ts` | Embedding generation via Python sidecar |
| `schema_introspector.ts` | Database introspection |
| `schema_types.ts` | Schema type definitions, M-Schema format |

### SQL Validation

| File | Purpose |
|------|---------|
| `sql_validator.ts` | Core validation (SELECT-only, dangerous keywords, tables) |
| `sql_lint.ts` | SQL linting (syntax patterns, common errors) |
| `sql_autocorrect.ts` | Automatic SQL fixes (aliases, quotes) |
| `column_candidates.ts` | Legacy minimal whitelist repair |
| `surgical_whitelist.ts` | Surgical column whitelist with two-tier gating + risk blacklist |
| `surgical_whitelist.test.ts` | Unit tests for surgical whitelist |

## Key Features

### Schema RAG V1 (Active)

Retrieves relevant tables for each question:
1. Embed question via Python sidecar
2. Query pgvector for similar table descriptions
3. Expand via FK relationships
4. Build SchemaContextPacket with M-Schema format

### Surgical Column Whitelist (Two-Tier Gating)

For SQLSTATE 42703 (undefined column) errors — table-scoped column repair with two-tier safety gating.

**Pipeline:**
1. **Extract failing reference** from error message (`e.salary_amount`)
2. **Robust alias resolution** via FROM/JOIN clause parsing
3. **Build surgical whitelist** scoped to resolved table + FK neighbors
4. **Attempt deterministic rewrite** (conservative, high-confidence only)
5. **If rewrite fails**, generate compact repair prompt (<2000 chars)

**Two-Tier Gating Architecture:**

| Tier | Function | Purpose |
|------|----------|---------|
| Observe | `evaluateStrictGating` | Logs what whitelist WOULD do. Shadow-only, no behavior change. |
| Active | `evaluateActiveGating` | Stricter gate that guarantees `correctedSQL` when `passed === true`. |

**Observe tier** runs in all modes to build telemetry. **Active tier** is the sole decision-maker when `mode: "active"` — it bypasses `rewriteMinConfidence` and calls `findColumnMatches` directly with its own 9-gate evaluation.

**Active Gating — 9 Gates (all must pass):**
1. Keyword rejection (SQL functions like `year`, `count`)
2. Alias resolves unambiguously
3. Autocorrect was attempted and failed
4. Has candidate columns
5. Score floor (>= 0.80)
6. Dominance: best - second >= 0.60 (2+ candidates only)
7. Score separation: delta >= 0.10 OR ratio >= 1.15 (2+ candidates only)
8. Containment OR exact match (token-level)
9. Risk blacklist clear

**Key invariant:** `passed === true` guarantees `correctedSQL` is present.

**Risk Blacklist (`checkRiskBlacklist`):**
Uses token-diff approach — computes `refOnly`/`candOnly` token sets and checks against configured dangerous pairs. Prevents semantic flips like `vendor_name → vendor_number`.

```typescript
// Configured pairs: ["name","number"], ["name","id"], ["amount","total"],
//                   ["date","id"], ["vendor","customer"]
// Action: "block" (default) | "penalize"
// applyToObserve: false (only blocks in active mode)
```

**Key Exported Functions:**
- `processSurgicalWhitelist(sql, errorMessage, schemaContext)` — main entry, builds whitelist + attempts rewrite
- `evaluateStrictGating(surgicalResult, autocorrectAttempted, autocorrectSucceeded)` — observe tier
- `evaluateActiveGating(surgicalResult, autocorrectAttempted, autocorrectSucceeded, sql, errorMessage)` — active tier
- `checkRiskBlacklist(refColumn, candidateColumn)` — token-diff blacklist check

**Configuration (`SURGICAL_WHITELIST_CONFIG`):**
```typescript
{
  enabled: true,
  mode: "observe",           // "observe" | "active"
  observeInExamOnly: true,
  includeFkNeighbors: true,
  maxNeighborTables: 3,
  maxTablesTotal: 4,
  maxColumnsPerTable: 60,
  rewriteMinConfidence: 0.75,   // bypassed in active mode
  rewriteAmbiguityDelta: 0.1,
  activeRewriteGate: {
    minScore: 0.80,
    minDominance: 0.60,
    requireContainmentOrExact: true,
    requireScoreSeparation: true,
    minScoreDelta: 0.10,
    minScoreRatio: 1.15,
  },
  riskBlacklist: {
    enabled: true,
    pairs: [["name","number"], ["name","id"], ["amount","total"],
            ["date","id"], ["vendor","customer"]],
    action: "block",
    applyToObserve: false,
  },
}
```

**To safely enable active mode:**
1. Run exams in observe mode — review `shadow_whitelist_observations` in exam logs
2. Verify `active_gating_passed` precision is acceptable
3. Switch `mode` from `"observe"` to `"active"`

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

# Phase 1: Retrieval Upgrades
BM25_SEARCH_ENABLED=true        # BM25 tsvector search + RRF fusion (default: true)
MODULE_ROUTER_ENABLED=true      # Module routing before retrieval (default: true)
COLUMN_PRUNING_ENABLED=false    # Column pruning per table (default: false — causes regression)
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
# Single run
npx tsx scripts/run_exam.ts

# Multi-run with statistical analysis (recommended)
npx tsx scripts/run_exam_multi.ts 3    # Run 3 times, report mean ± std dev
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
| 42703 | Undefined column | **Surgical whitelist** (two-tier gating) |
| 42804 | Type mismatch | Fix comparison types |

## Performance

**Latest single run (2026-02-11):** 88.3% (53/60)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Easy (20) | 20 | 0 | 100% |
| Medium (25) | 22 | 3 | 88% |
| Hard (15) | 11 | 4 | 73.3% |

**Config:** qwen2.5-coder:7b, glosses ON, PG normalize ON, schema linker ON, join planner ON, temp=0.3, sequential candidates

**Historical reference (multi-run, 3 runs, 2026-02-07):**

| Metric | Value |
|--------|-------|
| Mean | 78.3% ± 1.4% |
| Range | 76.7% - 80.0% |

Note: The 2026-02-11 run is a single run, not a multi-run average. Variance between runs is ~±2-4%.

## Current Error Analysis (7 failures, 2026-02-11)

| Category | Count | % |
|----------|-------|---|
| validation_exhausted | 3 | 5.0% |
| generation_failure | 2 | 3.3% |
| execution_error | 2 | 3.3% |

### Remaining Failures

| Q# | Difficulty | Module | Question | Failure Mode | Root Cause |
|----|-----------|--------|----------|-------------|------------|
| 26 | Medium | Sales | Total sales amount by customer for 2024 | Validation (3 attempts) | Initial generation fails lint; final SQL is correct but too late |
| 30 | Medium | Sales | Sales orders by sales representative | Validation (3 attempts) | Same as Q26; initial generation has lint errors |
| 32 | Medium | Inventory | Total inventory value by warehouse | Validation (3 attempts) | Same pattern; `p.price` hallucinated initially (should be `list_price`) |
| 49 | Hard | Sales | Month-over-month sales growth rate | Generation failure | Complex CTE+LAG query exceeds model capability |
| 54 | Hard | Procurement | Vendor performance score | Generation failure | Model produces no valid SELECT statement |
| 57 | Hard | Projects | Project profitability budget vs actual | Execution error: missing FROM | Joins `project_budgets` to `budgets` incorrectly, uses wrong table for `planned_amount` |
| 60 | Hard | Cross-Module | Comprehensive employee cost report | Execution error: type cast | Casts text field `coverage_level` ("Family") to numeric |

### Failure Patterns

**Validation exhaustion (Q26, Q30, Q32):** The model generates SQL with lint errors on the first attempt, then the repair loop fixes the errors but exhausts all 3 attempts before producing a passing query. These are "almost there" failures where the correct SQL is reachable but the repair budget runs out.

**Generation failures (Q49, Q54):** Complex analytical queries (CTEs with window functions, multi-step aggregations) exceed the 7B model's capability. These require a larger model or decomposed query strategies.

**Execution errors (Q57, Q60):** The model produces syntactically valid SQL that fails at runtime — either joining wrong tables (Q57) or applying invalid type casts (Q60). These are semantic understanding gaps in the schema.

## Potential Fixes

| Fix | Target Errors | Effort | Expected Impact |
|-----|---------------|--------|-----------------|
| Increase repair loop budget (4-5 attempts) | validation_exhausted (Q26, Q30, Q32) | Low | +5% |
| Improve first-attempt lint quality | validation_exhausted (Q26, Q30, Q32) | Medium | +5% |
| Add CTE/window function few-shot examples | generation_failure (Q49, Q54) | Medium | +3% |
| Larger model for hard queries (14B+) | generation_failure + execution_error | High | +5% |
| Schema description improvements for Projects/Cross-Module | execution_error (Q57, Q60) | Medium | +3% |

See `/STATUS.md` for full metrics and recent changes.
