# NL2SQL Project Status

**Last Updated:** 2026-02-02
**Phase:** Production Development - Schema RAG V1 + Multi-Candidate Generation + Minimal Whitelist Repair

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
│   │   ├── multi_candidate.ts    # **NEW** Multi-candidate generation, scoring, selection
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

### Multi-Candidate SQL Generation (NEW)
Generates K SQL candidates per question and selects the best using deterministic scoring.

**Configuration:**
```bash
MULTI_CANDIDATE_ENABLED=true    # Toggle on/off (default: true)
MULTI_CANDIDATE_K=4             # Default K (default: 4)
MULTI_CANDIDATE_K_EASY=2        # K for easy questions
MULTI_CANDIDATE_K_HARD=6        # K for hard questions
```

**How it works:**
1. Classify question difficulty → determine K value
2. Request K candidates from LLM (single call, delimited output)
3. Parse candidates using `---SQL_CANDIDATE---` delimiter
4. For each candidate:
   - Structural validation (fail-fast rejects)
   - Lint analysis (penalty scoring)
   - Parallel EXPLAIN with 2s timeout
5. Score candidates deterministically (no LLM judge)
6. Select best candidate (prefer EXPLAIN-passed)
7. Execute or enter repair loop

**Scoring:**
| Factor | Points |
|--------|--------|
| Base | +100 |
| Lint error | -25 |
| EXPLAIN fail | -50 |
| GROUP BY matches question | +10 |
| ORDER BY+LIMIT for "top/highest" | +10 |

**Files:** `multi_candidate.ts`, `config.ts`, `python-sidecar/config.py`

### Minimal Whitelist Repair
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
│  │     └─ Request K SQL candidates      │
│  ├─ 3. Multi-Candidate Evaluation       │
│  │     ├─ Parse delimited candidates    │
│  │     ├─ Structural validation         │
│  │     ├─ Lint analysis                 │
│  │     ├─ Parallel EXPLAIN              │
│  │     └─ Deterministic scoring         │
│  ├─ 4. Select best candidate            │
│  ├─ 5. Repair loop (max 3 attempts)     │
│  │     └─ Minimal whitelist for 42703   │
│  ├─ 6. Execute on Postgres              │
│  └─ 7. Return results                   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Python Sidecar (FastAPI :8001)          │
│  ├─ Generate K SQL candidates           │
│  │   (single LLM call, delimited)       │
│  ├─ Repair SQL with error context       │
│  └─ Return SQL + confidence             │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Ollama (HridaAI/hrida-t2sql)            │
│ Port: 11434, Temperature: 0.0-0.1       │
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

### 2026-02-02: Multi-Candidate SQL Generation
- **NEW FEATURE:** Generate K SQL candidates per question, select best via deterministic scoring
- Files added/modified:
  - `multi_candidate.ts` - Core module (config, parsing, scoring, orchestration)
  - `config.ts` - Extended interfaces for multi-candidate support
  - `nl_query_tool.ts` - Integration with main orchestration loop
  - `python-sidecar/config.py` - Multi-candidate prompt template
  - `python-sidecar/app.py` - Multi-candidate generation support
- Key features:
  - Difficulty-based K selection (easy=2, medium=4, hard=6)
  - Single LLM call with delimited output (`---SQL_CANDIDATE---`)
  - Parallel EXPLAIN with 2s timeout
  - Deterministic scoring: base (100) - lint errors (25) - EXPLAIN fail (50) + heuristic bonuses
  - Exam mode logging for candidate evaluation metrics
- Toggle: `MULTI_CANDIDATE_ENABLED=false` to disable

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
