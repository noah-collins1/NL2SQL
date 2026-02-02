# Python Sidecar - NL2SQL AI Layer

**Last Updated:** 2026-02-02

## Overview

This Python sidecar handles AI-powered SQL generation for the NL2SQL MCP server. It communicates with Ollama/HridaAI to generate SQL from natural language questions.

**Database:** Enterprise ERP (60+ tables, 8 modules)

## Components

| File | Purpose |
|------|---------|
| `app.py` | FastAPI server with `/generate_sql`, `/repair_sql`, `/embed` endpoints |
| `config.py` | Prompts, schema configuration, repair delta templates |
| `hrida_client.py` | Ollama API client (HridaAI/hrida-t2sql) |
| `keyword_filter.py` | Stage 1 table filtering by keywords |
| `semantic_validator.py` | Semantic validation (entity extraction, hallucination detection) |

## API Endpoints

### POST /generate_sql
Generate SQL from natural language question.

```json
{
  "question": "Which employees have pending leave requests?",
  "database_id": "enterprise_erp",
  "schema_context": { ... }  // From TypeScript Schema RAG
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

```json
{
  "texts": ["employee salaries", "department budget"]
}
```

### GET /health
Health check endpoint.

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

**REPAIR_DELTA_MINIMAL_WHITELIST** - Targeted column repair (NEW)
```
## Column Whitelist for `{resolved_table}`
Use only these exact column names: {primary_columns}
- Do not invent columns
- If you need a concept not present, join a table that has it
```

## Semantic Validator

Catches cases where SQL is syntactically valid but semantically wrong:

1. **Entity Extraction** - Finds company names, values mentioned in question
2. **Intent Classification** - "which state" → lookup_state intent
3. **Hallucination Detection** - Values in SQL not mentioned in question
4. **Auto-Repair** - Triggers repair with semantic issues

## Configuration

Key settings in `config.py`:

```python
OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_MODEL = "HridaAI/hrida-t2sql:latest"
OLLAMA_TEMPERATURE = 0.0  # Deterministic
OLLAMA_TIMEOUT = 60
```

## Running the Sidecar

```bash
cd python-sidecar
source venv/bin/activate
python app.py
# Runs on http://localhost:8001
```

## Current Performance

With Enterprise ERP database (60 questions):
- **Success Rate:** 56.7%
- **column_miss:** 20%
- **execution_error:** 5%

See `/STATUS.md` for full metrics.
