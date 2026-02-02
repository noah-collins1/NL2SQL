# NL2SQL Project Status

**Last Updated:** 2026-02-02
**Phase:** Production Development - Schema RAG V1 + Minimal Whitelist Repair

## Current Performance

| Metric | Value |
|--------|-------|
| **Success Rate** | 56.7% (34/60) |
| **column_miss** | 12 (20.0%) |
| **execution_error** | 3 (5.0%) |
| **Database** | Enterprise ERP (60+ tables) |

## Project Structure

```
nl2sql-project/
├── STATUS.md                     # This file
├── roadmap.md                    # Original architecture roadmap
├── docs/                         # Technical documentation
│   ├── schema-rag-v2.md          # V2 retrieval design (not in use)
│   └── schema-rag-v2-integration.md
│
├── mcp-server-nl2sql/            # TypeScript MCP Server
│   ├── src/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── nl_query_tool.ts      # Main NL2SQL tool
│   │   ├── sql_validator.ts      # SQL validation
│   │   ├── sql_lint.ts           # SQL linting
│   │   ├── sql_autocorrect.ts    # SQL autocorrection
│   │   ├── schema_retriever.ts   # V1 schema retrieval (ACTIVE)
│   │   ├── schema_retriever_v2.ts # V2 retrieval (NOT IN USE - caused errors)
│   │   ├── column_candidates.ts  # Column whitelist + minimal repair
│   │   ├── schema_embedder.ts    # Embedding generation
│   │   ├── python_client.ts      # HTTP client to sidecar
│   │   └── config.ts             # Configuration types
│   ├── scripts/
│   │   └── run_exam.ts           # 60-question exam runner
│   └── exam_logs/                # Exam results
│
├── python-sidecar/               # Python AI service
│   ├── app.py                    # FastAPI server
│   ├── config.py                 # Prompts and configuration
│   ├── hrida_client.py           # Ollama API client
│   └── semantic_validator.py     # Semantic validation
│
├── enterprise-erp/               # Enterprise ERP test database
│   ├── 001_create_schema.sql     # Schema DDL
│   ├── 002_sample_data.sql       # Sample data
│   └── 003_test_questions.json   # 60 exam questions
│
└── mcp-servers/                  # Smithery MCP servers (git clone, reference)
```

## Active Features

### V1 Schema RAG (ACTIVE)
- Table retrieval via pgvector similarity search
- M-Schema format for schema representation
- FK edge detection for join hints

### Minimal Whitelist Repair (NEW)
- Extracts failing `alias.column` from 42703 errors
- Resolves alias to table using SQL FROM/JOIN analysis
- Builds targeted whitelist (table + 1-hop FK neighbors)
- Reduces column_miss without increasing execution_error

### NOT IN USE
- **V2 Dual Retrieval** (`USE_SCHEMA_RAG_V2=true`): Caused regression from 53% to 37% success rate
- **Pre-execution Column Validation**: Too aggressive, caused false positives

## Architecture

```
┌─────────────────────────────────────────┐
│ LibreChat / Chat Interface              │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ TypeScript MCP Server                   │
│                                         │
│  nl_query(question)                     │
│  ├─ 1. Schema RAG (V1 retrieval)        │
│  ├─ 2. HTTP POST to Python sidecar      │
│  ├─ 3. Validate + EXPLAIN SQL           │
│  ├─ 4. Repair loop (max 3 attempts)     │
│  │     └─ Minimal whitelist for 42703   │
│  ├─ 5. Execute on Postgres              │
│  └─ 6. Return results                   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Python Sidecar (FastAPI :8001)          │
│  ├─ Generate SQL (Ollama/Hrida)         │
│  ├─ Repair SQL with error context       │
│  └─ Return SQL + confidence             │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Ollama (HridaAI/hrida-t2sql)            │
│ Port: 11434, Temperature: 0.0           │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ PostgreSQL (Enterprise ERP)             │
│ 60+ tables, 8 modules                   │
│ User: read-only role                    │
└─────────────────────────────────────────┘
```

## Exam Results by Difficulty

| Difficulty | Success Rate |
|------------|--------------|
| Easy (20)  | 95.0% (19/20) |
| Medium (25)| 52.0% (13/25) |
| Hard (15)  | 13.3% (2/15) |

## Known Issues

1. **Hard queries fail** - LLM struggles with complex multi-table joins
2. **column_miss still 20%** - LLM invents column names not in schema
3. **V2 retriever broken** - Causes many execution errors, not in use

## Recent Changes

### 2026-02-02: Minimal Whitelist Repair
- Implemented targeted 42703 repair (only relevant table + FK neighbors)
- Success rate: 53.3% → 56.7% (+3.4%)
- column_miss: 14 → 12 (-2)
- execution_error: unchanged at 3

### 2026-01-31: Schema RAG V1 Baseline
- Established 53.3% baseline with V1 retriever
- V2 tested but caused regression

## Running the Exam

```bash
cd mcp-server-nl2sql
npx tsx scripts/run_exam.ts
```

Results saved to `exam_logs/exam_results_full_YYYY-MM-DD.json`
