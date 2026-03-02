# Dialect-Agnostic SQL Support — Future Roadmap

**Status:** Deferred. Focus on accuracy improvements first.
**Created:** 2026-03-02

## Goal

Make NL2SQL work with any SQL dialect (MSSQL, MySQL, SQLite, BigQuery, Snowflake, etc.) without requiring PostgreSQL as the target database.

## The Six Coupling Layers

### Layer 1: Database Driver — Medium effort
`index.ts` and `nl_query_tool.ts` are hard-wired to `pg` (node-postgres):
```typescript
import { Pool, PoolClient } from "pg"
const pool = new pg.Pool({ connectionString: config.postgresConnectionString })
```
**Fix**: `IDbDriver` abstraction interface with per-dialect implementations (pg, mssql, mysql2, better-sqlite3). Every `pool.connect()` / `client.query()` call routes through it.

### Layer 2: EXPLAIN / Dry-Run Validation — Hard (most critical)
The entire retry-and-repair loop depends on `EXPLAIN (FORMAT JSON)`:
```typescript
await client.query(`SET statement_timeout = ${...}`)
await client.query(`EXPLAIN (FORMAT JSON) ${finalSQL}`)
```
Dialects differ completely:
- **MSSQL**: `SET NOEXEC ON; <sql>; SET NOEXEC OFF` — parses without executing, returns text errors (not structured SQLSTATEs)
- **MySQL**: No real dry-run; must run in a transaction and rollback
- **SQLite**: `EXPLAIN QUERY PLAN` — structured but no cost estimation
- **BigQuery/Snowflake**: EXPLAIN exists but async/cost-based

The SQLSTATE-based error classification (`42703` → `column_miss`, `42P01` → `join_path_miss`) needs per-dialect error code mappings.

**Fix**: `dryRun(sql): DialectError` abstraction per dialect. Hardest part of the whole effort — 2-3 weeks alone.

### Layer 3: RAG Infrastructure (pgvector + tsvector) — Biggest architectural question
RAG lives inside PostgreSQL using PG-specific extensions:
- `pgvector` → `vector(768)`, `<=>`, `ivfflat`/`hnsw`
- Full-text search → `tsvector`, `plainto_tsquery`, `ts_rank`, GIN index
- Both in `rag.schema_embeddings` inside the target DB

**Two paths:**

#### Option A (Recommended): Keep PG as dedicated RAG sidecar DB
- Target DB can be any dialect
- Separate small PG instance holds all embedding/BM25 metadata for every onboarded DB
- Schema retrieval always hits the PG RAG DB; execution hits the target DB
- Clean separation: RAG metadata is fundamentally different from application data
- Tradeoff: always need one PG instance, but it's tiny (just embeddings + BM25 vectors)

#### Option B: Replace pgvector + tsvector with standalone vector store
- Vector search: Qdrant, Chroma, Weaviate, or pgvector-as-a-service
- BM25: Python `rank-bm25` library (easily added to sidecar venv)
- Zero PG dependency anywhere
- Tradeoff: rebuild retrieval pipeline from scratch, lose SQL-based introspection convenience

### Layer 4: SQL Generation Prompts — Easy
`config.py` says "PostgreSQL" everywhere and has PG-specific dialect rules hardcoded:
```python
SQL_SYSTEM_PROMPT = "You are an expert PostgreSQL query generator..."
SQL_RAG_PROMPT = "Generate PostgreSQL SELECT query for the {database_id} database."
```
Prompt also has PG-specific rules: INTERVAL syntax, `date_trunc`, `NULLIF(b, 0)`, `search_path`.

**Fix**: Parameterize `dialect` into `build_rag_prompt(... dialect="postgresql")`. Per-dialect rule blocks injected. Easy, high impact.

### Layer 5: `pg_normalize.ts` — Medium
One-way transform: MySQL/Oracle → PostgreSQL. For other target dialects you'd need transforms in different directions.

**Fix**: Rename to `dialect_normalize.ts`, parameterize by target dialect. Existing PG normalizer becomes one implementation.

### Layer 6: Identifier Quoting — Easy
`quoteIdentifiers()` uses ANSI double-quotes (works for PG, MSSQL, SQLite; MySQL needs backticks by default).

**Fix**: Pass `dialect` to `quoteIdentifiers()`. One-line conditional.

---

## Hidden Complexity: Schema Discovery

Not in the six layers above but a real gotcha from Industry-Erp migration:

The embedding population script introspects `information_schema`. In theory it's SQL standard — in practice:
- MSSQL omits system tables differently, uses `sys.foreign_keys` not `information_schema.table_constraints`
- Column metadata column names differ
- FK discovery is totally different across dialects

**Fix**: Per-dialect schema discovery adapters for the population script.

---

## Recommended Implementation Order (when the time comes)

1. **Prompt dialect parameterization** (Layer 4) — 1 day, zero risk, immediate value
2. **Identifier quoting** (Layer 6) — 1 hour
3. **Dialect normalizer** (Layer 5) — 1 week, replace pg_normalize with dialect_normalize
4. **Option A: PG RAG sidecar** (Layer 3) — 1 week to decouple RAG DB from target DB config
5. **Schema discovery adapters** — 1 week per dialect
6. **Driver abstraction** (Layer 1) — 2 weeks
7. **EXPLAIN / dry-run abstraction** (Layer 2) — 2-3 weeks, hardest part

## Effort Summary

| Path | Effort | What You Get |
|------|--------|--------------|
| **Option A: Hybrid RAG** — keep PG for RAG, add target dialect support | ~4-6 weeks focused | Works with MSSQL/MySQL/etc. as target. One PG instance required. |
| **Option B: Full agnosticism** — replace RAG with standalone vector store | ~2-3 months | Zero PG dependency. Heavier rebuild. |
| **Option C: Prompt/normalize only** | ~1 week | Works for PG-compatible targets (Aurora PG, CockroachDB, Supabase). |

**Recommendation**: Option A. Almost every deployment has PG available or can run a small container. The RAG data is just a few MB of embeddings — keeping it in PG is fine. The EXPLAIN abstraction (Layer 2) is where the real work is.
