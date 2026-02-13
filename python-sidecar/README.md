# Python AI Sidecar for NL2SQL

FastAPI service that handles natural language to SQL generation via Ollama/Hrida.

## Architecture

This service receives natural language questions from the TypeScript MCP server and returns generated SQL.

**Flow:**
1. Receive NL question + database schema context
2. Stage 1: Keyword filtering (extract entities, match table/column names)
3. Call Ollama with Hrida model (temperature=0.0)
4. Return: SQL + confidence score + tables used

## Endpoints

### POST /generate_sql
Generate SQL from natural language question.

**Request:**
```json
{
  "question": "How many companies are in the database?",
  "database_id": "mcptest",
  "schema": {
    "companies": {
      "columns": ["company_id", "name", "founding_year", "state"],
      "description": "100 companies with founding year and US state"
    },
    "company_revenue_annual": {
      "columns": ["company_id", "year", "revenue_millions"],
      "description": "Annual revenue 2017-2026"
    }
  }
}
```

**Response:**
```json
{
  "query_id": "uuid-v4",
  "sql": "SELECT COUNT(*) FROM companies;",
  "confidence": 1.0,
  "tables_selected": ["companies"],
  "tables_used_in_sql": ["companies"],
  "notes": "",
  "error": null
}
```

### POST /invalidate_cache
Invalidate schema and query caches (for Phase 2+).

### GET /health
Health check endpoint.

## Configuration

Environment variables:
- `OLLAMA_BASE_URL` - Default: http://localhost:11434
- `OLLAMA_MODEL` - Default: HridaAI/hrida-t2sql:v1.2.3
- `LOG_LEVEL` - Default: INFO
- `PORT` - Default: 8001

## Installation

```bash
# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Running

```bash
# Development
uvicorn app:app --reload --port 8001

# Production
uvicorn app:app --host 0.0.0.0 --port 8001 --workers 4
```

## Testing

```bash
# Test health endpoint
curl http://localhost:8001/health

# Test SQL generation
curl -X POST http://localhost:8001/generate_sql \
  -H "Content-Type: application/json" \
  -d '{"question": "How many companies?", "database_id": "mcptest"}'
```

## Development Status

**Current Phase:** MVP (Phase 1)
- ⏳ FastAPI server (pending)
- ⏳ Ollama client (pending)
- ⏳ Keyword filtering (pending)
- ⏳ Hardcoded MCPtest schema (pending)

## Project Structure

```
python-sidecar/
├── app.py                # FastAPI application
├── hrida_client.py       # Ollama API client
├── keyword_filter.py     # Stage 1 table selection
├── config.py             # Hardcoded schema + prompts
├── requirements.txt      # Python dependencies
└── README.md             # This file
```

## Related

- TypeScript MCP Server: `../mcp-server-nl2sql/`
- Docs: `../docs/`
