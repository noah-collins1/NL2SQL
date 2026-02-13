# SQL Dialect Support

The NL2SQL pipeline is currently built for **PostgreSQL**. This document explains what is PG-specific, what is portable, and what would need to change to support MySQL, SQLite, or other dialects.

## Current State: PostgreSQL-Only

Today, PostgreSQL serves as both:
1. **The target database** — where user queries are executed
2. **The vector/RAG database** — where schema embeddings are stored (via pgvector)

Both roles use the same PostgreSQL instance and connection pool.

## What Is PostgreSQL-Specific

### 1. LLM Prompts (High Impact)

**File:** `python-sidecar/config.py`

The prompt templates are hardcoded for PostgreSQL:
- `"Generate PostgreSQL SELECT query for the {database_id} database."`
- PG-specific rules: `EXTRACT(YEAR FROM date)`, `INTERVAL '3 years'`, `date_trunc()`, `NULLIF()`, `STRING_AGG()`
- PG-specific anti-patterns: warns against `EXTRACT(DECADE FROM ...)` which doesn't exist in PG

**To change:** Parameterize the prompt template with a dialect variable. Create per-dialect rule sets (e.g., MySQL uses `YEAR(date)` instead of `EXTRACT(YEAR FROM date)`, `GROUP_CONCAT` instead of `STRING_AGG`). The model would need to be told which dialect to generate.

### 2. PG Normalize (`pg_normalize.ts`) (High Impact)

**File:** `mcp-server-nl2sql/src/pg_normalize.ts`

This module converts non-PG patterns INTO PostgreSQL:
- `YEAR(date)` → `EXTRACT(YEAR FROM date)`
- `IFNULL(a, b)` → `COALESCE(a, b)`
- `DATE_ADD(d, INTERVAL n unit)` → `d + INTERVAL 'n unit'`
- `DATEDIFF(a, b)` → `(a::date - b::date)`
- `GROUP_CONCAT(expr)` → `STRING_AGG(expr::text, ', ')`
- MySQL-style `LIMIT offset, count` → PG-style `LIMIT count OFFSET offset`
- Backtick removal

**To change:** For a MySQL target, you'd write the reverse — a `mysql_normalize.ts` that converts PG patterns to MySQL. Or disable normalization entirely and tune the LLM prompt to generate the right dialect directly.

### 3. EXPLAIN Validation (Medium Impact)

**Files:** `mcp-server-nl2sql/src/nl_query_tool.ts`, `multi_candidate.ts`

Uses `EXPLAIN (FORMAT JSON) <sql>` to validate candidates before execution. This is a key safety check — it verifies the query is syntactically valid and can be planned without actually running it.

**To change:**
- MySQL: Use `EXPLAIN FORMAT=JSON <sql>` (MySQL 5.7+)
- SQLite: Use `EXPLAIN QUERY PLAN <sql>` (returns a flat table, not JSON)
- The EXPLAIN result parsing would need dialect-specific handling

### 4. pgvector Embedding Store (High Impact)

**Files:** `mcp-server-nl2sql/src/schema_retriever.ts`, `bm25_search.ts`

Schema embeddings are stored in `rag.table_embeddings` using the pgvector extension (`vector(768)` type, `<=>` cosine operator). BM25 search uses PostgreSQL tsvector/tsquery.

**To change:** If your target DB is MySQL or SQLite, you have two options:

**Option A: Keep PostgreSQL for RAG, query target DB separately**
- Run PostgreSQL+pgvector as the "brain" (embedding store, schema retrieval)
- Execute generated SQL against the target MySQL/SQLite database
- Requires two database connections in the pipeline

**Option B: Use an external vector database**
- Replace pgvector with Pinecone, Weaviate, Milvus, ChromaDB, etc.
- Replace BM25 tsvector search with the vector DB's built-in search or Elasticsearch
- More infrastructure, but fully decouples from PostgreSQL

### 5. Dangerous Function Blocklist (Low Impact)

**File:** `mcp-server-nl2sql/src/sql_validator.ts`

The validator blocks PostgreSQL-specific dangerous functions: `pg_read_file`, `pg_terminate_backend`, `dblink`, `postgres_fdw`, etc.

**To change:** Swap to a dialect-specific blocklist. For MySQL: `LOAD_FILE()`, `INTO OUTFILE`, `BENCHMARK()`, etc.

### 6. SQL Validator (Low Impact)

**File:** `mcp-server-nl2sql/src/sql_validator.ts`

The token parser, dangerous keyword detection (`DROP`, `DELETE`, etc.), and table extraction are dialect-agnostic. The `EXTRACT(... FROM ...)` lookbehind regex has PG-specific date parts but would work similarly for other dialects.

### 7. Schema Introspection (Low Impact)

Uses `information_schema.columns`, `information_schema.tables`, `information_schema.table_constraints` — which exist in MySQL and PostgreSQL. SQLite has a different approach (`sqlite_master`, `PRAGMA table_info`).

## What Is Already Dialect-Agnostic

- Token parsing state machine (strings, comments, identifiers)
- Dangerous keyword detection (DROP, INSERT, DELETE, TRUNCATE, etc.)
- Table/column name extraction from SQL
- Multi-candidate generation and scoring logic
- Repair loop mechanics
- Module routing (keyword + embedding classification)
- Schema glosses (column description generation)
- Schema linker (keyphrase extraction + column matching)
- Join planner (FK graph traversal)

## Roadmap for Multi-Dialect Support

### Phase 1: Prompt Parameterization (Easiest Win)

Add a `dialect` setting to config:
```yaml
database:
  dialect: postgresql  # or mysql, sqlite, mssql
```

Use it to:
1. Select the right prompt template (PG rules vs MySQL rules vs SQLite rules)
2. Toggle `pg_normalize` on/off (only needed for PG target)
3. Adjust the system prompt sent to the LLM

This alone would let the LLM generate correct syntax for other dialects, though validation and execution would still need PG.

### Phase 2: Dialect-Specific Validation

- Create per-dialect dangerous function lists
- Create per-dialect EXPLAIN adapters
- Create per-dialect normalizers (or disable normalization when the LLM targets the right dialect directly)

### Phase 3: Decouple Vector Store

- Abstract the embedding store behind an interface
- Support pgvector, Pinecone, ChromaDB, etc.
- Abstract BM25 search behind the same interface

### Phase 4: Multi-DB Execution

- Support executing generated SQL against MySQL, SQLite, SQL Server, etc.
- Separate the "RAG brain" (pgvector) from the "query target" (any DB)
- Handle dialect-specific connection pooling and error classification
