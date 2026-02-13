# NL2SQL MCP Server - TypeScript Layer

**Last Updated:** 2026-02-13

## Overview

TypeScript MCP server that converts natural language to SQL. Handles schema retrieval, parallel multi-candidate SQL generation, validation, repair loops, and execution.

**Database:** Enterprise ERP — tested at both 70-table and 2,000-table scale
**Current Success Rates:**
- 70-table DB: 88.3% (60 questions) — Easy: 100%, Medium: 88%, Hard: 73.3%
- 2,000-table DB: 76.0% (300 questions) — Simple: 95%, Moderate: 74.2%, Challenging: 72.1%

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
# 70-table DB (enterprise_erp)
EXAM_MODE=true npx tsx scripts/run_exam.ts
EXAM_MODE=true npx tsx scripts/run_exam_multi.ts 3    # Multi-run

# 2000-table DB (enterprise_erp_2000)
EXAM_MODE=true OLLAMA_MODEL=qwen2.5-coder:7b SEQUENTIAL_CANDIDATES=true \
  npx tsx scripts/run_exam_2000.ts --exam ../exam/exam_full_300.csv
# Quick subset:
EXAM_MODE=true OLLAMA_MODEL=qwen2.5-coder:7b SEQUENTIAL_CANDIDATES=true \
  npx tsx scripts/run_exam_2000.ts --exam ../exam/exam_full_300.csv --max=10
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

### 2,000-Table DB (enterprise_erp_2000) — 2026-02-13

**300 questions, single run:** 76.0% (228/300)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Simple (40) | 38 | 2 | 95.0% |
| Moderate (120) | 89 | 31 | 74.2% |
| Challenging (140) | 101 | 39 | 72.1% |

**Failure breakdown:** column_miss 35 (11.7%), llm_reasoning 30 (10.0%), execution_error 7 (2.3%)

**By domain:** retail 100%, assets 100%, inventory 91.3%, hr 86.5%, services 85.7%, procurement 83.3%, dirty_naming 81.5%, finance 70.4%, projects 64%, sales 51.4%, lookup 41.9%, manufacturing 20%

**DB features:** 20 divisions, 4 archetypes (mfg/svc/rtl/corp), dirty naming (30% of divisions), coded status values (lookup_codes), ambiguous join paths. See `docs/EVAL_2000_TABLE_RESULTS.md` for full writeup.

### 70-Table DB (enterprise_erp) — 2026-02-12

**60 questions, single run:** 88.3% (53/60)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Easy (20) | 20 | 0 | 100% |
| Medium (25) | 22 | 3 | 88% |
| Hard (15) | 11 | 4 | 73.3% |

**Config (both):** qwen2.5-coder:7b, glosses ON, PG normalize ON, schema linker ON, join planner ON (Phase 2), BM25 ON, module router ON, reranker ON, temp=0.3, sequential candidates

## Current Error Analysis (2000-table, 72 failures)

| Category | Count | % | Primary Cause |
|----------|-------|---|---------------|
| column_miss | 35 | 11.7% | Dirty naming + archetype columns the model hasn't seen |
| llm_reasoning | 30 | 10.0% | Validation exhaustion — correct SQL not reached in 3 attempts |
| execution_error | 7 | 2.3% | Sidecar internal errors |

### Weakest Areas

- **Lookup queries (41.9%):** Model doesn't discover it needs to join `lookup_codes` to decode `sts_cd` values
- **Manufacturing (20%):** Dirty naming (`xx_mfg_wo`) + coded statuses compound into frequent column hallucination
- **Sales (51.4%):** `sales_regions` geography joins and column ambiguity
- **KPI formulas (50%):** DSO, working capital, gross margin require business logic beyond column matching

### Strongest Areas

- **Retail (100%):** Well-isolated domain with consistent naming
- **Simple queries (95%):** Retrieval + generation reliably handles 1-2 table queries
- **Dirty naming overall (81.5%):** Schema glosses bridge most abbreviated names
- **Join paths (0% miss):** FK-graph join planner correctly identifies paths in all cases

## Potential Fixes

| Fix | Target | Effort | Expected Impact |
|-----|--------|--------|-----------------|
| Auto-include `lookup_codes` when coded columns detected | lookup failures | Medium | +8-10% |
| Increase repair budget to 4-5 attempts | llm_reasoning | Low | +3-5% |
| Expand schema glosses for manufacturing abbreviations | mfg column_miss | Low | +3% |
| Larger model for hard queries (14B+) | llm_reasoning + KPI | High | +5-8% |
