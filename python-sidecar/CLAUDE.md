# Python Sidecar - NL2SQL AI Layer

**Last Updated:** 2026-02-26

## Overview

This Python sidecar handles AI-powered SQL generation for the NL2SQL MCP server. It communicates with Ollama to generate SQL from natural language questions.

**Databases:**
- Enterprise ERP (2,377 tables) — **90.7% (272/300)** with qwen2.5-coder:7b on V1 300-question exam
- Industry-Erp (883 tables) — **91.1% (72/79)** with qwen2.5-coder:7b
- V2 500-question exam: **84.3% SQL / 79.4% overall** (Phase 0 baseline was 73.3%)

## Components

| File | Purpose |
|------|---------|
| `app.py` | FastAPI server with `/generate_sql`, `/repair_sql`, `/embed` endpoints |
| `config.py` | Prompts, schema configuration, repair delta templates |
| `ollama_client.py` | Ollama API client — sync, async, parallel + sequential multi-candidate generation |
| `keyword_filter.py` | Stage 1 table filtering by keywords |
| `semantic_validator.py` | Semantic validation (entity extraction, hallucination detection) |

## API Endpoints

### POST /generate_sql
Generate SQL from natural language question.

```json
{
  "question": "Which employees have pending leave requests?",
  "database_id": "enterprise_erp",
  "schema_context": { ... },  // From TypeScript Schema RAG
  "multi_candidate_k": 4      // Optional: generate K candidates in parallel
}
```

**Multi-Candidate Response:**
```json
{
  "sql_generated": "SELECT ...",  // First/best candidate
  "sql_candidates": ["SELECT ...", "SELECT ...", ...],  // Deduplicated candidates
  ...
}
```

### POST /repair_sql
Repair failed SQL with error context.

```json
{
  "question": "...",
  "database_id": "enterprise_erp",
  "previous_sql": "SELECT ...",
  "postgres_error": {
    "sqlstate": "42703",
    "message": "column \"foo\" does not exist",
    "minimal_whitelist": { ... }  // For targeted column repair
  },
  "attempt": 2,
  "max_attempts": 3
}
```

### POST /embed
Generate embeddings for text (used by Schema RAG).

### GET /health
Health check endpoint.

## Parallel Multi-Candidate Generation

When `multi_candidate_k > 1`, the sidecar generates K candidates **in parallel** using async HTTP calls.

**Architecture:**
```
Request (k=4) → generate_candidates_parallel()
                    │
                    ├─ async call 1 (temp=0.3) ─┐
                    ├─ async call 2 (temp=0.3) ─┤
                    ├─ async call 3 (temp=0.3) ─┼─→ Gather Results
                    └─ async call 4 (temp=0.3) ─┘
                                                │
                    ┌───────────────────────────┘
                    ▼
              Deduplicate by normalized SQL
                    │
                    ▼
              Return sql_candidates[]
```

**Key Implementation (`ollama_client.py`):**

```python
async def generate_candidates_parallel(
    self,
    prompt: str,
    k: int = 4,
    temperature: float = 0.3,  # For diversity
    max_tokens: int = 200
) -> List[Tuple[str, float]]:
    """Generate K SQL candidates in parallel with deduplication."""

    async with aiohttp.ClientSession() as session:
        tasks = [
            self.generate_sql_async(prompt, temperature, max_tokens, session)
            for _ in range(k)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    # Deduplicate by normalized SQL
    seen = set()
    candidates = []
    for sql, confidence in results:
        normalized = normalize_sql(sql)
        if normalized not in seen:
            seen.add(normalized)
            candidates.append((sql, confidence))

    return candidates
```

**Why Parallel Instead of Delimiter-Based:**

| Approach | Pros | Cons |
|----------|------|------|
| Single call + delimiter | 1 LLM call | LLM ignores delimiter format |
| **Parallel calls** | Clean output, robust | K LLM calls (but parallel) |

The parallel approach is more reliable because:
1. Each call returns a single, clean SQL statement
2. No parsing of delimiters needed
3. Temperature=0.3 provides natural variation
4. If one call fails, others still work

## Prompt Architecture

### Base + Delta Pattern

The prompt is composed of:
1. **Base prompt** (static) - Schema, rules, question
2. **Delta blocks** (per-attempt) - Error context, repair instructions

```python
# Compose: base + deltas (never mutate base)
full_prompt = base + "\n\n" + "\n\n".join(delta_blocks)
```

### Repair Delta Templates

**REPAIR_DELTA_POSTGRES** - PostgreSQL error context
```
## PostgreSQL Error
SQLSTATE: {sqlstate}
Message: {message}
{column_candidates_section}
```

**REPAIR_DELTA_MINIMAL_WHITELIST** - Targeted column repair
```
## Column Whitelist for `{resolved_table}`
Use only these exact column names: {primary_columns}
- Do not invent columns
- If you need a concept not present, join a table that has it
```

## Configuration

Settings are loaded from `config/config.yaml` via `config_loader.py`. Key values:

```python
OLLAMA_MODEL = "qwen2.5-coder:7b"      # From config or OLLAMA_MODEL env var
OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_TIMEOUT = 90                      # Covers multi-candidate generation
```

See `../docs/CONFIG.md` for the full reference.

## Running the Sidecar

```bash
# Recommended: use the setup script
../scripts/start-sidecar.sh --bg

# Or manually:
cd python-sidecar
source venv/bin/activate
python app.py
# Runs on http://localhost:8001
```

## Dependencies

```
fastapi
uvicorn
requests
aiohttp     # For async parallel generation
pydantic
pyyaml      # Config loader
```

## CTE Support (Fixed 2026-02-26)

CTEs (`WITH cte_name AS (...)`) were being rejected as "Model did not generate SELECT statement". Three locations were fixed:

1. **`ollama_client.py` line ~135 (sync)** — candidate-level SELECT check:
   ```python
   upper = sql.upper().lstrip()
   if not (upper.startswith("SELECT") or re.match(r'WITH\s+\w+\s+AS\s*\(', upper)):
       raise OllamaClientError("Model did not generate SELECT statement")
   ```

2. **`ollama_client.py` line ~361 (async)** — same fix in `generate_sql_async`

3. **`sql_validation.ts` Rule 1 NO_SELECT** — TypeScript validator also accepts `WITH` prefix now

Also: `max_tokens` increased from 200 → 500 everywhere in `app.py` to prevent CTEs from being truncated mid-OVER-clause.

## Known Bugs / Pending Fixes

### CRITICAL: `\n\n` stop token was removed — causes V1 regression

**Status: NOT FIXED — must restore next session**

Removing `\n\n` from stop tokens caused V1 regression: 90.7% → 85.0% (+21 execution errors). The model generates more elaborate/verbose SQL with wrong column names when not stopped at blank lines.

**Fix needed in `ollama_client.py`:**
```python
# Sync path (~line 85): restore \n\n
stop_tokens = ["\n\n"] if multi_candidate else [";", "\n\n"]

# Async path (~line 326): restore \n\n
"stop": [";", "\n\n"],
```

**Why this is safe**: qwen2.5-coder CTEs do NOT contain `\n\n` internally. They were truncating due to `max_tokens=200`, not the `\n\n` stop token. Now that `max_tokens=500`, CTEs will generate fully without needing to remove `\n\n`.

### `module: null` causes 422 validation errors

Some `rag.schema_embeddings` rows have `module = NULL`. The sidecar's Pydantic model rejects null module in `schema_context`, causing 422 errors. Affects 9 questions in V2 exam.

**Fix**: `UPDATE rag.schema_embeddings SET module = 'general' WHERE module IS NULL;` on the affected DB.

### EXCEPT / UNION operations — low success rate

V2 exam: EXCEPT 10%, UNION 22%. Model rarely uses set operations correctly. Needs prompt guidance.

### CTE patterns — 8/19 fail

Two repeating templates fail:
- "Turnover rate" — scalar subquery returns multiple rows
- "Working capital ratio" — inline ratio fails validation

### Timeout on complex queries

11 V2 questions exceed 30s. All are complex: UNION 3+ tables, pivot, year-over-year. Sequential candidates × repairs × complex prompts exceed timeout.

## Current Performance

See `../STATUS.md` for current metrics and `../docs/ARCHITECTURE.md` for the full pipeline walkthrough.
