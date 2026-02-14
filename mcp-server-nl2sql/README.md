# MCP Server NL2SQL

TypeScript MCP server that converts natural language questions into PostgreSQL queries using local LLMs via Ollama.

## Architecture

```
MCP Client (LibreChat, Claude Desktop, custom app)
     |  (MCP protocol over stdio)
     v
TypeScript MCP Server (this)
    ├─ Module routing + Schema RAG retrieval
    ├─ Prompt construction (glosses, linker, join planner)
    ├─ Multi-candidate evaluation + reranking
    ├─ Repair loop (surgical whitelist)
    └─ PostgreSQL execution
     | HTTP
     v
Python Sidecar (FastAPI :8001)
    ├─ K-candidate SQL generation via Ollama
    └─ Repair prompts
```

## Tools

| Tool | Purpose |
|------|---------|
| `nl_query` | Natural language to SQL — the main pipeline |
| `query` | Execute raw SQL (role-gated: read/insert/write/admin) |
| `checkpoint` | Database checkpoint management (undo/redo) |

## Project Structure

```
src/
├── index.ts              # MCP server entry (tools, resources, transport)
├── stdio.ts              # Stdio transport entry point
├── nl_query_tool.ts      # Main pipeline orchestration
├── schema_retriever.ts   # Schema RAG (cosine + BM25 + RRF + module routing)
├── schema_grounding.ts   # Schema glosses + schema linker
├── sql_validation.ts     # SQL validator + linter + autocorrect + PG normalize
├── multi_candidate.ts    # K-candidate generation + scoring
├── candidate_reranker.ts # Reranker (schema adherence, join match, result shape)
├── join_planner.ts       # FK graph BFS + join skeleton generation
├── surgical_whitelist.ts # Two-tier column error (42703) repair
├── python_client.ts      # HTTP client to Python sidecar
├── schema_types.ts       # Shared types (SchemaContextPacket, etc.)
├── config.ts             # Configuration types + feature flag re-exports
└── config/
    └── loadConfig.ts     # YAML + env var config loader

scripts/
├── schema_embedder.ts    # Generate table embeddings (setup-only)
├── schema_introspector.ts # Database introspection (setup-only)
└── populate_embeddings.ts # Orchestrate embedding population
```

## Configuration

All settings live in `config/config.yaml`. See [docs/CONFIG.md](../docs/CONFIG.md).

## Development

```bash
npm install
npm run build    # Build with smithery
```

## Related

- Python Sidecar: `../python-sidecar/`
- Root README: `../README.md`
