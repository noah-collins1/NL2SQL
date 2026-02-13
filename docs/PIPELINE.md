# NL2SQL Pipeline

Stage-by-stage walkthrough of how a natural language question becomes a SQL result.

## Flow Diagram

```
Question
  |
  v
[1. Module Routing]  ──> moduleFilter (1-3 modules)
  |
  v
[2. Schema Retrieval] ──> SchemaContextPacket (tables, FK edges, M-Schema)
  |    (cosine + BM25 + RRF + FK expansion)
  v
[3. Prompt Construction]
  |  3a. Schema Glosses ──> enriched column descriptions
  |  3b. Schema Linker  ──> SchemaLinkBundle (grounded columns)
  |  3c. Column Pruner   ──> trimmed columns per table
  |  3d. Join Planner   ──> JoinPlan (skeleton, paths)
  |
  v
[4. SQL Generation]
  |  K parallel LLM calls (temp=0.3)
  |  Deduplicate by normalized SQL
  |
  v
[5. Candidate Evaluation]
  |  5a. Structural validation (SELECT-only, no dangerous keywords)
  |  5b. Lint analysis (syntax patterns, common errors)
  |  5c. Parallel EXPLAIN (PostgreSQL validation, 2s timeout)
  |  5d. Deterministic scoring
  |  5e. Candidate reranker (schema adherence, join match, result shape)
  |
  v
[6. Repair Loop] (max 3 attempts)
  |  6a. PG dialect normalization (YEAR→EXTRACT, IFNULL→COALESCE)
  |  6b. SQL autocorrect (alias fixes, quote fixes)
  |  6c. Surgical whitelist (for 42703 column errors)
  |  6d. Repair prompt → LLM → re-validate
  |
  v
[7. Execute + Return]
  |  Execute on PostgreSQL, return rows + metadata
```

## Stage Details

### 1. Module Routing

**File:** `module_router.ts`
**Flag:** `MODULE_ROUTER_ENABLED` (default ON)

Classifies the question into 1-3 ERP modules (HR, Finance, Sales, etc.) using keyword rules and embedding similarity against `rag.module_embeddings`. The module filter narrows the table universe before retrieval.

**Inputs:** question text, question embedding
**Outputs:** `ModuleRouteResult { modules, method, confidences }`

### 2. Schema Retrieval

**File:** `schema_retriever.ts`, `bm25_search.ts`
**Flags:** `BM25_SEARCH_ENABLED` (ON), module filter from Stage 1

1. Embed question via Python sidecar `/embed`
2. Query `rag.table_embeddings` with pgvector cosine similarity
3. Query `rag.table_embeddings` with BM25 tsvector search
4. Combine via Reciprocal Rank Fusion (RRF, k=60)
5. Expand via FK relationships (up to `fk_expansion_limit`)
6. Build `SchemaContextPacket` with M-Schema format

**Inputs:** question, moduleFilter
**Outputs:** `SchemaContextPacket { tables, fk_edges, modules }`

### 3. Prompt Construction

#### 3a. Schema Glosses
**File:** `schema_glosses.ts` | **Flag:** `SCHEMA_GLOSSES_ENABLED` (ON)

Generates rich column descriptions using deterministic heuristics — synonym expansion, type hints (`[AMT]`, `[DATE]`, `[FK→target]`). No LLM call.

#### 3b. Schema Linker
**File:** `schema_linker.ts` | **Flag:** `SCHEMA_LINKER_ENABLED` (OFF by default, ON for qwen2.5-coder)

Extracts keyphrases from the question, matches them to columns using gloss synonyms + fuzzy matching. Produces a `SchemaLinkBundle` that forces the LLM to only use grounded columns.

#### 3c. Column Pruner
**File:** `column_pruner.ts` | **Flag:** `COLUMN_PRUNING_ENABLED` (OFF — causes regression at 86 tables; intended for 2,000+ table scale)

Trims non-PK/FK/linked columns per table to reduce prompt size. Keeps top-5 by ordinal.

#### 3d. Join Planner
**File:** `join_planner.ts` | **Flag:** `JOIN_PLANNER_ENABLED` (OFF by default, ON for qwen2.5-coder)

Builds FK graph, finds shortest paths between required tables using BFS/Yen's algorithm. Produces join skeletons the LLM can copy.

### 4. SQL Generation

**File:** `multi_candidate.ts` (TS), `hrida_client.py` (Python)

Generates K SQL candidates in parallel using async aiohttp calls to Ollama. Temperature 0.3 provides natural diversity. Candidates are deduplicated by normalized SQL.

K value is adaptive: `k_easy=2`, `k_default=4`, `k_hard=6`.

### 5. Candidate Evaluation

**File:** `multi_candidate.ts`, `sql_validator.ts`, `sql_lint.ts`, `candidate_reranker.ts`

Each candidate is scored deterministically:

| Factor | Points |
|--------|--------|
| Base score | +100 |
| Lint error | -25 each |
| Lint warning | -5 each |
| EXPLAIN fail | -50 |
| GROUP BY matches question | +10 |
| ORDER BY+LIMIT for "top/highest" | +10 |
| Schema adherence bonus | +15 |
| Join match bonus | +20 |

The candidate reranker (`CANDIDATE_RERANKER_ENABLED`, default ON) adds orthogonal signals: schema adherence, join skeleton matching, result shape checking.

### 6. Repair Loop

**File:** `nl_query_tool.ts`, `surgical_whitelist.ts`, `pg_normalize.ts`, `sql_autocorrect.ts`

If the best candidate fails EXPLAIN or execution:
1. Apply PG dialect normalization (YEAR→EXTRACT, IFNULL→COALESCE, etc.)
2. Apply SQL autocorrect (alias fixes, quote fixes)
3. For 42703 (undefined column): build surgical whitelist scoped to resolved table + FK neighbors
4. Send repair prompt to LLM with error context + delta blocks
5. Repeat up to 3 attempts

### 7. Execute + Return

Execute the validated SQL on PostgreSQL with `statement_timeout`. Return rows, metadata, and trace info.

## Feature Flag Summary

| Flag | Default | Env Var | Description |
|------|---------|---------|-------------|
| glosses | ON | `SCHEMA_GLOSSES_ENABLED` | Column description enrichment |
| pg_normalize | ON | `PG_NORMALIZE_ENABLED` | Dialect normalization |
| schema_linker | OFF | `SCHEMA_LINKER_ENABLED` | Keyphrase → column grounding |
| join_planner | OFF | `JOIN_PLANNER_ENABLED` | FK graph join planning |
| bm25 | ON | `BM25_SEARCH_ENABLED` | BM25 tsvector search |
| module_router | ON | `MODULE_ROUTER_ENABLED` | Module routing |
| column_pruning | OFF | `COLUMN_PRUNING_ENABLED` | Column trimming |
| reranker | ON | `CANDIDATE_RERANKER_ENABLED` | Candidate reranking |
| pre_sql | OFF | `PRE_SQL_ENABLED` | Sketch SQL for re-retrieval |
| value_verification | OFF | `VALUE_VERIFICATION_ENABLED` | DB value checks in reranker |
