# NL2SQL Project Status

**Last Updated:** 2026-02-02
**Phase:** Production Development - Schema RAG V1 + Parallel Multi-Candidate Generation

## Current Performance

| Metric | Value |
|--------|-------|
| **Success Rate** | 75.0% (45/60) |
| **column_miss** | 5 (8.3%) |
| **llm_reasoning** | 7 (11.7%) |
| **execution_error** | 2 (3.3%) |
| **Database** | Enterprise ERP (60+ tables) |

## Exam Results by Difficulty

| Difficulty | Success Rate |
|------------|--------------|
| Easy (20)  | 95.0% (19/20) |
| Medium (25)| 72.0% (18/25) |
| Hard (15)  | 53.3% (8/15) |

## Project Structure

```
nl2sql-project/
├── STATUS.md                     # This file
├── roadmap.md                    # Original architecture roadmap
├── docs/                         # Technical documentation
│
├── mcp-server-nl2sql/            # TypeScript MCP Server
│   ├── src/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── nl_query_tool.ts      # Main NL2SQL tool
│   │   ├── multi_candidate.ts    # Multi-candidate scoring & selection
│   │   ├── sql_validator.ts      # SQL validation
│   │   ├── sql_lint.ts           # SQL linting
│   │   ├── sql_autocorrect.ts    # SQL autocorrection
│   │   ├── schema_retriever.ts   # V1 schema retrieval (ACTIVE)
│   │   ├── column_candidates.ts  # Column whitelist + minimal repair
│   │   ├── schema_embedder.ts    # Embedding generation
│   │   ├── python_client.ts      # HTTP client to sidecar
│   │   └── config.ts             # Configuration types
│   ├── scripts/
│   │   └── run_exam.ts           # 60-question exam runner
│   └── exam_logs/                # Exam results
│
├── python-sidecar/               # Python AI service
│   ├── app.py                    # FastAPI server (async parallel generation)
│   ├── config.py                 # Prompts and configuration
│   ├── hrida_client.py           # Ollama API client (sync + async)
│   └── semantic_validator.py     # Semantic validation
│
├── enterprise-erp/               # Enterprise ERP test database
│   ├── 001_create_schema.sql     # Schema DDL
│   ├── 002_sample_data.sql       # Sample data
│   └── 003_test_questions.json   # 60 exam questions
│
└── mcp-servers/                  # Smithery MCP servers (reference)
```

## Active Features

### V1 Schema RAG (ACTIVE)
- Table retrieval via pgvector similarity search
- M-Schema format for schema representation
- FK edge detection for join hints

### Parallel Multi-Candidate SQL Generation
Generates K SQL candidates in parallel and selects the best using deterministic scoring.

**Architecture:**
```
Question → K Parallel LLM Calls → Deduplicate → Score → Select Best → Execute
           (temp=0.3 for diversity)
```

**Configuration:**
```bash
MULTI_CANDIDATE_ENABLED=true    # Toggle on/off (default: true)
MULTI_CANDIDATE_K=4             # Default K (default: 4)
MULTI_CANDIDATE_K_EASY=2        # K for easy questions
MULTI_CANDIDATE_K_HARD=6        # K for hard questions
```

**How it works:**
1. Classify question difficulty → determine K value
2. Generate K candidates in parallel (async aiohttp calls)
3. Temperature=0.3 for natural diversity
4. Deduplicate by normalized SQL
5. For each unique candidate:
   - Structural validation (fail-fast rejects)
   - Lint analysis (penalty scoring)
   - Parallel EXPLAIN with 2s timeout
6. Score candidates deterministically (no LLM judge)
7. Select best candidate (prefer EXPLAIN-passed)
8. Execute or enter repair loop

**Scoring:**
| Factor | Points |
|--------|--------|
| Base | +100 |
| Lint error | -25 |
| EXPLAIN fail | -50 |
| GROUP BY matches question | +10 |
| ORDER BY+LIMIT for "top/highest" | +10 |

### Minimal Whitelist Repair
- Extracts failing `alias.column` from 42703 errors
- Resolves alias to table using SQL FROM/JOIN analysis
- Builds targeted whitelist (table + 1-hop FK neighbors)

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
│  │     └─ Request K parallel candidates │
│  ├─ 3. Multi-Candidate Evaluation       │
│  │     ├─ Receive deduplicated list     │
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
│  ├─ Parallel candidate generation       │
│  │   (K async calls, temp=0.3)          │
│  ├─ Deduplication by normalized SQL     │
│  ├─ Repair SQL with error context       │
│  └─ Return sql_candidates list          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Ollama (HridaAI/hrida-t2sql)            │
│ Port: 11434, GPU: RTX 4060 Ti           │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ PostgreSQL (Enterprise ERP)             │
│ 60+ tables, 8 modules                   │
│ User: read-only role                    │
└─────────────────────────────────────────┘
```

## Current Error Analysis

### Failure Breakdown (15 failures)

| Category | Count | % | Root Cause |
|----------|-------|---|------------|
| column_miss | 5 | 8.3% | LLM invents column names |
| llm_reasoning | 7 | 11.7% | Syntax errors, complex queries |
| execution_error | 2 | 3.3% | Gibberish output |
| join_path_miss | 1 | 1.7% | Wrong table relationships |

### Specific Error Patterns

**1. Column Name Errors (5 failures)**
LLM invents columns not in schema:
- `v.vendor_name` → should be `v.name`
- `c.segment` → column doesn't exist
- `pe.actual_amount` → should be `pe.amount`
- `ac.asset_id` → wrong table alias

**2. PostgreSQL Syntax (2 failures)**
Using MySQL functions instead of PostgreSQL:
- `YEAR(date)` → should be `EXTRACT(YEAR FROM date)`
- Ambiguous column references without table qualifiers

**3. Complex Query Failures (4 failures)**
LLM struggles with:
- Month-over-month calculations (LAG/LEAD)
- Trial balance generation
- Cash flow grouping
- Multi-table analytics

**4. Generation Failures (2 failures)**
- Model produces gibberish for some complex queries
- Fails to generate SELECT statement

## Performance History

| Date | Success Rate | Key Change |
|------|--------------|------------|
| 2026-01-31 | 53.3% | V1 Schema RAG baseline |
| 2026-02-02 | 56.7% | Minimal whitelist repair |
| 2026-02-02 | 65.0% | Multi-candidate (delimiter-based) |
| **2026-02-02** | **75.0%** | **Parallel multi-candidate** |

## Recent Changes

### 2026-02-02: Parallel Multi-Candidate Generation
- **MAJOR IMPROVEMENT:** 65% → 75% success rate (+10%)
- Replaced delimiter-based single-call with parallel LLM calls
- Files modified:
  - `python-sidecar/hrida_client.py` - Async generation with aiohttp
  - `python-sidecar/app.py` - Parallel candidate orchestration
  - `mcp-server-nl2sql/src/nl_query_tool.ts` - Handle sql_candidates list
- Key improvements:
  - Medium queries: 60% → 72% (+12%)
  - Hard queries: 33% → 53% (+20%)
  - column_miss: 15% → 8.3%
  - Inventory module: 50% → 100%

### 2026-02-02: Multi-Candidate Framework
- Initial implementation with delimiter-based parsing
- Success rate: 56.7% → 65.0%

### 2026-02-02: Minimal Whitelist Repair
- Targeted 42703 repair for column errors
- Success rate: 53.3% → 56.7%

## Known Issues

1. **Column name hallucination** - LLM invents columns not in schema (8.3% of failures)
2. **PostgreSQL syntax** - Uses MySQL functions (YEAR vs EXTRACT)
3. **Complex analytics** - Struggles with window functions, multi-step calculations
4. **Sales module weak** - Only 45.5% success (needs better schema context)

## Potential Improvements

1. **Column name enforcement** - Add column whitelist to prompt
2. **PostgreSQL examples** - Add EXTRACT, window function examples to prompt
3. **Sales schema enrichment** - Better table/column descriptions for sales module
4. **Retry with different temperature** - If first batch fails, try temp=0.5

## Running the Exam

```bash
cd mcp-server-nl2sql
npx tsx scripts/run_exam.ts
```

Results saved to `exam_logs/exam_results_full_YYYY-MM-DD.json`
