# MCP Server NL2SQL

TypeScript MCP server (forked from Smithery Postgres) extended with natural language query capability.

## Architecture

```
Chat Interface
    ↓
TypeScript MCP Server (this)
    ├─ nl_query tool: Natural language → SQL
    ├─ SQL validation: Security checks
    └─ Postgres execution: Results
    ↓ HTTP
Python Sidecar
    ├─ Keyword filtering: Stage 1 table selection
    ├─ Ollama client: Hrida NL2SQL model
    └─ SQL generation: Returns validated SQL
    ↓
Ollama (Hrida)
    └─ HridaAI/hrida-t2sql:v1.2.3
```

## Tools

### Original Tools (from Smithery)
- `query` - Execute SQL queries
- `checkpoint` - Create database checkpoint

### New Tools (NL2SQL)
- `nl_query` - Natural language queries (routes to Python sidecar)

## Configuration

```json
{
  "postgresConnectionString": "postgresql://user:pass@host:5432/db",
  "role": "read",
  "pythonSidecarUrl": "http://localhost:8001"
}
```

## Development Status

**Current Phase:** MVP (Phase 1)
- ✅ Fork created
- ⏳ nl_query tool (pending)
- ⏳ SQL validator (pending)
- ⏳ Python client (pending)

See `../roadmap.md` for full implementation plan.

## Installation

```bash
npm install
```

## Running

```bash
# Development mode
npm run dev

# Build
npm run build
```

## Testing

```bash
# Run Test 3 question suite
# Target: 85%+ success rate
# Questions: 27 from MCPtest database
```

## Project Structure

```
src/
├── index.ts              # Main MCP server (original + extensions)
├── nl_query_tool.ts      # nl_query tool implementation (new)
├── sql_validator.ts      # SQL validation rules (new)
├── python_client.ts      # HTTP client to Python sidecar (new)
└── config.ts             # Configuration types (new)
```

## Dependencies

- `@modelcontextprotocol/sdk` - MCP SDK
- `pg` - Postgres client
- `zod` - Schema validation

## Related

- Python Sidecar: `../python-sidecar/`
- Roadmap: `../roadmap.md`
- Original Repo: https://github.com/smithery-ai/mcp-servers
