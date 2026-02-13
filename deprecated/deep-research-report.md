# Implementable Architecture Recommendations from Top BIRD Text-to-SQL Entries for a Local Postgres ERP NL2SQL System

## Executive Summary

- Your dominant plateau failures (column hallucination/42703, multi-hop joins, PostgreSQL dialect slips) align closely with what the BIRD leaderboard’s best “systems” try to solve: **better grounding**, **better planning**, and **stronger inference-time selection/verification**. citeturn17view0turn19view0turn37search0turn6view0  
- The most “copyable without retraining” blueprint from a top local BIRD entry is **generate many → execute/filter → score/rerank → select**, exemplified by Contextual-SQL’s open pipeline (even though their published run requires very large GPUs). citeturn15view0turn32search3turn32search5turn36search0  
- For schema grounding specifically, the most actionable repo-level pattern is: **(a) produce/attach semantic column glosses** (TA-SQL’s `column_meaning.json`) + **(b) run an explicit schema-linking stage** (RSL-SQL’s multi-step “pre-SQL → schema linking → augmented generation → selection → self-correction”). citeturn19view0turn37search0  
- For complex joins, the strongest implementable system-level addition for your stack is a **join-planner module** that enumerates top-K join graphs from FK metadata (and optionally “soft edges”), and then **forces candidates to use one of those join skeletons** (plan-then-generate). This directly targets your “3+ joins/accounting-style” bucket without ERP-specific hacks. citeturn6view0turn37search0  
- For PostgreSQL dialect issues, the most reliable win is to treat dialect as a deterministic compilation step: **AST-parse → normalize → re-emit Postgres SQL**, and only then run EXPLAIN/execute/repair. (This is independent of which base model you run.) citeturn19view0turn6view0  
- A minimal-risk incremental plan is: **Phase 1** tighten grounding + deterministic PG normalization; **Phase 2** add join planning + plan-first prompting; **Phase 3** add a lightweight local verifier/reranker + execution-guided selection loop modeled after BIRD SOTA pipelines. citeturn15view0turn37search0turn6view0turn19view0  

## BIRD Systems Table

The table below focuses on high-performing BIRD leaderboard entries (overall systems and single-model track) that have public repos and/or runnable artifacts, and flags what is *actually reproducible from GitHub today* (as opposed to “paper-only” or “partial release”). Leaderboard scores come from the official BIRD page. citeturn17view0turn16view0

| System / track (BIRD) | BIRD Test EX | Team | Public repo / artifacts | What it uses (as described publicly) | Reproducibility rating |
|---|---:|---|---|---|---|
| Agentar-Scale-SQL (overall leaderboard) | 81.67 | entity["company","Ant Group","fintech company"] | GitHub repo with code + partial modules released | “Orchestrated Test-Time Scaling”; contains “Light Schema Engine” + offline preprocessing; roadmap explicitly lists unreleased modules (ICL generators, reasoning generator, iterative refinement, selection, etc.). citeturn18view0turn17view0 | **C** (top score, but partial system release) |
| AskData + GPT-4o (overall leaderboard) | 81.95 | entity["company","AT&T","telecom company"] | Paper link on leaderboard; no public runnable system code in BIRD page | Proprietary model dependency; not a “local, no-training” reproduction target. citeturn16view0turn17view0 | **D** (not reproducible locally) |
| Contextual-SQL (overall leaderboard) | 75.63 | entity["company","Contextual AI","ai company"] | Full pipeline repo + HF models | Two-stage “generate candidates → select best,” with execution filtering + a reward model that scores SQL candidates. Repo specifies generator as Qwen2.5-Coder-32B-Instruct and reward model download steps. citeturn15view0turn32search3turn36search0turn17view0 | **B** (code + weights, but published run needs very large GPUs) |
| CHESS (overall leaderboard variants) | 66.53 (one config shown in R‑VES list) | entity["organization","Stanford University","university california"] | Full pipeline repo | Multi-agent framework: Information Retriever, Schema Selector, Candidate Generator, Unit Tester; explicit preprocessing to build minhash/LSH/vector DB for value retrieval; supports swapping LLM by editing a specific function. citeturn6view0turn17view0 | **B** (code is there; you must plug in your LLM/runtime) |
| RSL-SQL + DeepSeek-v2 (overall leaderboard) | 65.51 | (anonymous on leaderboard entry) | Full pipeline repo with step scripts | End-to-end multi-step scripts for preprocessing, preliminary SQL, bidirectional schema linking, augmented generation, binary selection, self-correction; requires external LLM API configured in `config.py`; pulls column glosses from TA-SQL output. citeturn37search0turn17view0 | **B-** (code exists; exact model endpoints not packaged) |
| OpenSearch-SQL (overall leaderboard) | 72.28 EX on test (claimed in repo README), 69.36 R‑VES on leaderboard list | entity["organization","OpenSearch-AI","open source org"] | GitHub repo with run scripts | Repo README claims structured CoT + SQL-like intermediate language + “Alignment” to reduce hallucination; includes preprocess + main scripts; uses dynamic few-shot and consistency alignment. citeturn36search6turn17view0 | **B-** (good signs; exact inference stack still needs inspection/config) |
| XiYan-SQL (overall leaderboard) | 75.63 | entity["company","Alibaba Cloud","cloud computing unit"] | “XiYan-SQL” GitHub repo (mostly documentation/links) | Repo presents framework description and links to separate model repos (XiYanSQL-QwenCoder) and tools (MCP server, schema format, etc.), but the “core ensemble system” code is not present in this repo as listed. citeturn14view0turn17view0turn21view2 | **C/D** (valuable components, but missing end-to-end BIRD system code) |
| TA-SQL + GPT-4 (single-model track list) | 59.14 | (HKU on leaderboard) | Full repo | “Before Generation, Align It”: Task-Aligned Schema Linking + Task-Aligned logical synthesis; generates `column_meaning.json` glosses; configured for Azure/OpenAI backends. citeturn19view0turn17view0 | **B** (very implementable module ideas; backend-dependent) |
| DAIL-SQL + GPT-4 (single-model track list) | 57.41 | (Alibaba Group on leaderboard) | Full repo | Prompt-engineering + few-shot example selection; uses SQL “skeleton similarity” idea and optional self-consistency; relies on external LLM calls. citeturn37search1turn17view0 | **B-** (reproducible prompting pipeline; not specialized for your PG schema grounding) |
| DIN-SQL + GPT-4 (single-model track list) | 55.90 | entity["organization","University of Alberta","university edmonton canada"] | Full repo with BIRD script | Decomposed in-context learning with self-correction; repo includes a BIRD entry script (`DIN-SQL_BIRD.py`) and minimal run instructions. citeturn20view2turn17view0 | **B-** (simple to emulate; depends on LLM quality) |
| Arctic-Text2SQL-R1-7B (single trained model track) | 70.43 | entity["company","Snowflake","data cloud company"] | Paper + HF weights (and training-related repos) | Single-model track entry; paper claims strong BIRD leaderboard performance and describes the model family; weights exist on HF (per BIRD leaderboard metadata and paper). citeturn17view0turn3search27 | **B** (as a model drop-in; not a system repo) |
| Prem-1B-SQL (single-model track list) + PremSQL library | 51.54 | entity["company","Prem AI","ai company"] | PremSQL repo + HF/Ollama mentions | Local-first Text-to-SQL library; supports multiple connectors including local runtimes; explicitly mentions Ollama support and a Prem-1B-SQL release. citeturn21view0turn17view0 | **A-** (most immediately runnable locally; lower BIRD score) |

### Ranked list of “most reproducible” systems to emulate

This ranking blends (a) **how complete the public implementation is** and (b) **how directly it maps to your constraints (no finetuning, local, Postgres, ~10s latency)**.

1. **PremSQL (library approach) + a stronger local generator**: best “drop-in” reproducibility and already treats Text-to-SQL as a pipeline with executors and correction loops; you can swap the generator to a stronger model than Prem-1B-SQL. citeturn21view0turn17view0  
2. **CHESS**: end-to-end system repo, includes explicit schema/value retrieval preprocessing and a modular way to plug your own LLM by changing `get_llm_chain(...)`. citeturn6view0  
3. **RSL-SQL (for schema-linking + selection loop structure)**: the public scripts provide a clear, multi-stage skeleton (pre-SQL, schema linking, augmentation, selection, self-correction) that closely matches what you need to fix 42703 and join grounding—though you’ll replace their API-based LLM calls with your local Ollama route. citeturn37search0  
4. **Contextual-SQL (for “reward-model reranking + execution filtering” design)**: the repo is open and includes a reward model artifact, but the published run targets multi-GPU 80GB environments; you can still reproduce the architecture pattern at smaller scale. citeturn15view0turn32search3turn36search0  
5. **Agentar-Scale-SQL**: excellent leaderboard result, but the repo’s own roadmap indicates critical modules were not yet released at the time described; treat it more as a blueprint/partial component source. citeturn18view0turn17view0  

## Deep Dives

### Contextual-SQL

#### What they do

Contextual-SQL is explicitly framed as a **two-stage system**: generate many SQL candidates with strong context, then select the best candidate using filtering/ranking, demonstrating “inference-time scaling.” citeturn32search5  
The open repo implements this as a four-stage pipeline: (1) candidate generation, (2) SQL execution, (3) reward-model scoring, and (4) analysis/selection. citeturn15view0turn36search0  

#### Repo structure and key files

The repo is small and intentionally “script-first.” The top-level structure includes `few_shots/` and `src/`. citeturn15view0turn36search0  

Key file paths (as named in the repo’s run commands):

- `src/prep_data.py` (downloads/preprocesses BIRD dev data into JSONL and schema artifacts). citeturn15view0turn36search0  
- `src/generate.py` (candidate generation; launched with `--input_file ... --output_dir ... --num_gpus ...`). citeturn15view0turn36search0  
- `src/process_sqls.py` (executes candidates with a timeout and filters; designed to run in parallel with generation). citeturn15view0turn36search0  
- `src/reward.py` (scores candidate SQL with a reward model). citeturn15view0turn36search0  
- `src/analysis.py` (selects the best candidate for final output; requires many CPUs in their benchmark setting). citeturn15view0turn36search0  

The important implementable “interface boundary” is that *everything past generation* consumes a JSONL of candidates and adds signals (execution results, reward scores) before final selection. citeturn15view0turn36search0  

#### Models used

- Generator model: Qwen2.5-Coder-32B-Instruct (downloaded into `models/generator`). citeturn15view0turn36search0  
- Reward model: `ContextualAI/ctx-bird-reward-250121`, described as the scoring component: finetuned from Qwen-2.5-32B-Instruct to score execution correctness of SQL candidates given schema + NL query. citeturn32search3turn15view0  

#### Reproduction steps

The repo provides direct reproduction commands:

```bash
pip install -r requirements.txt
mkdir -p models/generator
huggingface-cli download Qwen/Qwen2.5-Coder-32B-Instruct --local-dir models/generator

mkdir -p models/reward
huggingface-cli download sheshansh-ctx/ctx-bird-reward-250121 --local-dir models/reward

python src/prep_data.py

python src/generate.py --input_file data/test_all.jsonl --output_dir output/generations/ --num_gpus 2
python src/process_sqls.py --input_file data/test_all.jsonl --generations_dir output/generations/ --output_dir output/with_results/ --compare_against_gt --sql_timeout 30.0
VLLM_USE_V1=0 python src/reward.py --input_file output/with_results/data_with_results.jsonl --output_dir output/with_rewards --num_gpus 2
python src/analysis.py --rewards_dir output/with_rewards --gt_sql_file data/test_gold_sqls.txt --output_dir output/analysis --num_cpus 100
```  

These commands and the stated hardware note (2+ 80GB GPUs) are in the repo README. citeturn15view0turn36search0  

#### How they prevent column hallucination (what is explicit vs implied)

What is explicit:

- They **execute candidates** and treat timeouts/errors as a filtering signal before later steps. citeturn15view0turn36search0  
- They use a **reward model trained to rank candidate SQL correctness**; this is explicitly described as scoring execution correctness given schema + NL query. citeturn32search3  

What is implied (not fully spelled out in the repo README):

- The biggest practical anti-hallucination mechanism is not constrained decoding, but **“generate a lot + filter invalid + rerank well.”** That idea is explicitly discussed in their blog as “power of inference-time scaling,” but exact prompting templates are not fully surfaced in the repo README text we can access from the BIRD page. citeturn32search5turn15view0  

#### Key ideas to steal for your stack

- Add a **dedicated candidate scoring component** (even if not a huge 32B reward model) and allow it to dominate final selection—because your current deterministic scoring may be underpowered against semantic schema mismatches. The reward-model concept is explicitly part of the public artifact set. citeturn32search3turn15view0  
- Treat execution (or at least EXPLAIN) as a *first-class ranking feature*, not only as a repair trigger. Contextual-SQL runs execution before scoring. citeturn15view0turn36search0  

### CHESS

#### What they do

CHESS is a multi-agent Text-to-SQL framework with four specialized agents:

- Information Retriever (IR)  
- Schema Selector (SS)  
- Candidate Generator (CG)  
- Unit Tester (UT)

The README explicitly ties these agents to the practical bottlenecks: large catalogs/values, reasoning over large schemas, functional validity, and NL ambiguity. citeturn6view0  

#### Repo structure and key files

The repo includes:

- `run/` (shell scripts like `run_preprocess.sh`, different main configurations)  
- `src/` (implementation)  
- `templates/` (prompt templates)  
- `data/dev/` (dev dataset layout)  

This structure and the run entrypoints are in the README + file tree displayed on the repo root page. citeturn6view0  

One concrete code pointer given by the authors for extensibility:

- `run/langchain_utils.py` contains `get_llm_chain(engine, temperature, base_uri=None)`; you add your own LLM by modifying that function. citeturn6view0  

#### Reproduction steps

CHESS provides:

- `.env` config with dataset paths and an index server host/port, plus an OpenAI API key placeholder. citeturn6view0  
- Preprocessing script: `sh run/run_preprocess.sh`, which builds minhash/LSH/vector databases for retrieval over DB catalogs/values. citeturn6view0  
- Main execution scripts: `sh run/run_main_ir_cg_ut.sh` or `sh run/run_main_ir_ss_ch.sh` (different agent configurations). citeturn6view0  

#### How they handle correctness checks

What is explicit in repo documentation:

- UT “validates queries through LLM-based natural language unit tests.” citeturn6view0  
- They emphasize functional validity as a first-class challenge and put UT as a dedicated module. citeturn6view0  

What is missing/unclear from the repo text we can access:

- The exact mechanics of UT (what unit tests look like, whether they execute SQL or only do LLM-based consistency checks) are not fully specified in the README text shown on the root page. citeturn6view0  

#### Key ideas to steal for your stack

- **Separate “schema pruning/selection” from generation.** This matches your plateau: RAG + FK expansion is helpful, but CHESS treats schema selection as its own agent with explicit budget reduction. citeturn6view0  
- **Index values, not just schema.** Their preprocessing creates minhash/LSH/vector databases to retrieve “most similar database values,” which is often necessary for real enterprise schemas where values encode meaning (“posted”, “draft”, “void”, account types, etc.). citeturn6view0  
- **Unit-test style verification as a *computation budget knob*.** Your ~10s budget can allow a small number of UT checks on top candidates rather than on all K. citeturn6view0  

### RSL-SQL

#### What they do

RSL-SQL is explicitly positioned as “Robust Schema Linking” and presents a pipeline that goes beyond one-shot schema retrieval: it runs **preliminary SQL generation**, then **bidirectional schema linking**, then **information augmentation**, then **binary selection** and **self-correction**. The repo provides step-by-step scripts for each phase. citeturn37search0  

#### Repo structure and key files (module-by-module)

The repo’s README enumerates a clear staging and file outputs; these map cleanly to modules you can reimplement in your TypeScript/Python split:

- Configuration:
  - `src/configs/config.py` (includes `dev_databases_path`, `dev_json_path`, and API/base_url settings). citeturn37search0  

- Data preprocessing:
  - `src/data_construct.py` (constructs `ppl_dev.json`). citeturn37search0  
  - `few_shot/construct_QA.py` and `few_shot/slg_main.py` (build and select few-shot examples). citeturn37search0  
  - `src/information/add_example.py` (adds selected examples to the working dataset). citeturn37search0  

- Preliminary SQL + initial schema linking artifacts:
  - `src/step_1_preliminary_sql.py` outputs `src/sql_log/preliminary_sql.txt` and `src/schema_linking/LLM.json`. citeturn37search0  

- Bidirectional schema linking:
  - `src/bid_schema_linking.py` produces `src/schema_linking/sql.json`, `hint.json`, and `schema.json`. citeturn37search0  
  - `src/information/add_sl.py` injects schema linking results back into the working dataset. citeturn37search0  

- Generation with information augmentation:
  - `src/step_2_information_augmentation.py` outputs a second SQL log plus `src/information/augmentation.json`. citeturn37search0  
  - `src/information/add_augmentation.py` merges augmentation into the dataset. citeturn37search0  

- Candidate selection + refinement:
  - `src/step_3_binary_selection.py` compares earlier SQLs and writes `src/sql_log/step_3_binary.txt`. citeturn37search0  
  - `src/step_4_self_correction.py` produces final SQL (`src/sql_log/final_sql.txt`). citeturn37search0  

#### Data structures and external assets

RSL-SQL explicitly pulls in two grounding assets that matter for your 42703 problem:

- A sentence-transformers checkpoint (all-mpnet-base-v2) placed in `few_shot/sentence_transformers/`. citeturn37search0  
- A `column_meaning.json` file pulled from TA-SQL outputs and placed into `data/`. citeturn37search0turn19view0  

This strongly suggests their schema linking is enhanced by **semantic column descriptions**, not just raw names—exactly the gap you observed where fuzzy matching fails for lexically distant columns. citeturn19view0turn37search0  

#### Repro status (what’s available vs missing)

What is available:

- A complete step-by-step pipeline with scripts and explicit intermediate artifacts. citeturn37search0  

What is missing or requires substitution:

- The “LLM” backend is configured via `api` and `base_url` in config; the repo does not package a local model runtime—so you must rewire calls to your Ollama-sidecar. citeturn37search0  
- The README does not provide a single “docker run” or one-command reproduction; it requires assembling multiple downloaded files (dev tables/json, databases, train parquet). citeturn37search0  

#### Key ideas to steal

- **Pre-SQL as a schema-linking tool.** Generating a preliminary SQL (even if imperfect) before final SQL is a powerful way to surface candidate tables/columns and then run a focused schema linking pass. This matches your “no candidate close match” hallucinations: you need an intermediate artifact to *diagnose the missing concept* before generation. citeturn37search0  
- **Binary selection between two “styles” of SQL.** Even without training, you can produce two diverse candidate families (e.g., “aggregation-first” vs “join-first”) and then run a dedicated selector prompt or deterministic ranker. RSL-SQL bakes this into the pipeline as an explicit stage. citeturn37search0  
- **Column meaning/glossary as a first-class artifact.** TA-SQL’s `column_meaning.json` is explicitly intended for reuse and directly referenced by RSL-SQL. citeturn19view0turn37search0  

## Proposed Architecture for Your System

This section is written for: **TypeScript orchestrator (MCP)** + **Python sidecar** + **Postgres**, local inference (Ollama or equivalent), no finetuning, ≤~10s typical.

### Pipeline diagram

```text
User NL question
   |
   v
(1) Query analysis + intent ops extraction (TS)
   |
   v
(2) Hybrid schema linking (TS -> Py for embeddings/LLM check)
     - table/column retrieval (embeddings + lexical + FK expansion)
     - column concept grounding + "schema contract" JSON
   |
   v
(3) Join planner (TS)
     - build join graph from PG FKs
     - enumerate top-N join trees connecting required tables
     - emit join skeletons (SQL fragments) + justification
   |
   v
(4) Plan-then-generate K candidates (TS -> Py/Ollama)
     - force use of allowed tables/columns
     - include join skeleton options
     - generate diversified candidates (K=4..6)
   |
   v
(5) Static validation + dialect normalization (TS)
     - parse SQL AST, verify schema IDs, qualify columns
     - rewrite to Postgres-safe constructs
   |
   v
(6) Execution-guided verifier loop (TS)
     - EXPLAIN (FORMAT JSON) per candidate (fast)
     - optional limited execution (statement_timeout + LIMIT)
     - targeted repair prompt on failures
   |
   v
(7) Deterministic scoring + rerank (TS + optional small verifier model)
     - hard filters (schema-valid, parses, EXPLAIN ok)
     - soft score (semantic match, join plausibility, op coverage)
     - optional local reranker/reward model
   |
   v
Final SQL (+ debug trace + grounded schema map)
```

Design note: this is heavily inspired by (a) Contextual-SQL’s generate→execute→score→select skeleton, (b) RSL-SQL’s explicit schema-linking and selection stages, and (c) CHESS’s explicit value/schema retrieval modules. citeturn15view0turn37search0turn6view0turn32search3  

### Stage-by-stage specification

#### Schema linking and column grounding

Your current “schema RAG” is necessary but not sufficient; the missing piece is an explicit **grounding decision artifact** that downstream stages are forced to respect.

**Data you should precompute (offline, per DB):**

- `table_doc[table]`: table name + (optional) generated description + rowcount estimate.  
- `column_doc[table.col]`:  
  - raw names and types  
  - FK relationships (“col references …”)  
  - a short natural-language gloss (auto-generated)  
  - a few representative values (sampled)  
- `embedding(table_doc)`, `embedding(column_doc)` stored in pgvector (you already do something similar).

TA-SQL’s repo shows a concrete precedent for generating a column meaning glossary (`column_meaning.json`) and explicitly frames descriptive column metadata as part of its hallucination mitigation strategy. citeturn19view0  

RSL-SQL explicitly consumes TA-SQL’s `column_meaning.json` and uses it as an input artifact for schema linking. citeturn37search0turn19view0  

**Online algorithm (per question): hybrid linking with a “schema contract”**

1. Retrieve top-T tables by embedding similarity to the question (and optionally to extracted keyphrases).  
2. Expand via FK neighborhood (your current FK expansion).  
3. Retrieve top-C columns from those tables by embedding similarity *and* lexical matching (BM25/trigram).  
4. Run a *grounding pass* to produce a JSON contract:

```json
{
  "required_tables": ["..."],
  "required_columns": [
    {"concept": "vendor name", "column": "vendors.name", "confidence": 0.82},
    {"concept": "actual amount", "column": "payments.amount", "confidence": 0.74}
  ],
  "unsupported_concepts": ["..."],
  "dialect": "postgres"
}
```

This “schema contract” is the same conceptual role as RSL-SQL’s explicit schema linking artifacts and CHESS’s schema selector stage: a **pruned, grounded sub-schema** that generation must not violate. citeturn37search0turn6view0  

**Critical enforcement rule**

- If generation produces a column not in the DB schema, you do *not* jump immediately to fuzzy rewrite.  
- Instead: (a) map it to the nearest *concept* in the schema contract (embedding match among allowed columns), or (b) declare it unsupported and regenerate with a constraint.  

This addresses your “no_candidates (semantic mismatch)” observation—because the mapping space becomes the *semantic column_doc space*, not the raw identifier set.

#### Join path discovery

You need a deterministic join planner that can hand the model valid “join skeletons” for 3+ hop cases.

**Precompute (offline):**

- A join graph `G` where nodes are tables and edges are FK relationships with metadata:
  - `(from_table, from_col) -> (to_table, to_col)`
  - cardinality hints if available (optional; can be estimated later)

**Online (per question):**

- Input: `required_tables` (from schema contract)  
- Output: top-N join trees connecting them (N small, e.g., 3–5)

Use a constrained graph search:

- Prefer FK edges over any heuristic edges.  
- Penalize edges that create cycles unless required.  
- Enumerate simple paths and then compute a minimum connecting subgraph (Steiner-tree style approximation) by joining paths pairwise.

This “join reasoning as an explicit module” is consistent with RSL-SQL’s philosophy of producing more structured intermediate artifacts prior to final SQL selection and refinement. citeturn37search0  

#### Candidate generation strategy

Model-side constraints matter most in two situations:

- when the schema contract is narrow (few tables/columns)  
- when the question demands multi-hop joins and aggregate logic.

**K strategy (fits ~10s latency):**

- K = 4 candidates total, split into two “families”:
  - Family A (K=2): *plan-first* (outputs a structured plan then SQL)  
  - Family B (K=2): *direct SQL with join skeleton provided*  

This mirrors two independent “perspectives,” similar in spirit to multi-view selection systems discussed by top entries (e.g., orchestration/scaling systems) but kept lightweight. citeturn18view0turn32search5  

**Diversification knobs:**

- Temperatures: `[0.2, 0.4]` for plan-first; `[0.0, 0.3]` for direct.  
- Prompt perturbations:
  - alternate schema formatting (compact DDL vs “column meaning” format)  
  - alternate join skeleton ordering

#### Deterministic scoring and reranking

You already have deterministic scoring; the upgrade is to add *more orthogonal signals* that specifically punish your failure modes.

Hard filters:

- AST parses successfully (your “sql lint”).  
- All tables/columns exist in actual schema.  
- EXPLAIN succeeds (fast correctness gate).  

Soft score (weighted sum):

- **Schema adherence**: fraction of referenced columns that are in schema contract.  
- **Join plausibility**: join skeleton matches one of top-N planned join trees.  
- **Operator coverage**: question ops extracted vs SQL ops present (GROUP BY, window, date filters).  
- **Error-rate priors**: penalize ambiguous unqualified columns; penalize SELECT *; penalize implicit joins.

Optional learned reranker/verifier:

- If you can afford one extra model call, do a “pick best candidate” judge step on the top 2–3 candidates. Contextual-SQL demonstrates that a dedicated scorer can be decisive. citeturn32search3turn15view0  

If you cannot run a large reward model locally, you can still mimic the pattern: a small fast model that outputs a relative ranking with a strict rubric.

#### Execution-guided verification loop

You already run EXPLAIN and repair. The main upgrades:

- Run EXPLAIN as a *rank feature* as well as a validity gate (Contextual-SQL executes before scoring). citeturn15view0turn36search0  
- For multi-candidate: only fully execute the top 1–2 candidates after EXPLAIN passes for all K, to stay within the latency budget.

### Pseudocode for critical stages

#### Schema linking and grounding (hybrid retrieval + contract)

```python
def build_schema_contract(question: str, schema_index, fk_graph) -> dict:
    keyphrases = extract_keyphrases(question)  # noun phrases + metrics + dates

    # 1) table retrieval
    table_hits = schema_index.search_tables(question, top_k=12)

    # 2) FK expansion (bounded)
    tables = expand_fk_neighbors(table_hits, fk_graph, max_hops=2, cap=25)

    # 3) column retrieval (embedding + lexical)
    col_hits = []
    for phrase in [question] + keyphrases:
        col_hits += schema_index.search_columns(phrase, restrict_tables=tables, top_k=20)

    # 4) consolidate + score by compatibility
    grounded = []
    for phrase in keyphrases:
        candidates = rerank_cols_for_phrase(phrase, col_hits)  # heuristic + optional reranker
        best = candidates[0]
        grounded.append({"concept": phrase, "column": best.fq_col, "confidence": best.score})

    # 5) detect unsupported concepts
    unsupported = [g["concept"] for g in grounded if g["confidence"] < 0.55]

    return {
        "required_tables": select_tables_from_grounding(grounded),
        "required_columns": grounded,
        "unsupported_concepts": unsupported,
        "dialect": "postgres",
    }
```

Why this is implementable without training: “column meaning” is built once per schema (TA-SQL shows the artifact format; RSL-SQL consumes it), and online linking is retrieval + deterministic scoring + optional lightweight judge. citeturn19view0turn37search0  

#### Join path discovery (top-N join trees)

```python
def enumerate_join_trees(required_tables: list[str], fk_graph, top_n=5):
    # Build shortest paths between each pair
    pair_paths = {}
    for a, b in combinations(required_tables, 2):
        pair_paths[(a, b)] = k_shortest_fk_paths(fk_graph, a, b, k=3)  # BFS with caps

    # Build candidate trees by combining paths
    candidates = []
    for choice in cartesian_product_of_paths(pair_paths):
        edges = union_edges(choice)
        if connects_all(required_tables, edges):
            score = join_tree_cost(edges)  # fewer hops + FK edges + penalize cycles
            candidates.append((score, edges))

    candidates.sort(key=lambda x: x[0])
    return candidates[:top_n]
```

#### Candidate scoring (hard filters + weighted features)

```python
def score_candidate(sql: str, schema, contract, join_trees, explain_ok, exec_ok, error_msg=None):
    if not parses(sql): return -1e9
    if not schema_valid(sql, schema): return -1e9
    if not explain_ok: return -1e9

    feats = {}
    feats["contract_adherence"] = pct_cols_in_contract(sql, contract)
    feats["join_match"] = join_tree_match_score(sql, join_trees)
    feats["op_coverage"] = op_coverage(sql, contract, question_ops(contract))
    feats["pg_safety"] = pg_safety_penalty(sql)  # unqualified cols, YEAR(), etc.
    feats["execution_bonus"] = 1.0 if exec_ok else 0.0

    return (
        3.0 * feats["contract_adherence"] +
        2.0 * feats["join_match"] +
        1.5 * feats["op_coverage"] -
        1.0 * feats["pg_safety"] +
        0.5 * feats["execution_bonus"]
    )
```

### Direct mapping to your dominant errors

#### Column hallucination and schema mismatch (42703)

Beyond fuzzy matching, use *three layers*:

- **Semantic column glossary**: generate and store “column meaning” text (TA-SQL’s `column_meaning.json` is a concrete artifact format) and embed that, not just raw identifiers. citeturn19view0  
- **Schema contract enforcement**: generation must choose from an “allowed list” (contract), otherwise the candidate is rejected and repaired/regenerated with constraints (mirrors RSL-SQL’s explicit schema linking and later selection loop). citeturn37search0  
- **Verifier-based rejection**: if a candidate invents a column that your retrieval did not surface, treat it as a “concept mismatch” and force the model to either map it to one of the top semantic candidates or mark it unsupported and choose an alternate formulation. This is a practical analogue of “selection models” and reward-based scoring used in top systems. citeturn32search3turn37search0  

#### Complex joins (multi-hop)

- **Join planner output becomes part of context**: provide 3–5 candidate join skeletons (as explicit ON clauses) and require the LLM to choose one.  
- **Plan-first prompt**: force the model to first list tables and join keys (fully qualified) before emitting SQL; this reduces “invented join links” and often reduces alias ambiguity. (CHESS and RSL-SQL both emphasize structured intermediate steps before final output, though via different mechanisms.) citeturn6view0turn37search0  
- **Binary selection stage**: generate two families (aggregation-first vs join-first) and run a dedicated selector prompt/rule-based ranking; RSL-SQL has an explicit “binary selection” step you can emulate. citeturn37search0  

#### PostgreSQL dialect issues

- Add a deterministic “PG compile” stage:

  - rewrite `YEAR(date)` → `EXTRACT(YEAR FROM date)`  
  - auto-qualify ambiguous columns when multiple tables contain same name  
  - normalize date literals and casting  
  - ensure window function syntax is valid for Postgres  

This is cheap, model-agnostic, and prevents wasted repair loops on purely syntactic issues.

### Latency analysis and caching

Below is a realistic target to stay within ~10s typical latency on a local deployment with K=4 candidates and EXPLAIN-based verification. Numbers are estimates; the key is *where caching removes variance*.

- Offline cache (one-time per schema):
  - schema introspection + FK graph: cached in TS memory or Redis  
  - embeddings for tables/columns/glosses: cached in pgvector (you already do this)  
  - sampled values index: cached (optional)  

- Online per query:
  - Stage (1) query analysis: ~5–20ms  
  - Stage (2) schema linking retrieval (pgvector): ~20–80ms (mostly DB latency)  
  - Stage (3) join planning (graph search on 70 tables): ~1–10ms  
  - Stage (4) generate K=4 local candidates: dominant cost (e.g., ~5–8s depending on model size/quantization)  
  - Stage (5) parse + PG normalization: ~5–30ms per candidate  
  - Stage (6) EXPLAIN for K candidates: ~30–200ms each (depends on DB), can run concurrently with a pool  
  - Stage (7) rerank + optional small judge: ~50–300ms  

Total typical: **~6–10s** if generation is the bottleneck and you parallelize EXPLAIN across candidates (or pipeline EXPLAIN as candidates arrive), matching your acceptable budget.

## Implementation Roadmap

### Phase 1

Low-effort, likely gains (days):

- Add a **hard schema-validity filter**: parse SQL, verify every `table.column` exists, and automatically qualify ambiguous columns before you ever run EXPLAIN. (This prevents avoidable 42703 and “ambiguous column” churn.)  
- Implement **deterministic Postgres normalization** as a final compile step (YEAR→EXTRACT, casts, LIMIT patterns).  
- Build “column meaning” glosses once and embed them; even if you start with a purely heuristic gloss (split snake_case + include type + FK target), this is still stronger than raw identifiers for semantic mismatches (mirrors the motivation behind TA-SQL’s column meaning artifact). citeturn19view0  

### Phase 2

Moderate effort (1–2 weeks):

- Implement the **schema contract** output and enforce it during generation + repair.  
- Add the **join planner** (top-N join trees) and update prompts to require selecting one skeleton.  
- Add “two-family generation” (plan-first vs direct) and a **binary selector** stage (RSL-SQL provides a concrete precedent for a dedicated selection step between candidate sets). citeturn37search0  

### Phase 3

Bigger changes (2–4 weeks):

- Add an **explicit scorer/reranker** model call. If you can’t run a large reward model, implement a small verifier that compares (question + contract schema + candidate SQL) and outputs a calibrated score. Contextual-SQL demonstrates the leverage of a dedicated reward scorer. citeturn32search3turn15view0  
- Add **value retrieval indexing** (CHESS-style) for categorical columns and high-signal values; integrate retrieved values into the generation context when the question references statuses/types/names. citeturn6view0  
- Add “unit-test” verification on the top 1 candidate (or top 2), e.g., generate a small set of assertions (counts should be non-negative, date ranges, etc.) and execute subqueries where safe.

## Risks / Unknowns / What’s missing from repos

- Several top leaderboard systems are not fully reproducible from public code because either (a) they rely on proprietary models/services or (b) the repo is a partial release. Agentar-Scale-SQL’s repo itself includes a roadmap indicating major modules were planned for later release beyond the schema engine and preprocessing. citeturn18view0turn17view0  
- XiYan-SQL’s primary repo is largely documentation and pointers to related repos (models, schema format, MCP server). That is still useful for components, but it does not expose a full end-to-end implementation of the ensemble framework in the repo content shown. citeturn14view0turn21view2  
- For Contextual-SQL, the architecture is clear and the reward model is published, but the repo’s documented run requires extremely large GPU resources (2×80GB GPUs) and very high CPU parallelism for analysis. You’ll be emulating the design, not reproducing their throughput/hardware setup. citeturn15view0turn36search0turn32search3  
- CHESS’s README clearly describes the agent roles and provides preprocess/run scripts, but the essential verification details of the Unit Tester are not fully specified in the README snippet alone, so you should treat UT as an architectural pattern and implement a “minimal UT” first (e.g., LLM generates 2–3 checks + targeted SQL probes). citeturn6view0  
- RSL-SQL provides very detailed step scripts, but the exact behavior of their “LLM schema linking artifact” and how it’s combined with other schema signals is only inferable from code beyond the README; empirically, you’ll need to re-derive the intended logic when porting into your TS orchestrator. citeturn37search0  

## Appendix: Links and citations

Official BIRD leaderboard (overall + single-model track): citeturn17view0turn16view0  

Key repos and artifacts referenced:

- Contextual-SQL pipeline repo: citeturn15view0turn36search0  
- Contextual-SQL reward model card (scoring component): citeturn32search3  
- Contextual-SQL blog overview (architecture rationale): citeturn32search5  
- CHESS repo (multi-agent framework): citeturn6view0  
- RSL-SQL repo (step-by-step schema linking + selection pipeline): citeturn37search0  
- TA-SQL repo (column meaning glossary + hallucination mitigation framing): citeturn19view0  
- DAIL-SQL repo (few-shot prompting + selection ideas): citeturn37search1  
- DIN-SQL repo (decomposition + self-correction; includes BIRD script): citeturn20view2  
- Agentar-Scale-SQL repo (top-score, partial release + roadmap): citeturn18view0turn17view0  
- OpenSearch-SQL repo (dynamic few-shot + alignment approach): citeturn36search6  
- XiYan-SQL documentation repo and model repo pointer: citeturn14view0turn21view2  
- Arctic-Text2SQL-R1 paper (single-model track family): citeturn3search27turn17view0  
- PremSQL library repo (local-first pipelines; Ollama mentioned): citeturn21view0turn17view0  

Primary baseline context for BIRD goals (external knowledge / efficiency emphasis shown on the official BIRD site): citeturn32search4