# Scaling NL2SQL to 2000 Tables

**Date:** 2026-02-12
**Current:** ~70 tables, 88.3% accuracy (53/60), qwen2.5-coder:7b
**Target:** ~2000 tables, no model training, acceptable latency (<15s)

---

## 1. Current System Snapshot

### Pipeline Diagram

```
User Question
     │
     ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 1: Schema Retrieval (schema_retriever.ts)                 │
│    pgvector cosine similarity → top-15 → FK expand top-3        │
│    maxTables=10, threshold=0.25, hubFKCap=5                      │
│    Embedding: nomic-embed-text 768d via Python sidecar           │
├──────────────────────────────────────────────────────────────────┤
│  Stage 2: Schema Glosses (schema_glosses.ts)                     │
│    Deterministic column glosses + synonym expansion              │
│    splitSnakeCase → inferTypeHint → ABBREVIATION_MAP             │
├──────────────────────────────────────────────────────────────────┤
│  Stage 3: Schema Linker (schema_linker.ts)                       │
│    extractKeyphrases → computeMatchScore → linked tables/columns │
│    MIN_LINK_SCORE=0.5, MIN_TABLE_RELEVANCE=0.1                  │
├──────────────────────────────────────────────────────────────────┤
│  Stage 4: Join Planner (join_planner.ts)                         │
│    FKGraph BFS → Steiner tree approx → top-3 skeletons          │
│    SQL fragment generation for LLM prompt                        │
├──────────────────────────────────────────────────────────────────┤
│  Stage 5: Multi-Candidate Generation (Python sidecar)            │
│    K candidates (K=2/4/6 by difficulty), temp=0.3                │
│    Sequential on 8GB GPU, parallel otherwise                     │
│    PG normalize: YEAR→EXTRACT, IFNULL→COALESCE, etc.            │
├──────────────────────────────────────────────────────────────────┤
│  Stage 6: Candidate Evaluation + Selection (multi_candidate.ts)  │
│    Structural validation → lint → parallel EXPLAIN               │
│    Deterministic scoring: base=100, lint -25, EXPLAIN -50        │
│    Heuristic bonuses: GROUP_BY +10, ORDER_LIMIT +10, etc.        │
├──────────────────────────────────────────────────────────────────┤
│  Stage 7: Repair Loop (nl_query_tool.ts, max 3 attempts)        │
│    42703 → surgical whitelist (two-tier gating)                  │
│    Other SQLSTATE → error-specific hints                         │
│    Confidence penalty: -0.1 per attempt                          │
├──────────────────────────────────────────────────────────────────┤
│  Stage 8: Execute on PostgreSQL + Return Results                 │
└──────────────────────────────────────────────────────────────────┘
```

### Current Configuration Values

| Parameter | Value | File |
|-----------|-------|------|
| `topK` (initial retrieval) | 15 | `schema_types.ts:171` |
| `threshold` (cosine similarity) | 0.25 | `schema_types.ts:172` |
| `maxTables` (after FK expansion) | 10 | `schema_types.ts:173` |
| `fkExpansionLimit` | 3 | `schema_types.ts:174` |
| `hubFKCap` | 5 | `schema_types.ts:175` |
| `fkMinSimilarity` | 0.20 | `schema_types.ts:178` |
| Multi-candidate K (default/easy/hard) | 4 / 2 / 6 | `multi_candidate.ts:111-113` |
| EXPLAIN timeout | 2000ms | `multi_candidate.ts:118` |
| Per-query time budget | 10000ms | `multi_candidate.ts:117` |
| Repair max attempts | 3 | `config.ts:634` |
| Temperature (multi-candidate) | 0.3 | `hrida_client.py:80` |
| Max tokens per candidate | 200 | `hrida_client.py:54` |
| Embedding model | nomic-embed-text 768d | Python sidecar |
| LLM model | qwen2.5-coder:7b (32K ctx) | env `OLLAMA_MODEL` |

### What Works Well at 70 Tables

- **100% easy accuracy** — single-table lookups, simple WHERE filters
- **88% medium accuracy** — 2-3 table joins, GROUP BY, aggregations
- **Schema glosses** eliminate most column hallucination (zero `column_miss` in latest run)
- **PG normalize** catches MySQL-style syntax deterministically
- **Join planner** provides correct FK skeletons for prompted joins
- **Surgical whitelist** repairs ~80% of 42703 errors without re-generation
- **Multi-candidate** with deterministic scoring finds the best candidate without an LLM judge

---

## 2. Current Failure Analysis

### Error Classification (2026-02-11 Single Run: 7 Failures)

| Category | Count | % | Questions |
|----------|-------|---|-----------|
| `validation_exhausted` | 3 | 5.0% | Q26, Q30, Q32 |
| `generation_failure` | 2 | 3.3% | Q49, Q54 |
| `execution_error` | 2 | 3.3% | Q57, Q60 |
| **Total failures** | **7** | **11.7%** | |

### Detailed Failure Breakdown

| Q# | Difficulty | Module | Question | Failure Mode | Root Cause |
|----|-----------|--------|----------|-------------|------------|
| Q26 | Medium | Sales | Total sales amount by customer for 2024 | Validation (3 attempts) | Lint errors on initial gen; correct SQL reachable but repair budget exhausts |
| Q30 | Medium | Sales | Sales orders by sales representative | Validation (3 attempts) | Same pattern — initial lint errors, repair loop too short |
| Q32 | Medium | Inventory | Total inventory value by warehouse | Validation (3 attempts) | `p.price` hallucinated initially (should be `list_price`) |
| Q49 | Hard | Sales | Month-over-month sales growth rate | Generation failure | Complex CTE+LAG exceeds 7B model capability |
| Q54 | Hard | Procurement | Vendor performance score | Generation failure | Model produces no valid SELECT statement |
| Q57 | Hard | Projects | Project profitability budget vs actual | Execution error | Wrong table join; FROM clause mismatch |
| Q60 | Hard | Cross-Module | Comprehensive employee cost report | Execution error | Casts text `coverage_level` to numeric |

### Multi-Run Stability (2026-02-10, 3 Runs, Pre-Linker/Planner)

| Category | Count | Questions |
|----------|-------|-----------|
| Always fail | 13 | Q2, Q26, Q29, Q32, Q34, Q37, Q38, Q44, Q47, Q51, Q55, Q56, Q57 |
| Flaky | 4 | Q46 (67%), Q49 (33%), Q59 (33%), Q60 (33%) |
| Always pass | 43 | All others |

### Root Cause Classification

| Root Cause | Current Count | Scaling Risk at 2000 |
|------------|--------------|---------------------|
| **Retrieval miss** (wrong tables surfaced) | 0 (at 70 tables) | **CRITICAL** — dominant failure mode |
| **Join path miss** (wrong/missing joins) | 1 | **HIGH** — combinatorial explosion |
| **Column hallucination** | 0 (solved by glosses) | **MEDIUM** — more columns = more candidates |
| **LLM reasoning limit** | 4 | **MEDIUM** — same model constraints |
| **Execution error** (semantic) | 2 | **HIGH** — more tables = more plausible-but-wrong joins |
| **Repair budget exhaustion** | 3 | **LOW** — fixable by tuning K or attempts |

---

## 3. Scaling Risks at 2000 Tables

### 3.1 Vector-Only Retrieval Breaks Down

**Current:** 70 tables in pgvector. Top-15 retrieval at threshold 0.25 captures relevant tables reliably.

**At 2000:** The same embedding space now has ~30x more candidates. Problems:

- **Dilution:** Cosine similarity scores compress — many tables cluster at similar distances. The gap between "relevant" and "plausible" tables shrinks, making threshold-based cutoffs unreliable.
- **Domain confusion:** "Show me total sales by region" matches `sales_orders`, `sales_regions`, `sales_targets`, `sales_quotas`, `sales_commissions`, `regional_budgets`, etc. At 70 tables, maybe 2-3 are similar. At 2000, maybe 20-40 are.
- **Embedding saturation:** nomic-embed-text (768d) may not have sufficient resolution to distinguish 2000 semantically overlapping table glosses. Many ERP tables share vocabulary ("amount", "date", "status", "type").

**Evidence from literature:** CHESS (66.5% BIRD), RSL-SQL (65.5% BIRD), and TA-SQL all found that vector-only retrieval is insufficient at scale. Each added an explicit schema selection or schema linking stage on top of retrieval.

### 3.2 Join Path Combinatorics

**Current:** FK graph has ~70 nodes and ~100 edges. BFS finds shortest paths quickly.

**At 2000:** FK graph has ~2000 nodes and potentially ~5000+ edges. Problems:

- **Hub explosion:** Tables like `employees`, `departments`, `customers` may have 50+ FK relationships. BFS from any required table through a hub creates an enormous search tree.
- **Steiner tree approximation degrades:** The current pairwise-shortest-path approach (`buildConnectingSubgraph`) has O(n^2) path computations where n = number of required tables. With more tables in the retrieval set, this becomes expensive and produces bloated join trees.
- **Multi-hop ambiguity:** At 70 tables, there's usually one obvious path from A to B. At 2000, there may be 3-5 plausible paths with different semantics (e.g., `employees → projects` via `project_resources` vs. via `project_managers` vs. via `timesheets`).

### 3.3 Prompt Budget Pressure

**Current:** 10 tables × ~15 columns × ~30 chars/column ≈ 4,500 chars of schema. Fits easily in 32K context.

**At 2000:** Even with retrieval narrowing to 20 tables, full M-Schema is ~9,000 chars. But the real problem is:

- **Schema link section** grows with more candidate columns
- **Join plan section** grows with more FK edges
- **Column glosses** grow linearly with columns
- **Few-shot examples** compete for the same context budget

With a 7B model at 32K context, the effective "SQL generation" budget shrinks as schema context grows. Accuracy drops when the model must attend to a large context window of schema information.

### 3.4 Latency Explosion Points

| Stage | Current (70 tables) | Projected (2000 tables) | Bottleneck |
|-------|-------------------|------------------------|------------|
| Embedding question | ~50ms | ~50ms (unchanged) | — |
| pgvector search | ~20ms | ~100ms (larger index) | Minor |
| FK expansion | ~30ms | ~500ms (dense graph) | **BFS on hub tables** |
| Schema glosses | ~5ms | ~50ms (more columns) | Minor |
| Schema linking | ~10ms | ~200ms (more candidates) | **Keyphrase × column matching** |
| Join planning | ~5ms | ~1000ms (dense FK graph) | **Steiner tree on large graph** |
| LLM generation (K=4) | ~5000ms | ~8000ms (larger prompt) | **Context length × generation** |
| EXPLAIN (×4) | ~200ms | ~400ms | Minor |
| **Total** | **~5.3s** | **~10.3s** | Approaching budget |

### 3.5 New Error Modes at Scale

1. **Table name collision:** Multiple modules may have similarly-named tables (e.g., `sales.orders` vs. `procurement.purchase_orders` vs. `warehouse.transfer_orders`). Current M-Schema doesn't use schema prefixes.

2. **Cross-module join ambiguity:** A question like "total employee costs" could involve HR salary tables, project expense tables, benefit tables, or all three. At 2000 tables, the LLM sees too many plausible paths.

3. **Value ambiguity:** "Show me results for Q1" — is Q1 a quarter, a quality grade, a questionnaire ID, or a warehouse zone? Without value indexing, the LLM guesses.

4. **FK cycles:** Large schemas often have circular FK relationships (e.g., `employees.manager_id → employees.id`). BFS on a cyclic graph without proper handling leads to infinite loops or suboptimal paths.

---

## 4. Proposed Architecture for 2000 Tables

### Variant A: Lightweight / Low-Latency (<10s)

**Philosophy:** Add a coarse routing layer to narrow the search space before existing pipeline.

```
User Question
     │
     ▼
┌─────────────────────────────────────────┐
│ A1. Module Router (NEW)                  │
│   Classify question → 1-3 modules        │
│   Narrow table universe: 2000 → 100-300  │
│   Method: keyword + embedding on module  │
│   glosses (cached)                        │
│   Latency: ~100ms                        │
├─────────────────────────────────────────┤
│ A2. Two-Tier Retrieval (UPGRADED)        │
│   Tier 1: BM25 on table+column names    │
│   within module subset → top-30          │
│   Tier 2: pgvector on narrowed set       │
│   → top-15, threshold 0.25              │
│   Latency: ~200ms                        │
├─────────────────────────────────────────┤
│ A3. Column Pruning (NEW)                 │
│   For each retrieved table, keep only:   │
│   - PK/FK columns (always)              │
│   - Columns matched by schema linker    │
│   - Top-5 by embedding similarity to Q  │
│   Prune: 30 cols/table → 8-12 cols      │
│   Latency: ~50ms                         │
├─────────────────────────────────────────┤
│ A4. Existing Pipeline (UNCHANGED)        │
│   glosses → linker → planner → generate  │
│   → validate → repair → execute          │
│   Latency: ~6000ms                       │
├─────────────────────────────────────────┤
│ Total: ~6.3s (vs current ~5.3s)          │
└─────────────────────────────────────────┘
```

**Stage A1: Module Router**

- **Input:** Question string
- **Output:** 1-3 module IDs, table subset of ~100-300
- **Method:** Pre-compute module-level embeddings (one per module, average of table embeddings). Cosine similarity to question embedding → top modules. Augment with keyword rules (e.g., "invoice" → Procurement, "salary" → HR).
- **Avoids:** Searching all 2000 tables with pgvector. Reduces search space by ~10x before any vector operation.
- **Precomputation:** Module embeddings cached in `rag.module_embeddings` table. Updated only when schema changes.

**Stage A2: Two-Tier Retrieval**

- **Tier 1 (BM25):** Full-text search on table_name, column names, and table_gloss. Fast, catches exact keyword matches that embeddings miss (e.g., "warehouse" matches `warehouses` table directly). Uses PostgreSQL's built-in `tsvector` + `ts_rank`.
- **Tier 2 (pgvector):** Existing cosine similarity, but only on the module-filtered subset. Reduces pgvector query from 2000 rows to 100-300.
- **Score fusion:** Reciprocal Rank Fusion (RRF) — avoids uncalibrated score mixing between BM25 and cosine similarity. Research shows RRF is more robust than weighted linear combination because it operates on rank positions rather than raw scores (which have different scales and distributions).

**Stage A3: Column Pruning**

- For each of the 10-15 retrieved tables, instead of dumping the full M-Schema (potentially 30-50 columns per table), only include:
  - PK and FK columns (always needed for joins)
  - Columns that the schema linker matched to keyphrases
  - Top-5 remaining columns by embedding similarity to the question
- This keeps prompt size manageable even with 15 tables × 50 cols.

**Variant A Expected Accuracy:** ~85-88% (similar to current on the existing 70-table exam; may be slightly lower on cross-module queries due to routing errors)

**Variant A Latency:** ~6-7s total

---

### Variant B: Heavier / Higher-Accuracy

**Philosophy:** Multi-pass approach with pre-SQL, schema verification, and reranking. Higher latency but more robust against retrieval and join errors.

```
User Question
     │
     ▼
┌───────────────────────────────────────────────┐
│ B1. Module Router + Two-Tier Retrieval (A1+A2)│
│   Same as Variant A                           │
│   Output: 15-20 candidate tables              │
│   Latency: ~300ms                             │
├───────────────────────────────────────────────┤
│ B2. Pre-SQL Generation (NEW, RSL-SQL style)   │
│   Generate preliminary SQL without validation │
│   Extract tables/columns referenced           │
│   Feed back to retrieval to add missing tables│
│   Latency: ~2000ms                            │
├───────────────────────────────────────────────┤
│ B3. Schema Verification (NEW)                 │
│   Check: are all referenced tables retrieved? │
│   Check: are all referenced columns real?     │
│   If not → re-retrieve with extracted hints   │
│   Latency: ~200ms                             │
├───────────────────────────────────────────────┤
│ B4. Column Pruning + Glosses + Linker         │
│   Same as Variant A3 + existing stages        │
│   But with refined table set from B3          │
│   Latency: ~100ms                             │
├───────────────────────────────────────────────┤
│ B5. Join Planning (UPGRADED)                  │
│   Module-scoped FK subgraph (precomputed)     │
│   Steiner tree on subgraph only               │
│   Top-3 skeletons with scoring                │
│   Latency: ~50ms                              │
├───────────────────────────────────────────────┤
│ B6. Multi-Candidate Generation (K=4-6)        │
│   With refined schema context                 │
│   Latency: ~4000ms                            │
├───────────────────────────────────────────────┤
│ B7. Candidate Reranker (NEW, Phase 3)         │
│   Schema adherence scoring                    │
│   Join skeleton matching                      │
│   Result-shape checks (expected agg type)     │
│   Optional: small verifier model              │
│   Latency: ~500ms                             │
├───────────────────────────────────────────────┤
│ B8. Validation + Repair + Execute             │
│   Existing pipeline                           │
│   Latency: ~3000ms                            │
├───────────────────────────────────────────────┤
│ Total: ~10-12s                                │
└───────────────────────────────────────────────┘
```

**Stage B2: Pre-SQL Generation (RSL-SQL / CRUSH4SQL Inspired)**

This is the key differentiator. Before the "real" generation pass, generate a quick, unvalidated SQL sketch. **Related approach:** CRUSH4SQL uses an LLM to hallucinate a "minimal schema" (table + column names the model *thinks* are needed) as a bridge to retrieve the *real* schema — the hallucinated schema acts as a query expansion mechanism. Our pre-SQL serves the same role: even if the preliminary SQL is wrong, the table/column references it contains are strong retrieval signals.

1. Send question + coarse schema (table names + glosses only, no columns) to LLM
2. LLM produces a preliminary SQL that references table and column names
3. Parse the preliminary SQL to extract referenced tables and columns
4. Use these as retrieval hints: re-query pgvector with extracted table names as boost terms
5. Add any missing tables to the schema context

This catches the "retrieval miss" failure mode: if the initial retrieval missed `project_budgets`, but the LLM's preliminary SQL references it, we fetch it before the real generation pass.

**Stage B3: Schema Verification**

After pre-SQL, verify that every table and column in the preliminary SQL exists in the schema context:

- If a table is missing → re-retrieve it (or flag as hallucinated)
- If a column is missing → check if it exists in a different retrieved table → suggest correction
- If the question references a value (e.g., "status = 'Active'") → validate against known values if value index exists

This is a lightweight, deterministic check (no LLM call needed).

**Stage B7: Candidate Reranker**

Upgrade the current deterministic scorer with additional signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| EXPLAIN pass | +50 | Existing |
| Schema adherence | +15 | All tables/columns exist in schema context |
| Join skeleton match | +20 | Joins match planner skeleton |
| Result shape | +10 | Aggregation type matches question (count/sum/avg) |
| Value coverage | +5 | Referenced values exist in known value set |
| Lint clean | +25 | No lint errors (existing, inverted) |

**Variant B Expected Accuracy:** ~88-92% (the pre-SQL loop catches retrieval misses that are the dominant failure mode at scale)

**Variant B Latency:** ~10-12s (acceptable if batched or async)

---

### How Both Variants Avoid Dumping 2000 Tables Into the Prompt

The core strategy is **progressive narrowing:**

```
2000 tables
    ↓ module routing (keyword + embedding)
~200 tables
    ↓ two-tier retrieval (BM25 + pgvector)
15-20 tables
    ↓ column pruning (linker + embedding)
15-20 tables × 8-12 cols each = ~200 columns
    ↓ M-Schema rendering
~3000-5000 chars of schema in prompt
```

This is similar to how CHESS processes 200+ tables in the BIRD benchmark: they use a separate "Schema Selector" agent to prune before generation.

---

## 5. TODO Roadmap (Phased)

### Phase 0: Measurement Infrastructure (1-2 days)

| # | Item | Expected Impact | Complexity | Risk |
|---|------|----------------|------------|------|
| 0.1 | **Add retrieval recall metric to exam** — for each question, measure whether gold tables appear in retrieved set | Diagnostic only | Low | None |
| 0.2 | **Add prompt token counting** — log input token count per query to measure prompt budget consumption | Diagnostic only | Low | None |
| 0.3 | **Create synthetic 500-table test database** — generate fake modules (logistics, compliance, R&D, marketing) with plausible FK relationships | Test infrastructure | Medium | Schema design quality |
| 0.4 | **Profile per-stage latency** — break down the 5.3s total into retrieval, glosses, linker, planner, generation, EXPLAIN | Diagnostic only | Low | None |

### Phase 1: Retrieval Upgrades (3-5 days)

| # | Item | Expected Impact | Complexity | Risk |
|---|------|----------------|------------|------|
| 1.1 | **Module router** — classify question to modules before retrieval | Reduces search space 10x; prevents cross-module confusion | Medium | Routing errors (mitigate: allow 2-3 modules) |
| 1.2 | **BM25 tier (tsvector)** — add full-text search on table names + glosses + column names | Catches exact keyword matches that embeddings miss | Medium | Needs index creation; score fusion tuning |
| 1.3 | **RRF (Reciprocal Rank Fusion)** — combine BM25 and cosine similarity via rank-based fusion | Better retrieval precision; avoids uncalibrated score mixing | Low | RRF k-parameter tuning |
| 1.4 | **Column pruning** — trim columns per table to PK/FK + linked + top-5 by similarity | Keeps prompt budget under control at 15+ tables | Medium | Risk of pruning needed columns |
| 1.5 | **Value indexing** (CHESS-style) — index categorical column values for entity linking | Resolves "Q1", "Active", "posted" type ambiguities | High | Storage; maintenance as data changes |

### Phase 2: Join Planning Upgrades (2-3 days)

| # | Item | Expected Impact | Complexity | Risk |
|---|------|----------------|------------|------|
| 2.1 | **Module-scoped FK subgraph caching** — precompute FK subgraphs per module | BFS on 50-table subgraph vs. 2000-table full graph | Medium | Cache invalidation |
| 2.2 | **Hub table handling** — increase `hubFKCap` dynamically based on question relevance | Prevents important FK paths from being capped | Low | May add noise |
| 2.3 | **Join path scoring** — rank join skeletons by semantic relevance (not just hop count) | Better join path selection for ambiguous graphs | Medium | Scoring function design |
| 2.4 | **Cross-module join detection** — detect when question spans modules and merge subgraphs | Handles "employee costs including benefits and project expenses" | Medium | Complexity of merge logic |

### Phase 3: Reranking / Verification (3-5 days)

| # | Item | Expected Impact | Complexity | Risk |
|---|------|----------------|------------|------|
| 3.1 | **Pre-SQL generation** (Variant B) — generate sketch SQL, extract referenced tables, re-retrieve | Catches retrieval misses; +3-5% accuracy | High | Adds ~2s latency; LLM quality of sketch |
| 3.2 | **Schema adherence scorer** — check generated SQL tables/columns against schema context | Penalizes hallucinated columns; already partially in scoring | Medium | May reject valid SQL that uses aliased columns |
| 3.3 | **Join skeleton matcher** — compare generated SQL joins to planner skeletons | Rewards SQL that follows planned joins | Medium | Parser complexity for extracting joins from SQL |
| 3.4 | **Result shape checker** — verify aggregation type (count/sum/avg) matches question | Catches "COUNT when SUM was asked" errors | Low | Heuristic accuracy |
| 3.5 | **Value verification** — after generation, check that WHERE clause values exist in DB | Catches hallucinated filter values | Medium | Adds a query per candidate |
| 3.6 | **Activate candidate_reranker.ts** — wire Phase 3 stub into pipeline | Integrates all scoring signals | Medium | End-to-end testing |

### Phase Priority Matrix

```
Impact ▲
       │  ┌────────────────────────────┐
  HIGH │  │ 1.1 Module Router          │
       │  │ 3.1 Pre-SQL Generation     │
       │  │ 1.2 BM25 Tier             │
       │  └────────────────────────────┘
       │  ┌────────────────────────────┐
  MED  │  │ 1.4 Column Pruning        │
       │  │ 2.1 FK Subgraph Cache     │
       │  │ 3.2 Schema Adherence      │
       │  │ 1.5 Value Indexing        │
       │  └────────────────────────────┘
       │  ┌────────────────────────────┐
  LOW  │  │ 2.2 Hub Handling          │
       │  │ 2.3 Join Scoring          │
       │  │ 3.4 Result Shape          │
       │  └────────────────────────────┘
       └──────────────────────────────────▶ Complexity
            LOW         MEDIUM         HIGH
```

---

## 6. Deep Research Findings

The following findings are organized by topic and sourced from published systems and benchmarks. Question numbers (Q1-Q32) reference the original investigation questions for traceability. Key systems referenced: Gen-SQL, RASL, RSL-SQL, CHESS, CRUSH4SQL, DBCopilot, LinkAlign, Contextual-SQL, Agentar-Scale-SQL, SteinerSQL.

### 6.1 Retrieval & Indexing — Validated Findings

**Recall > precision for schema retrieval (Q1, Q8).** Gen-SQL demonstrates that downstream execution accuracy (EX) correlates more strongly with retrieval *recall* than with precision. Missing a relevant table is far more damaging than including an irrelevant one — the LLM can ignore extra tables but cannot recover missing ones. This validates our "retrieve generously, prune later" philosophy.

**Hybrid BM25+vector beats dense-only (Q1, Q4).** RASL achieves ~94.6% table recall with N=15 using hybrid retrieval, significantly outperforming BM25-only or dense-only baselines. The two signals are complementary: BM25 catches exact keyword matches (e.g., "warehouse" → `warehouses`), while embeddings capture semantic similarity (e.g., "employee costs" → `salary_payments`). Indexing a concatenation of table names + column names + glosses performs best for BM25.

**Use Reciprocal Rank Fusion (RRF) instead of weighted score fusion (Q1).** RRF operates on rank positions rather than raw scores, avoiding the calibration problem of mixing BM25 scores (unbounded) with cosine similarities (0-1). This is more robust across different query types and doesn't require weight tuning on a validation set. Adopted into our architecture in Sections 4 and 5.

**Module/domain routing is a validated decomposition (Q3).** DBCopilot formalizes the idea of a coarse routing step before fine-grained retrieval. Even without trained classifiers, keyword + embedding routing on module-level glosses achieves high accuracy on single-domain questions. Cross-domain queries are handled by allowing 2-3 modules. This validates our Stage A1 design.

**Embedding dimension is NOT the primary lever (Q2).** No published evidence shows that upgrading from 768d to 1024d or 1536d embeddings materially improves schema retrieval recall. The bigger wins come from hybrid retrieval, query rewriting, and better metadata (glosses). Our nomic-embed-text 768d is sufficient if combined with BM25 and good glosses.

**Incremental embedding updates are fine (Q6).** When adding new tables, embedding only the new tables (rather than re-embedding everything) has negligible impact on retrieval quality. Embedding spaces are stable enough that new vectors occupy meaningful positions relative to existing ones. This simplifies our schema update workflow.

**Column-level retrieval noise is a known problem (Q7).** Our V2 retriever regression (53% → 37%) is consistent with literature: retrieving columns independently introduces noise because column names are often ambiguous without table context (e.g., `id`, `name`, `status` appear in many tables). The validated approach is to retrieve *tables* first, then select columns *within* retrieved tables — exactly what our V1 retriever does.

**Value indexing is proven for entity resolution (Q5).** CHESS uses minhash/LSH to index categorical column values, reducing value lookup from "5 minutes to 5 seconds." Agentar-Scale-SQL indexes all textual cell values. For a 2000-table database, the storage overhead is manageable (categorical columns only, not numeric). The index resolves ambiguities like "Q1" (quarter vs. quality grade vs. zone) and "Active" (status vs. boolean). Maintenance is event-driven: re-index a column when its table is modified.

### 6.2 Schema Linking — Validated Findings

**Pre-SQL as a retrieval bridge is well-supported (Q9, Q10).** RSL-SQL, CRUSH4SQL, and Gen-SQL all use a generative bridge step before final SQL generation. The preliminary SQL doesn't need to be correct — it just needs to reference the right tables and columns. Even a 7B model produces useful table/column references when given coarse schema context (table names + glosses only).

**CRUSH4SQL's "hallucinated minimal schema" approach (Q9).** CRUSH4SQL asks the LLM to hallucinate the minimal schema it *thinks* is needed (table + column names), then uses that as a retrieval query to find the real schema. This is conceptually identical to our pre-SQL approach (Variant B, Stage B2) — the hallucinated artifact acts as query expansion for schema retrieval.

**RSL-SQL achieves 94% strict recall while reducing columns by 83% (Q10, Q12).** RSL-SQL's bidirectional schema linking prunes aggressively but retains PK/FK columns unconditionally. This validates our Column Pruning design (Stage A3): keep PK/FK + linker-matched + top-5 by similarity. Schema linking and schema pruning are complementary, not redundant — linking identifies *relevant* elements, pruning removes *irrelevant* ones.

**RSL-SQL hedges with binary selection (Q13).** RSL-SQL generates two SQL candidates — one from full schema, one from simplified/linked schema — and runs a dedicated selection step to pick the better one. This is implemented as a single LLM call that compares both candidates with the question. This validates producing diverse candidate "families" (plan-first vs. direct) and using a selector.

**Deterministic glosses are sufficient for now (Q11).** No published ablation directly compares LLM-generated vs. deterministic glosses. However, RSL-SQL achieves strong results using TA-SQL's `column_meaning.json` (LLM-generated) as an input, suggesting glosses add value. Our deterministic glosses (snake_case split + abbreviation expansion + type hints) cover the most critical cases. LLM-generated glosses are an optional offline enrichment for later — not a prerequisite.

**Unsupported concepts → retrieval expansion first, user clarification second (Q14).** LinkAlign's analysis of "missing target" failures shows that when a concept has no column match, the first response should be to expand retrieval (fetch more tables, try synonym queries). User clarification is a fallback when expansion also fails. This aligns with our pre-SQL approach: if the preliminary SQL references a column that doesn't exist, re-retrieve before giving up.

### 6.3 Join Planning — Validated Findings

**FK graph density varies widely (Q15).** Real enterprise schemas show FK-per-table ratios from 0.14 to 1.76. Some modules are densely connected (HR, finance), while others are sparse (standalone lookup tables). The join planner must be robust to both extremes — dense graphs need aggressive pruning, sparse graphs need fallback heuristic edges.

**Hub tables are empirically real (Q15).** Enterprise schemas consistently show a power-law degree distribution: many low-degree tables (2-3 FKs) and a few high-degree "hub" tables (20-50+ FKs) like `employees`, `departments`, `accounts`. Our `hubFKCap=5` is a valid strategy to prevent BFS explosion, but must be tuned per schema.

**Steiner tree for join planning is increasingly common (Q16).** SteinerSQL formalizes the Steiner tree formulation for SQL join planning. Our current pairwise-shortest-path approximation is a standard approach that works well for small required-table sets (2-4 tables). For larger sets, the approximation quality degrades, but this is acceptable because most NL queries involve 2-4 tables.

**Landmark-based indexing accelerates Steiner approximations (Q16).** Gubichev & Neumann's landmark-based shortest-path indexing can accelerate Steiner tree computations on large graphs. For our 2000-table graph, precomputing shortest paths from ~20-50 landmark nodes (hub tables) would enable sub-millisecond path lookups. This is a Phase 2 optimization.

**Cross-module joins: merge subgraphs on-demand (Q17).** When a question spans modules, merge the relevant module FK subgraphs at query time rather than precomputing all pairwise intersections. The merge is cheap (union of edge sets + deduplication) and only occurs for the 2-3 modules selected by the router.

**Join path disambiguation is a documented problem (Q18, Q19).** When multiple FK paths exist between two tables, scoring paths by (a) FK validity (real FK edges preferred over heuristic), (b) semantic alignment to the question (does the intermediate table match a keyphrase?), and (c) hop count (shorter preferred) produces good disambiguation. Join order in the prompt matters: present the anchor/driving table first, then joins in dependency order.

### 6.4 Generation & Prompt Engineering — Validated Findings

**"Lost in the middle" effect is real (Q20, Q23).** For long prompts, LLMs attend most strongly to the beginning and end, with degraded attention in the middle. Put critical constraints (rules, question) at the beginning and end of the prompt; place schema DDL in the middle. This is consistent with our prompt structure where rules come first and the question comes last.

**Progressive disclosure is validated (Q21).** RSL-SQL, CRUSH4SQL, and Gen-SQL all use a cheap generative step (coarse schema → preliminary SQL) followed by retrieval refinement and then real generation with full DDL. This two-pass approach consistently outperforms one-shot generation with full schema. Our Variant B implements this pattern.

**Temperature diversity is imperfect (Q22).** Better to diversify by *structure* (different join skeletons, aggregation templates, decomposition strategies) rather than relying solely on temperature sampling. Prompt perturbations (alternate schema formatting, alternate join skeleton ordering) produce more meaningfully diverse candidates than temperature alone. This supports our "two-family" generation strategy (plan-first vs. direct).

**Self-consistency style sampling + selection is the proven mechanism (Q22).** Contextual-SQL frames "generate many + select best" as the core mechanism enabling local model competitiveness with API models. The selection step (not the generation step) is where most accuracy gains come from. This validates investing in better scoring/reranking rather than better generation prompts.

### 6.5 Verification & Latency — Validated Findings

**Contextual-SQL's reward model is 32B and requires multi-GPU (Q24).** Not directly usable under our constraints (8GB GPU). However, the *architecture pattern* (generate → execute → score → select) is reproducible. The reward model can be approximated with deterministic scoring signals.

**Deterministic scoring CAN close most of the gap (Q25, Q26).** Schema adherence (all tables/columns exist in schema context) + FK-valid joins + result shape matching + EXPLAIN pass provides strong ranking without an LLM judge. The key insight is *adding more orthogonal signals* — each signal catches a different failure mode. Our current scorer uses lint + EXPLAIN + heuristic bonuses; adding schema adherence and join matching would significantly improve selection.

**Self-correction has diminishing returns (Q27).** After a small bounded number of correction rounds (2-3), additional attempts rarely fix the issue and may introduce new errors. RSL-SQL and DIN-SQL both use self-correction as a final step with 1-2 rounds. Our 3-attempt repair budget is well-calibrated. Correction with EXPLAIN error feedback is nearly as effective as correction with execution feedback.

**<15s is acceptable for ad-hoc analytics (Q31).** Nielsen's 10-second attention threshold means the UI must show progress feedback (streaming status updates), but users tolerate up to 15s for complex analytical queries. The key constraint is **perceived latency**: if users see "analyzing schema... generating SQL... validating..." they'll wait longer than for a spinner. Keep the common case (single-module, 2-3 table queries) under 10s; allow rare complex queries (cross-module, 4+ tables) to approach 12-15s.

**Agentar-Scale-SQL released Light Schema Engine + offline preprocessing (Q32).** The released components include a "light schema" format (compact table/column representation optimized for prompt size) and preprocessing scripts. The light schema format is adaptable to our M-Schema rendering — it reduces token count by ~30% compared to full DDL by omitting constraints and using compact type annotations. The unreleased modules (ICL generators, reasoning generator, iterative refinement, selection) are described in their roadmap but not yet available.

### 6.6 Research-Backed "Best Bet" Configuration

Three highest-ROI upgrades under our constraints (8GB GPU, 7B model, <15s latency):

1. **Routing + hybrid retrieval with RRF.** Retrieval recall drives EX accuracy (Gen-SQL); retrieval-only failures will dominate at scale. Module routing (10x search space reduction) + BM25+vector hybrid (catches both keyword and semantic matches) + RRF fusion (robust without tuning) is the single highest-impact change.

2. **Schema pruning with PK/FK retention.** CHESS and RSL-SQL both validate aggressive column pruning that preserves joinability. At 15-20 tables × 30-50 columns, the prompt budget is the binding constraint. Pruning to PK/FK + linker-matched + top-5 by similarity keeps the prompt manageable while preserving the columns the LLM actually needs.

3. **Retrieval-expansion loop.** Pre-SQL / pseudo-schema / query rewriting to recover missing schema elements before final generation. CRUSH4SQL and RSL-SQL both demonstrate that a cheap first-pass generation (even if wrong) dramatically improves retrieval for the second pass. This is the most effective defense against the "retrieval miss" failure mode that will dominate at 2000 tables.

---

## 7. Appendix: Code Pointers

### Schema Retrieval

| Claim | File | Function/Line |
|-------|------|---------------|
| pgvector top-15 similarity search | `schema_retriever.ts` | `retrieveSimilarTables()` :156 |
| FK expansion with hub capping | `schema_retriever.ts` | `expandFKRelationships()` :228 |
| Hub table detection (fk_degree > 8) | `schema_retriever.ts` | `expandFKRelationships()` :286 |
| Default retrieval config | `schema_types.ts` | `DEFAULT_RETRIEVAL_CONFIG` :171 |
| M-Schema rendering | `schema_types.ts` | `renderMSchema()` :327 |
| Schema block for prompt | `schema_types.ts` | `renderSchemaBlock()` :348 |
| V2 retriever (disabled) | `schema_retriever_v2.ts` | — |
| V2 dual retrieval config | `schema_types.ts` | `DEFAULT_RETRIEVAL_CONFIG_V2` :486 |

### Schema Grounding Pipeline

| Claim | File | Function/Line |
|-------|------|---------------|
| Gloss generation entry point | `schema_glosses.ts` | `generateGlosses()` :316 |
| Single column gloss | `schema_glosses.ts` | `glossColumn()` :202 |
| Abbreviation expansion | `schema_glosses.ts` | `ABBREVIATION_MAP` :44 |
| Type hint inference | `schema_glosses.ts` | `inferTypeHint()` :160 |
| Keyphrase extraction | `schema_linker.ts` | `extractKeyphrases()` :81 |
| Column match scoring | `schema_linker.ts` | `computeMatchScore()` :150 |
| Schema linking entry | `schema_linker.ts` | `linkSchema()` :214 |
| Prompt formatting | `schema_linker.ts` | `formatSchemaLinkForPrompt()` :361 |
| FK graph construction | `join_planner.ts` | `FKGraph` class :56 |
| BFS shortest path | `join_planner.ts` | `findShortestPath()` :117 |
| Steiner tree approximation | `join_planner.ts` | `buildConnectingSubgraph()` :173 |
| Join SQL fragment gen | `join_planner.ts` | `generateSQLFragment()` :218 |
| Join planning entry | `join_planner.ts` | `planJoins()` :272 |
| PG normalization entry | `pg_normalize.ts` | `pgNormalize()` :364 |
| YEAR→EXTRACT transform | `pg_normalize.ts` | `transformDateExtract()` :61 |
| IFNULL→COALESCE transform | `pg_normalize.ts` | `transformCoalesce()` :98 |
| Division safety (NULLIF) | `pg_normalize.ts` | `transformDivisionSafety()` :250 |

### Multi-Candidate Generation

| Claim | File | Function/Line |
|-------|------|---------------|
| Candidate config (K defaults) | `multi_candidate.ts` | `MULTI_CANDIDATE_CONFIG` :109 |
| Difficulty classification | `multi_candidate.ts` | `classifyDifficulty()` :537 |
| Candidate parsing | `multi_candidate.ts` | `parseCandidates()` :321 |
| Deterministic scoring | `multi_candidate.ts` | `scoreCandidate()` :446 |
| EXPLAIN gating | `multi_candidate.ts` | `runExplain()` :635 |
| Full candidate evaluation | `multi_candidate.ts` | `evaluateCandidates()` :688 |
| Parallel generation (Python) | `hrida_client.py` | `generate_candidates_parallel()` |
| Sequential generation (Python) | `hrida_client.py` | `generate_candidates_sequential()` |
| SQL system prompt (non-Hrida) | `config.py` | `SQL_SYSTEM_PROMPT` |
| RAG prompt builder | `config.py` | `build_rag_prompt()` |

### Validation & Repair

| Claim | File | Function/Line |
|-------|------|---------------|
| Structural SQL validation | `sql_validator.ts` | `validateSQL()` |
| SQL linting | `sql_lint.ts` | `lintSQL()` |
| Surgical whitelist entry | `surgical_whitelist.ts` | `processSurgicalWhitelist()` |
| Observe-tier gating | `surgical_whitelist.ts` | `evaluateStrictGating()` |
| Active-tier gating (9 gates) | `surgical_whitelist.ts` | `evaluateActiveGating()` |
| Risk blacklist | `surgical_whitelist.ts` | `checkRiskBlacklist()` |
| Autocorrect | `sql_autocorrect.ts` | `attemptAutocorrect()` |
| SQLSTATE classification | `config.ts` | `SQLSTATE_CLASSIFICATION` :412 |
| Error classification | `config.ts` | `classifyExecutionError()` :514 |
| Repair config | `config.ts` | `REPAIR_CONFIG` :633 |

### Orchestration

| Claim | File | Function/Line |
|-------|------|---------------|
| Main pipeline entry point | `nl_query_tool.ts` | `executeNLQuery()` :123 |
| Schema retrieval dispatch | `nl_query_tool.ts` | lines 184-234 |
| Glosses + linker + planner | `nl_query_tool.ts` | lines 236-292 |
| Bounded repair loop | `nl_query_tool.ts` | lines 294+ |
| Feature flag exports | `config.ts` | lines 78-82 |

### Python Sidecar

| Claim | File | Function/Line |
|-------|------|---------------|
| FastAPI server | `app.py` | `app = FastAPI(...)` :51 |
| Generate SQL endpoint | `app.py` | `@app.post("/generate_sql")` |
| Repair SQL endpoint | `app.py` | `@app.post("/repair_sql")` |
| Embedding endpoint | `app.py` | `@app.post("/embed")` |
| RAG prompt construction | `config.py` | `build_rag_prompt()` |
| Repair prompt construction | `config.py` | `build_rag_repair_prompt()` |
| Ollama generate_sql | `hrida_client.py` | `generate_sql()` :50 |
| Async parallel candidates | `hrida_client.py` | `generate_candidates_parallel()` |
| Deduplication | `hrida_client.py` | `normalize_sql()` |

### Exam & Diagnostics

| Claim | File | Function/Line |
|-------|------|---------------|
| Single exam runner | `scripts/run_exam.ts` | — |
| Multi-run exam runner | `scripts/run_exam_multi.ts` | — |
| Embedding population | `scripts/populate_embeddings.ts` | — |
| Exam log directory | `exam_logs/` | `exam_results_full_*.json` |
| Retrieval JSONL logs | `exam_logs/` | `exam_retrieval_*.jsonl` |

---

## 8. Summary of Key Architectural Decisions

| Decision | Rationale | Risk Mitigation |
|----------|-----------|-----------------|
| Recall-first retrieval strategy | Gen-SQL shows EX correlates with recall, not precision; missing tables can't be recovered | Prune after retrieval (column pruning, schema linking), not during |
| Module routing as first stage | 10x reduction in search space; prevents cross-module confusion | Allow 2-3 modules; fallback to full search on low confidence |
| BM25 + vector hybrid retrieval with RRF | Exact keyword matches + semantic similarity; RRF avoids score calibration issues | RRF k-parameter tuning; RASL validates ~94.6% table recall at N=15 |
| Column pruning per table | Keep prompt under control at 15+ tables × 50+ cols | Always keep PK/FK; include linker-matched columns |
| Pre-SQL for schema verification (Variant B) | Catches retrieval misses that are the dominant failure at scale | Adds ~2s; only enabled for medium/hard questions |
| Module-scoped FK subgraph caching | Avoid BFS on 2000-node graph every query | Cache invalidation on schema change; merge logic for cross-module |
| Deterministic reranker upgrades | Schema adherence + join matching + result shape = stronger without LLM | May reject valid unusual SQL; needs tuning on validation set |
| Value indexing (future) | Resolves entity ambiguity ("Q1", "Active", "posted") | Storage overhead; maintenance burden |

---

## 9. What We Explicitly Do NOT Need

- **Model fine-tuning** — the plan assumes off-the-shelf models only
- **Larger models** — research confirms 7B is viable if retrieval and schema pruning are good (Contextual-SQL's gains come from selection, not model size; RSL-SQL achieves strong results with schema linking, not larger generators). A 14B/32B model may help on hard multi-hop queries but is not the primary lever
- **External APIs** — everything runs locally on Ollama
- **Schema migration** — the existing `rag.*` tables are extended, not replaced
- **Rewriting the pipeline** — every stage is an incremental addition or upgrade to existing code
