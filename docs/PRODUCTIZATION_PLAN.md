# Plan: Package NL2SQL Repo for Demo & Team Absorption

## Context

The NL2SQL repo works (88.3% on 70 tables, 76% on 2000 tables) but is research-oriented — config is scattered across 30+ env vars and 8 hardcoded objects, setup requires tribal knowledge, and docs are stale or fragmented. The goal is to make it demo-ready and absorbable by other teams: unified config, one-command setup, comprehensive docs.

## Current State (Inventory)

**Config sources (39 unique settings):**
- 30 env vars in TypeScript (`process.env.*` across 15 files)
- 9 env vars in Python (`os.environ`/`os.getenv` in config.py)
- 8 hardcoded config objects in TS (ENTERPRISE_ERP_CONFIG, MULTI_CANDIDATE_CONFIG, SURGICAL_WHITELIST_CONFIG, REPAIR_CONFIG, DEFAULTS, PYTHON_SIDECAR_CONFIG, DEFAULT_RETRIEVAL_CONFIG, reranker weights)
- Prompts hardcoded in Python config.py (base prompt, RAG prompt, 8 repair templates)
- DB password `1219` hardcoded in scripts

**Setup scripts (fragmented across 6 directories):**
- `enterprise-erp/setup_database.sh`, `setup_database_2000.sh`
- `enterprise-erp/rag/run_phase_a.sh`
- `schema_gen/apply_schema.sh`, `data_gen/load_data.sh`
- `mcp-server-nl2sql/scripts/run_exam.ts`, `run_exam_2000.ts`, `populate_embeddings.ts`

**Docs (7 .md files, mix of current and stale):**
- Current: `docs/EVAL_2000_TABLE_RESULTS.md`, `mcp-server-nl2sql/src/CLAUDE.md`, `python-sidecar/CLAUDE.md`
- Stale: `STATUS.md` (shows 75%, actual 88.3%), `NL2SQL_PROCESS_FLOW.md`, `roadmap.md`
- Obsolete: `docs/schema-rag-v2.md`, `docs/schema-rag-v2-integration.md`

**Obsolete code:**
- `schema_retriever_v2.ts` — imported but never called (USE_SCHEMA_RAG_V2 defaults false)
- `mcp-servers/` — Smithery reference servers, not part of NL2SQL
- `enterprise-erp/migrations/001_embeddings_v2.sql` — V2 migration

---

## Phase 1: YAML Config System

**Goal:** Single config file read by both TS and Python; env vars override YAML.

### 1A. Create config files

| File | Purpose |
|------|---------|
| `config/config.yaml` | Defaults (committed). All 39 settings organized into sections. |
| `config/config.example.yaml` | Copy of config.yaml with comments — safe template for users. |
| `.env.example` | Secret template: `DB_PASSWORD=`, `OLLAMA_MODEL=`, etc. |

**YAML structure** (sections):
```
database:        # host, port, name, user, password (empty → env)
model:           # llm, embedding, provider, ollama_url, timeout, num_ctx
generation:      # temperature, max_tokens, sequential, candidates (enabled, k, k_easy, k_hard, max_explain, timeouts)
retrieval:       # top_k, threshold, max_tables, fk_expansion_limit, hub_fk_cap
features:        # 16 boolean flags (glosses, pg_normalize, linker, planner, bm25, router, pruning, reranker, etc.)
repair:          # max_attempts, confidence_penalty, surgical_whitelist (full sub-tree)
validation:      # max_limit, require_limit, max_joins
sidecar:         # url, timeout_ms, join_hint_format
exam:            # mode, log_dir
logging:         # level
```

### 1B. TypeScript config loader

**New file:** `mcp-server-nl2sql/src/config/loadConfig.ts`
- **Dependency:** `js-yaml` (add to package.json)
- Reads `config/config.yaml` → merges `config/config.local.yaml` (if exists) → overlays env vars
- Exports typed `NL2SQLConfig` object
- Env override mapping: `DB_PASSWORD` → `database.password`, `OLLAMA_MODEL` → `model.llm`, etc.
- **All existing `process.env.X` reads still work** — the loader checks env vars with the same names as today for backward compatibility

**Modify:** `mcp-server-nl2sql/src/config.ts`
- Import from `loadConfig.ts`
- Replace hardcoded CONFIG objects with values from loaded config
- **Keep existing exported interfaces unchanged** — downstream code doesn't change

**Modify each feature flag file** (minimal touch — one line per file):
- `bm25_search.ts`, `module_router.ts`, `column_pruner.ts`, `join_planner.ts`, `schema_glosses.ts`, `schema_linker.ts`, `pg_normalize.ts`, `candidate_reranker.ts`, `pre_sql.ts`, `multi_candidate.ts`
- Change `process.env.X !== "false"` → `getConfig().features.x` (with env fallback)

### 1C. Python config loader

**New file:** `python-sidecar/config_loader.py`
- **Dependency:** `pyyaml` (add to requirements.txt)
- Same YAML path resolution as TS (looks up from cwd to find `config/`)
- Returns dict matching YAML structure
- Env overrides with same var names as today

**Modify:** `python-sidecar/config.py`
- Import from `config_loader.py`
- Replace `os.environ.get("OLLAMA_MODEL", "HridaAI/...")` with config dict lookups
- **Keep all prompt constants in config.py** — they're too large for YAML and rarely changed

### 1D. Update .gitignore

Add: `config/config.local.yaml`, `.env`, `data_gen/output/`, `schema_gen/generated_divisions.sql`, `mcp-server-nl2sql/exam_logs/`

---

## Phase 2: Cleanup & Deprecation

### 2A. Move obsolete files to `deprecated/`

```
deprecated/
  schema_retriever_v2.ts
  schema-rag-v2.md
  schema-rag-v2-integration.md
  mcp-servers/          ← entire reference server collection
  README.md             ← note explaining what's here and why
```

### 2B. Remove V2 code path from nl_query_tool.ts

- Remove `import { ... } from "./schema_retriever_v2.js"`
- Remove `USE_SCHEMA_RAG_V2` conditional block (~20 lines)
- Remove `USE_SCHEMA_RAG_V2` from config.ts

### 2C. Externalize secrets

- Replace hardcoded `1219` in `enterprise-erp/setup_database.sh`, `setup_database_2000.sh`, `debug_single.ts`, `run_exam_2000.ts`
- Use `${DB_PASSWORD:-1219}` in shell, config loader in TS

### 2D. Update STATUS.md

Replace with current: 88.3% (70-table), 76.0% (2000-table), link to `docs/EVAL_2000_TABLE_RESULTS.md`

### 2E. Fix missing dependencies

- Add `aiohttp>=3.9.0` to `python-sidecar/requirements.txt`
- Add `pyyaml>=6.0` to `python-sidecar/requirements.txt`
- Add `js-yaml` to `mcp-server-nl2sql/package.json`

---

## Phase 3: Setup Scripts

**All scripts go in repo root `scripts/`.**

### 3A. `scripts/setup-deps.sh`
- Check: PostgreSQL (`psql`), Node.js (>=18), Python (>=3.10), Ollama (warn if missing)
- Install: `npm install` in mcp-server-nl2sql/, create venv + pip install in python-sidecar/
- Pull Ollama model if Ollama present

### 3B. `scripts/setup-db.sh`
- Args: `--db=70` (default) or `--db=2000`
- Sources `.env` for credentials
- Creates DB, loads schema + data, sets up RAG schema, populates embeddings
- Wraps existing scripts — does NOT replace them
- Idempotent: skips steps if already done (checks `\dt` for tables, embeddings count)

### 3C. `scripts/start-sidecar.sh`
- Activates venv, starts sidecar with config from YAML
- Checks health endpoint, exits with clear error if Ollama unreachable
- Provides PID file for clean shutdown

### 3D. `scripts/run-exam.sh`
- Args: `--db=70|2000`, `--max=N`, `--runs=N`
- Checks sidecar health first, auto-starts if needed
- Runs appropriate exam script, prints summary

### 3E. `scripts/demo.sh`
- One-command demo: `./scripts/demo.sh`
- Runs: setup-deps → setup-db (70-table) → start-sidecar → run-exam (10 questions)
- Shows results + "next steps" message
- Total time: ~5 minutes

---

## Phase 4: Documentation

### 4A. Root `README.md` — Complete rewrite
- What this is (1 paragraph)
- Performance table (70-table: 88.3%, 2000-table: 76%)
- Architecture diagram (ASCII)
- Quick Start (3 commands: clone, demo.sh, done)
- Project structure (directory tree with 1-line descriptions)
- Links to all docs/

### 4B. `docs/PIPELINE.md` — Stage-by-stage walkthrough
- ASCII flow diagram
- 7 stages: Module Routing → Schema Retrieval → Prompt Construction (glosses + linker + planner) → SQL Generation (multi-candidate) → Validation (structural + EXPLAIN + scoring) → Repair (surgical whitelist) → Post-processing (PG normalize + reranker)
- For each stage: purpose, inputs/outputs, key config, key functions (with file:line), failure modes
- Feature flag table at the end

### 4C. `docs/CONFIG.md` — YAML config reference
- Precedence explanation (ENV > local YAML > default YAML)
- Every key documented: type, default, description, env var override name
- Common scenarios: small GPU, large DB, production tuning

### 4D. `docs/ADDING_A_DATABASE.md`
- Step-by-step: create DB → introspect schema → create RAG tables → generate embeddings → write exam templates → run exam
- Full worked example with a small DB

### 4E. `docs/MODELS.md`
- Tested models table (qwen2.5-coder 88.3%, llama3.1 81.7%, Hrida 74.4%)
- How to swap LLM (config change + restart)
- How to swap embeddings (config change + re-embed)
- Model-specific quirks (sequential for 8GB, temp=0.3 required, Hrida system prompt)

### 4F. `docs/EXAMS.md`
- Available exams (60-question regression, 300-question full)
- Template format (from templates.yaml)
- Running exams (commands)
- Interpreting results (failure categories, per-tag breakdown)
- Creating custom exams

### 4G. `docs/TROUBLESHOOTING.md`
- Sidecar issues (not running, code changes not applying, connection refused)
- DB issues (connection, missing embeddings, search_path)
- Model issues (OOM, temp=0.0 bug, Ollama not found)
- Known bugs (retrieved_tables reporting, sidecar persistence)

### 4H. `docs/REFACTOR_PLAN.md`
- Top 5 performance hotspots (retrieval latency, EXPLAIN blocking, embedding gen speed)
- Top 5 code clarity improvements (config consolidation, error types, prompt centralization)
- Low-risk refactors (remove dead V2 code, consolidate prompt templates)

---

## Phase 5: Code Quality

### 5A. Targeted comments
- `nl_query_tool.ts` — section headers for the main loop stages
- `surgical_whitelist.ts` — clarify two-tier gating flow
- `hrida_client.py` — document parallel vs sequential generation

### 5B. Consistency pass
- Ensure all shell scripts have `set -euo pipefail`
- Ensure all scripts have usage/help text
- Consistent error message format across scripts

---

## Implementation Order

```
Phase 1 (Config)     ← Must be first, everything depends on it
  1A config files
  1B TS loader + integrate
  1C Python loader + integrate
  1D .gitignore

Phase 2 (Cleanup)    ← Can overlap with Phase 1 tail end
  2A-2E (all independent, do in order)

Phase 3 (Scripts)    ← After Phase 1 (scripts read config)
  3A setup-deps.sh
  3B setup-db.sh
  3C start-sidecar.sh
  3D run-exam.sh
  3E demo.sh

Phase 4 (Docs)       ← Can start after Phase 1, finalize after Phase 3
  4A README (finalize after scripts exist)
  4B PIPELINE.md
  4C CONFIG.md (after Phase 1)
  4D-4H (independent)

Phase 5 (Quality)    ← Last
  5A-5B
```

## Verification

After each phase:
1. **Phase 1:** Run `EXAM_MODE=true npx tsx scripts/run_exam.ts` — must still pass at 88.3%
2. **Phase 2:** `git grep schema_retriever_v2` returns only deprecated/ hits
3. **Phase 3:** `./scripts/demo.sh` works on clean checkout (after `dropdb enterprise_erp`)
4. **Phase 4:** External reader can follow README → demo in <10 minutes
5. **Final:** Full 60-question exam passes at >=85%

## Files Created (New)

```
config/config.yaml
config/config.example.yaml
.env.example
mcp-server-nl2sql/src/config/loadConfig.ts
python-sidecar/config_loader.py
scripts/setup-deps.sh
scripts/setup-db.sh
scripts/start-sidecar.sh
scripts/run-exam.sh
scripts/demo.sh
deprecated/README.md
README.md (root — rewrite)
docs/PIPELINE.md
docs/CONFIG.md
docs/ADDING_A_DATABASE.md
docs/MODELS.md
docs/EXAMS.md
docs/TROUBLESHOOTING.md
docs/REFACTOR_PLAN.md
```

## Files Modified

```
mcp-server-nl2sql/package.json          ← add js-yaml
mcp-server-nl2sql/src/config.ts         ← use loaded config
mcp-server-nl2sql/src/nl_query_tool.ts  ← remove V2 import
mcp-server-nl2sql/src/bm25_search.ts    ← config integration (1 line)
mcp-server-nl2sql/src/module_router.ts  ← config integration (1 line)
mcp-server-nl2sql/src/column_pruner.ts  ← config integration (1 line)
mcp-server-nl2sql/src/join_planner.ts   ← config integration (1 line)
mcp-server-nl2sql/src/schema_glosses.ts ← config integration (1 line)
mcp-server-nl2sql/src/schema_linker.ts  ← config integration (1 line)
mcp-server-nl2sql/src/pg_normalize.ts   ← config integration (1 line)
mcp-server-nl2sql/src/candidate_reranker.ts ← config integration (1 line)
mcp-server-nl2sql/src/pre_sql.ts        ← config integration (1 line)
mcp-server-nl2sql/src/multi_candidate.ts ← config integration (1 line)
mcp-server-nl2sql/scripts/debug_single.ts ← externalize password
mcp-server-nl2sql/scripts/run_exam_2000.ts ← externalize password
python-sidecar/config.py                ← use config_loader
python-sidecar/requirements.txt         ← add pyyaml, aiohttp
enterprise-erp/setup_database.sh        ← source .env for password
enterprise-erp/setup_database_2000.sh   ← source .env for password
.gitignore                              ← add config.local.yaml, .env, output dirs
STATUS.md                               ← update performance numbers
```

## Files Moved to `deprecated/`

```
mcp-server-nl2sql/src/schema_retriever_v2.ts
docs/schema-rag-v2.md
docs/schema-rag-v2-integration.md
docs/MSCHEMA_REGRESSION_ANALYSIS.md
mcp-servers/ (entire directory)
```
