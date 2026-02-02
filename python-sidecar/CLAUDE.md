# Python Sidecar - NL2SQL AI Layer

**Last Updated:** 2026-02-02

## Overview

This Python sidecar handles AI-powered SQL generation for the NL2SQL MCP server. It communicates with Ollama/HridaAI to generate SQL from natural language questions.

**Database:** Enterprise ERP (60+ tables, 8 modules)
**Current Success Rate:** 75.0%

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

Key settings in `config.py`:

```python
OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_MODEL = "HridaAI/hrida-t2sql:latest"
OLLAMA_TIMEOUT = 90  # Increased for parallel generation

# Multi-candidate generation uses temperature=0.3 for diversity
# Deduplication happens automatically in generate_candidates_parallel()
```

## Running the Sidecar

```bash
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
```

## Current Performance

With Enterprise ERP database (60 questions):
- **Success Rate:** 75.0%
- **Easy:** 95.0%
- **Medium:** 72.0%
- **Hard:** 53.3%

## Error Analysis (15 failures, 25%)

### 1. Column Name Errors (5 failures, 8.3%)

LLM invents columns not in schema:

| Question | Wrong Column | Likely Correct |
|----------|--------------|----------------|
| Q34: Total spend by vendor | `v.vendor_name` | `v.name` |
| Q37: Debit/credit by account | `b.amount` | Different column |
| Q50: Order value by customer | `c.segment` | Doesn't exist |

**Root cause:** Schema description doesn't clearly communicate column names.

### 2. PostgreSQL Syntax Errors (2 failures)

| Question | Error | Fix |
|----------|-------|-----|
| Q26: Sales by year | `YEAR(date)` function | `EXTRACT(YEAR FROM date)` |
| Q29: Quote conversion | Ambiguous `quote_id` | Needs table qualifier |

**Root cause:** LLM trained on MySQL-style SQL.

### 3. Complex Query Failures (4 failures)

- Multi-step analytics beyond LLM capability
- Window functions (LAG/LEAD)
- Trial balance, cash flow calculations

### 4. Generation Failures (2 failures)

- Model produces gibberish for complex queries
- Fails to generate SELECT statement

## Potential Fixes

| Fix | Target Errors | Effort |
|-----|---------------|--------|
| Add column whitelist to prompt | column_miss (5) | Medium |
| Add PostgreSQL examples (EXTRACT) | syntax (2) | Low |
| Add window function examples | complex analytics (4) | Medium |

See `/STATUS.md` for full metrics.
