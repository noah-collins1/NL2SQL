# Python Sidecar - NL2SQL AI Layer

**Last Updated:** 2026-02-13

## Overview

This Python sidecar handles AI-powered SQL generation for the NL2SQL MCP server. It communicates with Ollama to generate SQL from natural language questions.

**Database:** Enterprise ERP (86 tables / 2,377 tables)
**Current Success Rate:** 88.3% (86-table) / 76.0% (2,377-table) with qwen2.5-coder:7b

## Components

| File | Purpose |
|------|---------|
| `app.py` | FastAPI server with `/generate_sql`, `/repair_sql`, `/embed` endpoints |
| `config.py` | Prompts, schema configuration, repair delta templates |
| `hrida_client.py` | Ollama API client - sync + **async parallel generation** |
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

**Key Implementation (`hrida_client.py`):**

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

## Current Performance

See `../STATUS.md` for current metrics and `../docs/ARCHITECTURE.md` for the full pipeline walkthrough.
