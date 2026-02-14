# Configuration Reference

All NL2SQL settings live in `config/config.yaml`. Override with `config/config.local.yaml` (gitignored) or environment variables.

**Precedence:** ENV > config.local.yaml > config.yaml

## Quick Setup

```bash
# Copy template
cp config/config.example.yaml config/config.local.yaml

# Edit secrets
vi config/config.local.yaml   # Set database.password, etc.
```

## Full Reference

### database

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `host` | string | `localhost` | `DB_HOST` | PostgreSQL host |
| `port` | int | `5432` | `DB_PORT` | PostgreSQL port |
| `name` | string | `enterprise_erp` | `ACTIVE_DATABASE` / `DB_NAME` | Database name |
| `user` | string | `postgres` | `DB_USER` | Database user |
| `password` | string | `""` | `DB_PASSWORD` | Database password |

### model

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `llm` | string | `qwen2.5-coder:7b` | `OLLAMA_MODEL` | Ollama model tag |
| `embedding` | string | `nomic-embed-text` | `EMBEDDING_MODEL` | Embedding model |
| `provider` | string | `ollama` | — | LLM provider |
| `ollama_url` | string | `http://localhost:11434` | `OLLAMA_BASE_URL` | Ollama API URL |
| `timeout` | int | `90` | `OLLAMA_TIMEOUT` | LLM timeout (seconds) |
| `num_ctx` | int | `0` | `OLLAMA_NUM_CTX` | Context window (0 = model default) |
| `sql_system_prompt` | string | *(see yaml)* | `SQL_SYSTEM_PROMPT` | System prompt for non-Hrida models |

### generation

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `temperature` | float | `0.3` | `TEMPERATURE` | LLM temperature. Must be >0 for diversity |
| `max_tokens` | int | `512` | — | Max output tokens |
| `sequential` | bool | `false` | `SEQUENTIAL_CANDIDATES` | Sequential generation (set true for 8GB GPU) |

#### generation.candidates

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `enabled` | bool | `true` | `MULTI_CANDIDATE_ENABLED` | Enable multi-candidate |
| `k_default` | int | `4` | `MULTI_CANDIDATE_K` | Default K |
| `k_easy` | int | `2` | `MULTI_CANDIDATE_K_EASY` | K for easy questions |
| `k_hard` | int | `6` | `MULTI_CANDIDATE_K_HARD` | K for hard questions |
| `max_explain` | int | `4` | `MULTI_CANDIDATE_MAX_EXPLAIN` | Max parallel EXPLAIN |
| `max_execute` | int | `1` | `MULTI_CANDIDATE_MAX_EXECUTE` | Max candidates to execute |
| `time_budget_ms` | int | `10000` | `MULTI_CANDIDATE_TIME_BUDGET_MS` | Total time budget |
| `explain_timeout_ms` | int | `2000` | `MULTI_CANDIDATE_EXPLAIN_TIMEOUT_MS` | Per-EXPLAIN timeout |

### retrieval

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `top_k` | int | `15` | — | Max tables from similarity search |
| `threshold` | float | `0.25` | — | Minimum similarity threshold |
| `max_tables` | int | `10` | — | Max tables in final context |
| `fk_expansion_limit` | int | `3` | — | Max FK expansion hops |
| `hub_fk_cap` | int | `5` | — | Max FK edges for hub tables |

### features

All feature flags. See [PIPELINE.md](PIPELINE.md) for what each does.

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `glosses` | bool | `true` | `SCHEMA_GLOSSES_ENABLED` | Schema glosses |
| `pg_normalize` | bool | `true` | `PG_NORMALIZE_ENABLED` | PG dialect normalization |
| `schema_linker` | bool | `false` | `SCHEMA_LINKER_ENABLED` | Keyphrase→column matching |
| `join_planner` | bool | `false` | `JOIN_PLANNER_ENABLED` | FK graph join planning |
| `join_planner_top_k` | int | `3` | `JOIN_PLANNER_TOP_K` | K-shortest paths |
| `fk_subgraph_cache` | bool | `true` | `FK_SUBGRAPH_CACHE_ENABLED` | FK subgraph caching |
| `dynamic_hub_cap` | bool | `true` | `DYNAMIC_HUB_CAP_ENABLED` | Dynamic hub table caps |
| `join_path_scoring` | bool | `true` | `JOIN_PATH_SCORING_ENABLED` | Multi-factor path scoring |
| `cross_module_join` | bool | `true` | `CROSS_MODULE_JOIN_ENABLED` | Cross-module join detection |
| `bm25` | bool | `true` | `BM25_SEARCH_ENABLED` | BM25 tsvector search |
| `module_router` | bool | `true` | `MODULE_ROUTER_ENABLED` | Module routing |
| `reranker` | bool | `true` | `CANDIDATE_RERANKER_ENABLED` | Candidate reranker |
| `value_verification` | bool | `false` | `VALUE_VERIFICATION_ENABLED` | DB value verification |

### repair

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_attempts` | int | `3` | Max repair loop iterations |
| `confidence_penalty` | float | `0.1` | Confidence penalty per attempt |
| `explain_timeout` | int | `2000` | EXPLAIN timeout (ms) |

The `repair.surgical_whitelist` section contains detailed sub-config for the two-tier column repair gating. See `config/config.yaml` for the full tree.

### validation

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_limit` | int | `1000` | Maximum LIMIT value |
| `require_limit` | bool | `true` | Require LIMIT on queries |
| `max_joins` | int | `10` | Maximum JOIN count |

### sidecar

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `url` | string | `http://localhost:8001` | `PYTHON_SIDECAR_URL` | Sidecar URL |
| `timeout_ms` | int | `30000` | — | Sidecar request timeout |
| `join_hint_format` | string | `edges` | `JOIN_HINT_FORMAT` | Join hint format |

### exam

| Key | Type | Default | Env Var | Description |
|-----|------|---------|---------|-------------|
| `mode` | bool | `false` | `EXAM_MODE` | Enable exam logging |
| `log_dir` | string | `exam_logs` | — | Exam log directory |

## Common Scenarios

### Small GPU (8GB)

```yaml
# config/config.local.yaml
generation:
  sequential: true     # One candidate at a time
  candidates:
    k_default: 2       # Fewer candidates
    k_hard: 4
model:
  num_ctx: 16384       # Smaller context window
```

### Large Database (2000+ tables)

```yaml
# config/config.local.yaml
database:
  name: enterprise_erp_2000
features:
  schema_linker: true   # Helps narrow column usage
  join_planner: true    # Required for complex joins
```

### Production Tuning

```yaml
# config/config.local.yaml
repair:
  max_attempts: 4       # More repair budget
generation:
  candidates:
    k_default: 6        # More candidates for accuracy
    k_hard: 8
```
