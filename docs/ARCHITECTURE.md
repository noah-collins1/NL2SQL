# NL2SQL Architecture

Stage-by-stage walkthrough of how a natural language question becomes a SQL result, the research behind each component, and detailed file-level documentation.

## Flow Diagram

```
Question
  │
  v
[1. Module Routing]  ──> moduleFilter (1-3 modules)
  │
  v
[2. Schema Retrieval] ──> SchemaContextPacket (tables, FK edges, M-Schema)
  │    (cosine + BM25 + RRF + FK expansion)
  v
[3. Prompt Construction]
  │  3a. Schema Glosses    ──> enriched column descriptions
  │  3b. Schema Linker     ──> SchemaLinkBundle (grounded columns)
  │  3c. Confusable Tables ──> table-level warnings
  │  3d. Join Planner      ──> JoinPlan (skeleton, paths)
  │
  v
[4. SQL Generation]
  │  K parallel LLM calls (temp=0.3)
  │  Deduplicate by normalized SQL
  │
  v
[5. Candidate Evaluation]
  │  5a. Structural validation (SELECT-only, no dangerous keywords)
  │  5b. Lint analysis (syntax patterns, common errors)
  │  5c. Parallel EXPLAIN (PostgreSQL validation, 2s timeout)
  │  5d. Deterministic scoring (with tie-breaking)
  │  5e. Candidate reranker (schema adherence, join match, result shape)
  │
  v
[6. Repair Loop] (max 3 attempts)
  │  6a. PG dialect normalization (YEAR→EXTRACT, IFNULL→COALESCE)
  │  6b. SQL autocorrect (column fuzzy-match, alias resolution)
  │  6c. Surgical whitelist (for 42703 column errors)
  │  6d. Cross-table FK hints (column on parent table)
  │  6e. Phantom column hints (column doesn't exist anywhere)
  │  6f. Repair prompt → LLM → re-validate
  │
  v
[7. Execute + Return]
  │  Execute on PostgreSQL, return rows + metadata
```

---

## Stage Details

### 1. Module Routing

**File:** `mcp-server-nl2sql/src/schema_retriever.ts` (inline `routeToModules`)
**Flag:** `MODULE_ROUTER_ENABLED` (default ON)

Classifies the question into 1-3 ERP modules (HR, Finance, Sales, etc.) using a two-pronged approach:

1. **Keyword rules**: A hand-tuned map of keywords → modules (e.g., "salary" → HR, "invoice" → Finance). Fast and deterministic.
2. **Embedding similarity**: The question embedding is compared against pre-computed module embeddings stored in `rag.module_embeddings` (768-dim nomic-embed-text vectors). The top modules above a confidence threshold are selected.

The final module list is the union of both methods, capped at 3 modules. This filter narrows the table universe from 2,377 tables to typically 200-600 before retrieval, dramatically reducing noise.

**Inputs:** question text, question embedding
**Outputs:** `ModuleRouteResult { modules, method, confidences }`

**Database table:** `rag.module_embeddings` (module_name TEXT, embedding vector(768))

### 2. Schema Retrieval

**File:** `mcp-server-nl2sql/src/schema_retriever.ts` (includes BM25, RRF, cosine search, FK expansion)
**Flags:** `BM25_SEARCH_ENABLED` (ON), module filter from Stage 1

A multi-signal retrieval pipeline that builds the schema context the LLM will use:

1. **Embed question** via Python sidecar `/embed` endpoint (nomic-embed-text, 768-dim)
2. **Cosine similarity search**: Query `rag.table_embeddings` with pgvector `<=>` operator, filtered by module. Returns top-K tables ranked by embedding distance.
3. **BM25 tsvector search**: Query the same table using PostgreSQL's built-in full-text search (`plainto_tsquery`). Uses a pre-computed `search_vector` column with GIN index. Effective for exact keyword matches that embeddings might miss.
4. **Reciprocal Rank Fusion (RRF)**: Combines cosine and BM25 results using `score = 1/(k+rank)` with k=60. Tables appearing in both lists get boosted scores. This is the standard fusion technique from information retrieval.
5. **FK expansion**: Starting from the top-K fused results, walk foreign key relationships up to `fk_expansion_limit` hops. Hub tables (many FKs) are capped via `hubFKCap` to prevent explosion. Expanded tables are tagged with `source: "fk_expansion"`.
6. **Build SchemaContextPacket**: Each table's M-Schema (compact column definition format), FK edges, module assignments, and similarity scores are assembled into the packet.

**Inputs:** question, question embedding, moduleFilter
**Outputs:** `SchemaContextPacket { tables[], fk_edges[], modules[] }`

**M-Schema format:** `table_name (col1 TYPE PK, col2 TYPE FK→parent_table, col3 TYPE, ...)`

**Note:** At 70 tables BM25 barely fires (3/60 questions get hits) because `plainto_tsquery` is too literal for natural language. It was built for 2,000+ table scaling where keyword matches become more valuable.

### 3. Prompt Construction

#### 3a. Schema Glosses
**File:** `mcp-server-nl2sql/src/schema_grounding.ts` (`generateGlosses`, `glossColumn`)
**Flag:** `SCHEMA_GLOSSES_ENABLED` (default ON)

Generates rich, deterministic column descriptions without any LLM call. For each column in the schema context:

1. **Snake-case splitting**: `employee_hire_date` → `["employee", "hire", "date"]`
2. **Abbreviation expansion**: Uses a 70+ entry `ABBREVIATION_MAP` to expand common ERP abbreviations (`qty` → `quantity`, `dept` → `department`, `amt` → `amount`, `po` → `purchase order`, etc.)
3. **Type hint inference**: Infers semantic types from column name suffixes and data types. A column ending in `_date` gets `date/timestamp`, ending in `_amount` gets `monetary amount`, ending in `_id` gets `identifier/key`. Falls back to PostgreSQL data type analysis.
4. **FK/PK tagging**: Marks primary keys and foreign keys with their target tables.
5. **Synonym set**: Unions the original tokens, expanded abbreviations, and column name as a searchable synonym set for the schema linker.

The glosses appear in the prompt as enriched column annotations: `order_date [FK→sales_orders, DATE]`, `total_amt [AMOUNT, matched: "total"]`.

**Inputs:** `SchemaContextPacket`
**Outputs:** `SchemaGlosses` (Map of `"table.column"` → `ColumnGloss`)

#### 3b. Schema Linker
**File:** `mcp-server-nl2sql/src/schema_grounding.ts` (`linkSchema`, `extractKeyphrases`, `computeMatchScore`)
**Flag:** `SCHEMA_LINKER_ENABLED` (OFF by default, ON for qwen2.5-coder via config)

Extracts keyphrases from the question and matches them to schema columns, producing a grounded `SchemaLinkBundle` that constrains the LLM to only use relevant columns:

1. **Keyphrase extraction**: Pulls quoted values (`"pending"`), individual tokens (minus stopwords), and bigrams from the question. Each keyphrase is tagged as `isQuotedValue`, `isNumber`, or `isMetric`.
2. **Column matching**: For each keyphrase × column pair, computes a match score using gloss synonyms (exact match = 1.0, prefix match ≥ 0.8, substring ≥ 0.7) and column name token overlap. Minimum threshold: 0.5.
3. **Table relevance scoring**: Combines column match count (0.3), best match score (0.4), and retrieval similarity (0.3) into a per-table relevance score.
4. **Value hints**: Quoted values are matched to columns with compatible types (name/label, status enum, code identifier).
5. **Column redirect warnings**: Detects when a child table (e.g., `order_lines`) lacks a commonly-needed column (e.g., `order_date`) that exists on its FK-parent (`sales_orders`). Emits warnings in the prompt.

The output is rendered into a `## Schema Contract (MANDATORY)` section with `### Required Tables`, `### Allowed Columns`, `### Column Warnings`, and `### Value Hints`.

**Inputs:** question, `SchemaContextPacket`, `SchemaGlosses`
**Outputs:** `SchemaLinkBundle { linkedTables, linkedColumns, joinHints, valueHints, unsupportedConcepts }`

#### 3c. Confusable Table Warnings
**File:** `mcp-server-nl2sql/src/schema_grounding.ts` (`CONFUSABLE_TABLES` map, rendered in `formatSchemaLinkForPrompt`)

A static map of tables that LLMs commonly confuse or mis-join. When a confusable table appears in the linked tables AND the question contains trigger keywords, a `### Table Warnings (READ CAREFULLY)` section is injected into the schema contract.

Currently contains one entry:
- **`sales_regions`**: Triggered by keywords like "region", "by region". Warns that geographic region grouping should use `states_provinces` via the address chain (`customers → addresses → cities → states_provinces`), not `sales_regions` which has no FK to `sales_orders`.

This is a targeted, low-cost mechanism for domain-specific pitfalls that 7B models repeatedly fall into.

#### 3d. Join Planner
**File:** `mcp-server-nl2sql/src/join_planner.ts`
**Flag:** `JOIN_PLANNER_ENABLED` (OFF by default, ON for qwen2.5-coder via config)
**Sub-flags:** `FK_SUBGRAPH_CACHE_ENABLED`, `DYNAMIC_HUB_CAP_ENABLED`, `JOIN_PATH_SCORING_ENABLED`, `CROSS_MODULE_JOIN_ENABLED` (all ON)

Builds an FK graph from the schema context and plans join paths between required tables:

1. **FK graph construction**: Builds a bidirectional adjacency list from `fk_edges`. Each edge records the from/to columns.
2. **Subgraph caching**: Caches connected components for repeated queries against the same schema context. Avoids redundant BFS.
3. **Path finding**: Uses BFS (and optionally Yen's k-shortest-paths) to find join paths between all pairs of linked tables. Paths are scored by length (shorter = better) and FK directionality (child→parent preferred).
4. **Hub table capping**: Dynamic hub cap prevents explosion through high-degree tables (e.g., `employees` with 20+ FKs). The cap adjusts based on the number of required tables.
5. **Cross-module joins**: When required tables span multiple modules, the planner finds bridge tables that connect them.
6. **Skeleton generation**: Produces `JoinSkeleton` objects — ordered lists of `JOIN table ON col = col` clauses that the LLM can copy directly into SQL.

**Inputs:** `SchemaContextPacket`, `SchemaLinkBundle`
**Outputs:** `JoinPlan { skeletons[], joinGraph, requiredTables }`

### 4. SQL Generation

**Files:** `mcp-server-nl2sql/src/multi_candidate.ts` (TypeScript orchestration), `python-sidecar/ollama_client.py` (Python LLM client)
**Flag:** `MULTI_CANDIDATE_ENABLED` (default ON)

Generates K SQL candidates using the Python sidecar's async parallel generation:

1. **Difficulty classification**: The question is classified as easy/medium/hard using regex patterns (e.g., "how many" → easy, "compare…by department" → hard) and table count. This determines K: `k_easy=2`, `k_default=4`, `k_hard=6`.
2. **Parallel LLM calls**: The sidecar fires K independent async HTTP requests to Ollama's `/api/generate` endpoint, each with `temperature=0.3`. This provides natural diversity without delimiter-based parsing issues.
3. **Deduplication**: Candidates are normalized (whitespace, case) and deduplicated. Typically 2-4 unique candidates survive from K=4.
4. **Prompt composition**: The base prompt includes the schema contract, join plan, and question. For non-Hrida models, a SQL system prompt is prepended. The schema link text and join plan text are injected as pre-formatted sections.

**Inputs:** prompt (with schema contract + join plan), K, temperature
**Outputs:** `string[]` (deduplicated SQL candidates)

### 5. Candidate Evaluation

**Files:** `mcp-server-nl2sql/src/multi_candidate.ts` (scoring, EXPLAIN), `mcp-server-nl2sql/src/sql_validation.ts` (structural validation, lint), `mcp-server-nl2sql/src/candidate_reranker.ts` (reranking)

Each candidate passes through a multi-stage evaluation pipeline:

#### 5a. Structural Validation
Checks for hard-reject conditions: must be SELECT, no multi-statement, no dangerous keywords (DROP, DELETE, INSERT, UPDATE), table allowlist compliance, LIMIT enforcement.

#### 5b. Lint Analysis
Pattern-based analysis catching common SQL errors: `SELECT *` usage, missing GROUP BY for aggregates, ambiguous column references, CROSS JOIN detection, HAVING without GROUP BY.

#### 5c. Parallel EXPLAIN
Non-rejected candidates are sent to PostgreSQL `EXPLAIN (FORMAT JSON)` in parallel with a 2-second timeout per candidate. EXPLAIN catches real schema errors (undefined columns, wrong types) without executing the query.

#### 5d. Deterministic Scoring
Each candidate gets a numeric score:

| Factor | Points |
|--------|--------|
| Base score | +100 |
| Lint error | -25 each |
| Lint warning | -5 each |
| EXPLAIN fail | -50 |
| GROUP BY matches question | +10 |
| ORDER BY+LIMIT for "top/highest" | +10 |
| DISTINCT for "unique/different" | +5 |
| JOIN for relationship questions | +5 |
| Schema adherence (reranker) | up to +15 |
| Join match (reranker) | up to +20 |
| Result shape (reranker) | up to +10 |

**Tie-breaking** is deterministic: when scores are equal, candidates are ordered by EXPLAIN pass status → fewer lint errors → lower index (original generation order).

#### 5e. Candidate Reranker
**Flag:** `CANDIDATE_RERANKER_ENABLED` (default ON)

Adds orthogonal signals as post-hoc bonuses (can only improve selection, never reject):

1. **Schema adherence**: Fraction of SQL tables/columns that exist in the schema context. Tables weighted 0.4, columns 0.6.
2. **Join skeleton matching**: Compares extracted JOIN conditions against planner skeletons. Handles column-order independence (`a.id = b.fk ≡ b.fk = a.id`).
3. **Result shape checking**: Detects expected aggregation type from question (COUNT for "how many", SUM for "total") and checks if SQL matches. Also checks GROUP BY and ORDER BY expectations.
4. **Value verification** (optional, OFF by default): Checks if WHERE clause string literals actually exist in the database. Only runs on top-2 candidates.

### 6. Repair Loop

**Files:** `mcp-server-nl2sql/src/nl_query_tool.ts` (orchestration), `mcp-server-nl2sql/src/sql_validation.ts` (autocorrect, PG normalize), `mcp-server-nl2sql/src/surgical_whitelist.ts` (surgical repair), `python-sidecar/config.py` (repair prompt templates)

If the best candidate fails EXPLAIN or execution, the repair loop attempts up to 3 fixes:

#### 6a. PG Dialect Normalization
**File:** `mcp-server-nl2sql/src/sql_validation.ts` (`pgNormalize`)
**Flag:** `PG_NORMALIZE_ENABLED` (default ON)

Regex-based transforms that fix common non-PostgreSQL patterns:
- `YEAR(date)` → `EXTRACT(YEAR FROM date)`
- `IFNULL(a, b)` → `COALESCE(a, b)`
- `DATE_ADD(date, INTERVAL n)` → `date + INTERVAL 'n'`
- `LIMIT n, m` → `LIMIT m OFFSET n`
- Integer interval fixes: `INTERVAL 1 YEAR` → `INTERVAL '1 year'`
- `EXTRACT(DAY FROM (date - date))` → `(date - date)` — PostgreSQL date subtraction returns integer (days), not interval, so `EXTRACT(DAY FROM integer)` fails
- Strip `WHERE [alias.]column = 'div_XX'` clauses — division scoping is handled by PostgreSQL `search_path`, not data columns. Catches both `WHERE division = 'div_19'` and type mismatches like `WHERE department_id = 'div_17'`
- And ~17 more transforms

#### 6b. SQL Autocorrect
**File:** `mcp-server-nl2sql/src/sql_validation.ts` (`autocorrectUndefinedColumn`, `autocorrectMissingTable`)

For 42703 (undefined column) errors:
1. Parse the error message to extract the failing column name and table hint
2. Resolve aliases to actual table names
3. Build candidate list from schema context using exact match, containment match, and Levenshtein fuzzy matching
4. If best candidate is on the same table and above confidence threshold, perform inline replacement

For 42P01 (undefined table) errors:
1. Parse table name from error
2. Find closest match in allowed tables using Levenshtein distance

#### 6c. Surgical Whitelist
**File:** `mcp-server-nl2sql/src/surgical_whitelist.ts`
**Flag:** `SURGICAL_WHITELIST_ENABLED` (configurable mode: observe/active)

For 42703 errors in active mode, builds a targeted column whitelist scoped to:
- The resolved table (the table the alias points to)
- FK neighbor tables (1-hop reachable via foreign keys)

The whitelist is injected into the repair prompt as `REPAIR_DELTA_MINIMAL_WHITELIST`, giving the LLM a focused list of valid columns instead of the entire schema.

Two-tier gating ensures safety:
- **Strict gating**: Composite scoring (lexical similarity + containment bonus + dominance delta) must pass thresholds
- **Active gating**: Bypasses confidence threshold and calls `findColumnMatches` directly for more aggressive repair

#### 6d. Cross-Table FK Repair Hints
**File:** `mcp-server-nl2sql/src/sql_validation.ts` (`findFKJoin`, `CrossTableHint` in `autocorrectUndefinedColumn`)
**Sidecar template:** `REPAIR_DELTA_CROSS_TABLE` in `python-sidecar/config.py`

When autocorrect finds the column on an FK-parent table but can't do inline replacement (because it's a cross-table fix requiring a JOIN change):

1. `autocorrectUndefinedColumn` detects the best candidate is on a different table than the alias resolves to
2. `findFKJoin` checks if there's a direct FK path between the two tables (either direction)
3. If reachable, produces a `CrossTableHint` with the exact JOIN clause: `"JOIN sales_orders ON order_lines.order_id = sales_orders.order_id"`
4. The hint is injected into `PostgresErrorContext.cross_table_hint` and rendered in the sidecar repair prompt as a **MANDATORY** instruction

Example: LLM writes `order_lines.order_date` → autocorrect finds `sales_orders.order_date` (score 1.0) → hint tells LLM to `JOIN sales_orders ON order_lines.order_id = sales_orders.order_id` and use `sales_orders.order_date`.

#### 6e. Phantom Column Repair Hints
**File:** `mcp-server-nl2sql/src/sql_validation.ts` (in `autocorrectUndefinedColumn`)
**Sidecar template:** `REPAIR_DELTA_PHANTOM_COLUMN` in `python-sidecar/config.py`

When autocorrect finds zero candidates AND the column doesn't exist in any table in the entire schema context:

1. Scans all tables' M-Schema columns for an exact match
2. If not found anywhere, produces a `phantom_column_hint` explaining the column doesn't exist
3. The hint tells the LLM to **remove** the reference entirely — common for division-scoped columns (`division`) that are handled by PostgreSQL `search_path`, not by explicit WHERE clauses

#### 6f. Repair Prompt → LLM
**File:** `python-sidecar/config.py` (`build_rag_repair_prompt`)

The repair prompt uses a **base + delta** architecture:
- **Base**: Same schema contract + question as the original generation
- **Delta blocks**: Appended per-attempt, never mutating the base. Include:
  - `REPAIR_DELTA_POSTGRES`: SQLSTATE, error message, hint, previous SQL
  - `REPAIR_DELTA_MINIMAL_WHITELIST`: Surgical column whitelist (if available)
  - `REPAIR_DELTA_CROSS_TABLE`: Cross-table FK join instruction (if available)
  - `REPAIR_DELTA_PHANTOM_COLUMN`: Column removal instruction (if available)
  - `REPAIR_DELTA_COLUMN_CANDIDATES`: Fuzzy column suggestions (fallback)
  - `REPAIR_DELTA_VALIDATOR`: Structural validation issues
  - `REPAIR_DELTA_SEMANTIC`: Semantic mismatch issues

### 7. Execute + Return

**File:** `mcp-server-nl2sql/src/nl_query_tool.ts`

Execute the validated SQL on PostgreSQL with `statement_timeout`. The execution is wrapped in error classification:
- **Infrastructure errors** (connection, pool, resources): Fail immediately, never retry
- **Timeout errors** (57014): May retry with simpler query
- **SQL errors** (syntax, column, type): Re-enter repair loop
- **Validation blocks** (permissions): Fail immediately

Returns `NLQueryResponse` with rows, metadata, confidence score, trace info, and tables used.

---

## Research Origins

Techniques adopted from BIRD/Spider benchmark leaderboard entries. Key finding: **schema grounding is the #1 bottleneck for 7B models** — "gold linker" (oracle schema linking) boosts 7B models substantially, meaning retrieval/linking is the highest-leverage improvement area.

### Implemented

| Technique | Source | Implementation | Files |
|-----------|--------|---------------|-------|
| Pre-SQL backward recall | [RSL-SQL](https://github.com/Laqcce-cao/RSL-SQL) | Generate sketch SQL first, extract referenced tables, re-retrieve any missing tables from pgvector, merge into schema context before final generation. Targets column_miss from incomplete retrieval. | `pre_sql.ts` (deleted in consolidation, recovery planned). Was integrated into `nl_query_tool.ts` between linker and join planner. Feature flag `PRE_SQL_ENABLED` (default OFF). |
| Schema glosses + synonym expansion | [CHESS](https://github.com/ShayanTalaei/CHESS) | Deterministic column enrichment without LLM calls. Splits snake_case names, expands 70+ ERP abbreviations (qty→quantity, dept→department), infers semantic types from suffixes and data types, tags PK/FK relationships. Produces a searchable synonym set per column for downstream linking. | `mcp-server-nl2sql/src/schema_grounding.ts` — `generateGlosses()`, `glossColumn()`, `ABBREVIATION_MAP`, `SUFFIX_TYPE_HINTS` |
| Schema linker (keyphrase→column) | [CHESS](https://github.com/ShayanTalaei/CHESS) | Extracts keyphrases from question (quoted values, tokens, bigrams), matches against gloss synonyms and column name tokens with scored fuzzy matching (exact=1.0, prefix≥0.8, substring≥0.7). Produces a SchemaLinkBundle constraining the LLM to grounded columns only. Renders as `## Schema Contract (MANDATORY)` in the prompt. | `mcp-server-nl2sql/src/schema_grounding.ts` — `linkSchema()`, `extractKeyphrases()`, `computeMatchScore()`, `formatSchemaLinkForPrompt()` |
| Module routing | [CHESS](https://github.com/ShayanTalaei/CHESS) | Narrows the 2,377-table universe to 1-3 modules before retrieval using keyword rules + embedding similarity against pre-computed module embeddings. Reduces noise and retrieval latency. | `mcp-server-nl2sql/src/schema_retriever.ts` — `routeToModules()`, `rag.module_embeddings` table |
| BM25 hybrid search + RRF | [CHESS](https://github.com/ShayanTalaei/CHESS) | Combines pgvector cosine similarity with PostgreSQL tsvector BM25 search using Reciprocal Rank Fusion (k=60). Tables in both result sets get boosted scores. Built for 2,000+ table scaling where keyword matches complement embedding retrieval. | `mcp-server-nl2sql/src/schema_retriever.ts` — BM25 query functions, RRF merge logic |
| Join-aware table planning | General (inspired by JAR/CORE-T concepts) | FK graph BFS + Yen's k-shortest-paths between required tables. Produces join skeletons the LLM can copy. Includes subgraph caching, dynamic hub caps, cross-module bridge detection, and path scoring (shorter + child→parent preferred). | `mcp-server-nl2sql/src/join_planner.ts` — `planJoins()`, `buildFKGraph()`, `findShortestPath()`, `generateSkeletons()` |
| Multi-candidate generation | [Agentar](https://github.com/antgroup/Agentar-Scale-SQL), [Contextual-SQL](https://github.com/ContextualAI/bird-sql) | Generate K diverse SQL candidates in parallel (async HTTP to Ollama, temp=0.3), deduplicate by normalized SQL, score deterministically, select best. Adaptive K based on question difficulty (easy=2, default=4, hard=6). | `mcp-server-nl2sql/src/multi_candidate.ts` — `evaluateCandidates()`, `parseCandidates()`, `scoreCandidate()`. `python-sidecar/ollama_client.py` — `generate_candidates_parallel()` |
| Candidate reranking | [Agentar](https://github.com/antgroup/Agentar-Scale-SQL), [Contextual-SQL](https://github.com/ContextualAI/bird-sql) | Post-hoc reranking with orthogonal signals: schema adherence (fraction of SQL entities in schema), join skeleton matching (compare SQL JOINs to planner output), result shape checking (expected vs actual aggregation type). Additive bonuses only — never rejects. | `mcp-server-nl2sql/src/candidate_reranker.ts` — `HeuristicReranker`, `computeSchemaAdherence()`, `computeJoinMatch()`, `computeResultShape()` |
| Targeted repair hints | [DIN-SQL](https://github.com/MohammadrezaPourreza/Few-shot-NL2SQL-with-prompting) | Instead of generic "fix this error" repair, provides specific actionable instructions: cross-table FK hints (exact JOIN clause + column location), phantom column removal, surgical column whitelists. Based on DIN-SQL's principle that "correction should be targeted, not presumptive." | `mcp-server-nl2sql/src/sql_validation.ts` — `CrossTableHint`, `findFKJoin()`, phantom detection in `autocorrectUndefinedColumn()`. `python-sidecar/config.py` — `REPAIR_DELTA_CROSS_TABLE`, `REPAIR_DELTA_PHANTOM_COLUMN` |
| PG dialect normalization | General best practice | Regex transforms fixing common non-PostgreSQL patterns that 7B models generate from training on MySQL/SQLite data. ~17 transforms covering YEAR(), IFNULL(), DATE_ADD(), LIMIT offset syntax, integer intervals, date-subtraction EXTRACT(DAY) removal, division-scoping WHERE clause stripping, etc. | `mcp-server-nl2sql/src/sql_validation.ts` — `pgNormalize()` |
| Hedged schema / column pruning | [RSL-SQL](https://github.com/Laqcce-cao/RSL-SQL) | Prunes non-PK/FK/linked columns per table to reduce prompt noise for 7B models. Keeps top-N by ordinal position. Currently OFF — too aggressive at maxNonStructural=5 for 70-table DB (caused 88.3%→81.7% regression). Intended for 2,000+ table scaling where prompt budget matters. | `mcp-server-nl2sql/src/column_pruner.ts` — `pruneColumns()`. Flag: `COLUMN_PRUNING_ENABLED` (OFF) |
| Deterministic tie-breaking | General best practice | Both candidate sort (`multi_candidate.ts`) and reranker sort (`candidate_reranker.ts`) use deterministic tie-breaking: score → EXPLAIN passed → fewer lint errors → lower index. Prevents non-deterministic candidate selection when scores are tied. | `mcp-server-nl2sql/src/multi_candidate.ts` line 843, `mcp-server-nl2sql/src/candidate_reranker.ts` line 776 |
| Confusable table warnings | Domain-specific | Static map of tables that LLMs commonly confuse, with trigger keywords and corrective hints. When a confusable table appears in linked tables and question matches trigger keywords, a warning is injected into the schema contract. | `mcp-server-nl2sql/src/schema_grounding.ts` — `CONFUSABLE_TABLES` map, rendered in `formatSchemaLinkForPrompt()` |

### Not Yet Implemented

| Technique | Source | Phase | Description |
|-----------|--------|-------|-------------|
| Value retrieval / entity linking | [CHESS](https://github.com/ShayanTalaei/CHESS) | B2 | Build per-column value index (unique categoricals + sampled strings). On query, extract candidate values via fuzzy/LSH match, inject into prompt as evidence. Helps dirty values and WHERE clause accuracy. |
| Similar-task few-shot retrieval | [TA-SQL](https://github.com/quge2023/TA-SQL), [DAIL-SQL](https://github.com/BeachWang/DAIL-SQL) | C3 | Build index over solved exam questions (SQL skeletons). On new query, retrieve top-3 similar patterns as few-shot exemplars. TA-SQL uses task alignment to reduce hallucination; DAIL-SQL selects examples by skeleton similarity for token efficiency. |
| Reward model selection | [Contextual-SQL](https://github.com/ContextualAI/bird-sql) | C2 | Open-source reward model at `ContextualAI/ctx-bird-reward-250121` on HuggingFace. Scores SQL candidates by quality. Requires evaluation of model size vs GPU budget. |
| OmniSQL 7B drop-in | [OmniSQL](https://github.com/RUCKBReasoning/OmniSQL) | D1 | Purpose-trained text-to-SQL 7B model. Drop-in replacement for qwen2.5-coder — no architecture changes needed, just model swap. |
| Skeleton-first prompting | [RESDSQL](https://github.com/RUCKBReasoning/RESDSQL) | D2 | Two-stage: (1) generate SQL skeleton with placeholders, (2) fill in column/table names from schema. Decouples structure from naming, reducing structural drift. |
| Constrained decoding | [PICARD](https://github.com/ServiceNow/picard) | D3 | Token-level SQL parser constraints during generation. Prevents syntactically invalid SQL at decode time. Requires custom Ollama integration or vLLM. High effort. |

---

## Feature Flag Summary

| Flag | Default | Env Var | Description |
|------|---------|---------|-------------|
| glosses | ON | `SCHEMA_GLOSSES_ENABLED` | Column description enrichment |
| pg_normalize | ON | `PG_NORMALIZE_ENABLED` | Dialect normalization |
| schema_linker | OFF* | `SCHEMA_LINKER_ENABLED` | Keyphrase → column grounding |
| join_planner | OFF* | `JOIN_PLANNER_ENABLED` | FK graph join planning |
| bm25 | ON | `BM25_SEARCH_ENABLED` | BM25 tsvector search |
| module_router | ON | `MODULE_ROUTER_ENABLED` | Module routing |
| reranker | ON | `CANDIDATE_RERANKER_ENABLED` | Candidate reranking |
| value_verification | OFF | `VALUE_VERIFICATION_ENABLED` | DB value checks in reranker |
| column_pruning | OFF | `COLUMN_PRUNING_ENABLED` | Column pruning (regression risk) |
| pre_sql | OFF | `PRE_SQL_ENABLED` | Pre-SQL backward recall |
| multi_candidate | ON | `MULTI_CANDIDATE_ENABLED` | Multi-candidate generation |

\* ON for qwen2.5-coder via `config.yaml` model-specific settings (32K context handles it)

## Key Design Principles

1. **Don't rely on the generator to discover schema** — make schema discovery a measured, logged step (from CHESS)
2. **Higher recall adds noise for 7B models** — use hedged/adaptive schema selection (from RSL-SQL)
3. **Test-time scaling > single-shot** — generate many, select well (from Agentar, Contextual-SQL)
4. **Prompt verbosity hurts small models** — keep prompts tight, use skeleton similarity for few-shot (from DAIL-SQL)
5. **Correction should be targeted, not presumptive** — specific repair hints beat generic "fix this" (from DIN-SQL)
6. **Mechanical fixes outperform prompt engineering at 7B** — regex transforms, autocorrect, and validator fixes deliver more reliable gains than instructional prompt additions
