# Adding a New Database

Step-by-step guide to connect NL2SQL to a new PostgreSQL database.

## Overview

1. Create the database and load your schema
2. Set up the RAG infrastructure (pgvector tables)
3. Generate embeddings for your tables
4. Create a partial HNSW index (critical)
5. Re-embed hub tables with query-oriented text
6. Set up module embeddings
7. Configure identifiers and context window
8. Write exam questions
9. Run the exam

---

## Step 1: Database Setup

Your database needs to exist in PostgreSQL with schema and data loaded. NL2SQL connects as a read-only user.

```bash
# Example: create a database
createdb my_database

# Load your schema
psql -d my_database -f schema.sql
psql -d my_database -f data.sql
```

### Migrating from MSSQL

If migrating from SQL Server, the Industry-Erp migration produced these hard-won lessons:

```bash
# Use sqlcmd with UTF-8 and unit-separator delimiter to avoid embedded pipe/quote issues
sqlcmd -S mssql-host -U sa -P 'Password1' -d MyDB \
  -Q "SET NOCOUNT ON; SELECT * FROM dbo.MyTable" \
  -f 65001 -s $'\x1f' -h -1 -W \
  -o /tmp/MyTable.csv

# -f 65001      = UTF-8 output (avoid -u which causes UTF-16 BOM)
# -s $'\x1f'    = unit-separator delimiter (avoids embedded commas/pipes)
# NULL 'NULL'   = treat literal "NULL" strings as SQL null

# Then load into PostgreSQL with COPY
psql -d my_database -c "\COPY my_table FROM '/tmp/MyTable.csv' WITH (FORMAT CSV, DELIMITER E'\x1f', NULL 'NULL')"
```

**MSSQL migration gotchas:**
- **Mixed-case table/column names**: MSSQL names like `tbl_customer`, `CustomerName` are PascalCase. PostgreSQL folds unquoted identifiers to lowercase. You must double-quote all such names in SQL. NL2SQL's `quoteIdentifiers()` in `sql_validation.ts` handles this automatically — but verify it fires for your DB's `ACTIVE_DATABASE` config value.
- **Text-type numeric columns**: Some MSSQL numeric columns migrate as `text` type in PostgreSQL. These require `NULLIF(col, '')::numeric` — NOT `COALESCE(col, 0)::numeric` (which fails with "types text and integer cannot be matched"). Document these in your exam gold SQL.
- **Natural keys vs surrogate PKs**: MSSQL tables often use char natural keys (e.g., `Customer` char(8)) as FKs, with a separate `ID` (integer) PK that is NOT the FK target. If the model joins on the integer `ID` instead of the char key, you get `operator does not exist: integer = character`. Add confusable table warnings to `schema_grounding.ts` for tables with this pattern.
- **FK constraints**: Many MSSQL FKs reference natural keys that may not survive migration cleanly. Expect to load only a subset of FK constraints (Industry-Erp loaded 216 of 536).

---

## Step 2: RAG Infrastructure

NL2SQL uses pgvector for schema retrieval. You need the RAG schema with table/column embedding tables.

```sql
-- Connect to your database
\c my_database

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Create RAG schema
CREATE SCHEMA IF NOT EXISTS rag;

-- Unified schema embeddings table (tables + columns in same table)
CREATE TABLE rag.schema_embeddings (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,     -- 'table' or 'column'
    table_name TEXT NOT NULL,
    column_name TEXT,              -- NULL for table rows
    module TEXT,                   -- e.g. 'HR', 'Finance', 'general'
    embed_text TEXT,               -- Text that was embedded
    m_schema TEXT,                 -- M-Schema format (tables only)
    embedding vector(768),         -- nomic-embed-text = 768-dim
    search_vector tsvector         -- For BM25 search
);

-- BM25 index for keyword search
CREATE INDEX ON rag.schema_embeddings USING gin (search_vector);

-- Module embeddings (for module routing)
CREATE TABLE rag.module_embeddings (
    module_name TEXT PRIMARY KEY,
    description TEXT,
    keywords TEXT[],
    embedding vector(768)
);
```

> **Note:** Embeddings are **768-dimensional** (nomic-embed-text). Do NOT use 384-dim — that's a different model.

---

## Step 3: Populate Embeddings

The embedding population script introspects your database schema and generates embeddings.

```bash
# Copy and adapt the existing population script for your DB
cp scripts/populate_embeddings_2000.py scripts/populate_my_database.py

# Edit the script: change DB connection string and ACTIVE_DATABASE
# Then run:
cd python-sidecar
source venv/bin/activate
python ../scripts/populate_my_database.py
```

This will:
1. Introspect all tables and columns via `information_schema`
2. Build M-Schema descriptions for each table
3. Generate embeddings via the sidecar's `/embed` endpoint
4. Insert into `rag.schema_embeddings` with entity_type = 'table' or 'column'
5. Populate `search_vector` via `to_tsvector('english', embed_text)`

**Verify row counts after population:**
```sql
SELECT entity_type, COUNT(*) FROM rag.schema_embeddings GROUP BY entity_type;
-- Should have both 'table' rows and 'column' rows
-- e.g.: table: 883, column: 11357
```

---

## Step 4: Create the HNSW Index (CRITICAL)

> **This step is critical and was the #1 cause of 0% retrieval on Industry-Erp.**

When `schema_embeddings` contains both `entity_type = 'table'` and `entity_type = 'column'` rows (e.g. 883 tables + 11,357 columns = 12,240 total), a **full HNSW index** is useless: `LIMIT 15` on a full scan returns only column rows (92.8% of data). After `WHERE entity_type = 'table'` filtering, you get **0 results**.

**Solution: create a PARTIAL HNSW index on table rows only:**

```sql
-- Drop any full HNSW index if it exists
DROP INDEX IF EXISTS rag.idx_rag_embed_hnsw;

-- Create partial HNSW index for table rows only
CREATE INDEX idx_rag_embed_hnsw_tables
  ON rag.schema_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE entity_type = 'table';

-- For large schemas (>500 tables), tune HNSW parameters
CREATE INDEX idx_rag_embed_hnsw_tables
  ON rag.schema_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE entity_type = 'table'
  WITH (m = 16, ef_construction = 64);
```

**Verify the index works:**
```sql
-- Should return table rows, not column rows
SELECT table_name, entity_type
FROM rag.schema_embeddings
WHERE entity_type = 'table'
ORDER BY embedding <=> (SELECT embedding FROM rag.schema_embeddings WHERE table_name = 'some_table' LIMIT 1)
LIMIT 5;
```

---

## Step 5: Re-embed Hub Tables with Query-Oriented Text

The default embed_text is the M-Schema description (column list). For high-traffic hub tables (Customer, Order, Invoice, etc.), this produces poor retrieval because the embed_text doesn't match how users phrase questions.

**Identify hub tables** — tables that appear in most queries:
- Customer/Account tables
- Order/Transaction tables
- Invoice/Receipt tables
- Item/Product/Inventory tables
- Vendor/Supplier tables

**Re-embed with query-oriented text:**

```sql
-- Example: update embed_text for Customer table
UPDATE rag.schema_embeddings
SET embed_text = 'Customer accounts and profiles. Find customers by name, location, or account number.
List customers who placed orders, have outstanding invoices, or are in a specific region.
Joins to: Orders (via CustomerID), Invoices (via CustomerID), CustomerLocations (via Customer char key).'
WHERE table_name = 'Customers' AND entity_type = 'table';
```

Then re-run the embedding for those rows:
```python
# Re-embed specific tables via the /embed endpoint
import requests
r = requests.post("http://localhost:8001/embed", json={"text": embed_text})
embedding = r.json()["embedding"]
# UPDATE rag.schema_embeddings SET embedding = embedding WHERE ...
```

**Verify retrieval rank improves:**
```sql
-- Run a test query embedding and check rank
SELECT table_name, 1 - (embedding <=> $1::vector) AS similarity
FROM rag.schema_embeddings
WHERE entity_type = 'table'
ORDER BY embedding <=> $1::vector
LIMIT 10;
-- Your hub table should appear in top 5 for its obvious query patterns
```

---

## Step 6: Module Embeddings (Optional but Recommended)

If your database has clear domains (e.g., Sales, Finance, HR, Warehouse), add module embeddings for better retrieval routing. This filters which tables get searched, reducing noise for large DBs.

```sql
INSERT INTO rag.module_embeddings (module_name, description, keywords) VALUES
('Sales', 'Sales orders, customers, pricing, quotes, commissions',
 ARRAY['customer', 'order', 'sales', 'quote', 'commission', 'price']),
('Finance', 'Accounts payable, receivable, general ledger, invoices',
 ARRAY['invoice', 'payment', 'ledger', 'account', 'receivable', 'payable']),
('Inventory', 'Items, locations, stock levels, purchase orders',
 ARRAY['item', 'inventory', 'stock', 'warehouse', 'quantity', 'purchase']);
```

Then embed each module description via the `/embed` endpoint:
```python
for module in modules:
    r = requests.post("http://localhost:8001/embed", json={"text": module["description"]})
    # UPDATE rag.module_embeddings SET embedding = ... WHERE module_name = ...
```

**Module naming note**: The `rag.module_embeddings` table has column `module_name`, NOT `module`. Ensure any SQL querying this table uses the correct column name.

---

## Step 7: Configure the System

### Point NL2SQL at your database:

```bash
# .mcp.json
{
  "postgresConnectionString": "postgresql://user:pass@host:5432/my_database",
  "role": "read"
}

# Environment variables
export DATABASE_URL="postgresql://user:pass@host:5432/my_database"
export ACTIVE_DATABASE="my_database"
```

### Identifier quoting for mixed-case schemas:

If your tables use mixed-case names (PascalCase, camelCase), NL2SQL must double-quote them in generated SQL. This is handled by `quoteIdentifiers()` in `sql_validation.ts`.

Check `nl_query_tool.ts` Step 1.6 — `quoteIdentifiers()` fires based on `ACTIVE_DATABASE` config. Add your database name to the condition if needed.

### Context window sizing:

For verbose schemas (many columns per table), the default 4096-token Ollama context is too small. The prompt will be truncated and the model will generate prose instead of SQL.

```bash
# For large/verbose schemas (recommended: 16384 for anything >500 tables)
export OLLAMA_NUM_CTX=16384

# Verify prompts aren't being truncated by watching sidecar logs
tail -f /tmp/sidecar.log | grep -i "truncat"
```

### Start the sidecar:

```bash
cd python-sidecar
source venv/bin/activate
OLLAMA_MODEL=qwen2.5-coder:7b \
SEQUENTIAL_CANDIDATES=true \
OLLAMA_NUM_CTX=16384 \
nohup python app.py > /tmp/sidecar.log 2>&1 &
```

> **Note:** `SEQUENTIAL_CANDIDATES=true` is required on 8GB GPU when using qwen2.5-coder:7b or llama3.1:8b (parallel generation OOMs).

---

## Step 8: Write Exam Questions

Create a CSV with test questions for your database:

```csv
id,question,gold_sql,difficulty,tags
1,"How many customers do we have?","SELECT COUNT(*) FROM ""Customers""",easy,count
2,"What is the total revenue by region?","SELECT Region, SUM(Amount) FROM ""Orders"" GROUP BY Region",medium,aggregation
```

Place it in `demo/your-db/exam.csv`.

**Tips for good exam questions:**
- Cover all major tables (especially hub tables)
- Include multi-table JOINs at medium difficulty
- Include GROUP BY / HAVING at hard difficulty
- Include window functions at extra-hard difficulty
- Include a few ambiguous questions to test abstention behavior
- Test your gold SQL against the actual database before adding to exam

---

## Step 9: Run the Exam

First verify retrieval is working with a quick smoke test:
```bash
# Quick 5-question test first
./demo/run-exam.sh --db=your-db --max=5
```

Then run the full exam:
```bash
./demo/run-exam.sh --db=your-db
```

Examine failures by category in `mcp-server-nl2sql/exam_logs/`.

---

## Troubleshooting

### "0 tables retrieved" / all queries fail

1. **Check HNSW index** — is it partial (`WHERE entity_type = 'table'`) or full? Full HNSW on a mixed table+column dataset returns 0 table results. See Step 4.
2. **Check embedding count**: `SELECT COUNT(*) FROM rag.schema_embeddings WHERE entity_type = 'table';` — should equal your table count.
3. **Check module field**: `SELECT COUNT(*) FROM rag.schema_embeddings WHERE module IS NULL AND entity_type = 'table';` — null module values cause 422 errors from the sidecar. Run: `UPDATE rag.schema_embeddings SET module = 'general' WHERE module IS NULL;`

### "Model did not generate SELECT statement" (for CTEs)

CTEs (`WITH cte AS (...)`) are valid SQL but older code rejected them. Three places check for SELECT:
- `ollama_client.py` lines ~135 and ~361: should accept `WITH \w+ AS \(`
- `sql_validation.ts` Rule 1 NO_SELECT: should accept `WITH` prefix

These were fixed in the codebase as of 2026-02-26. If you see this error, check that you have the latest code.

### SQL truncated mid-clause (e.g., `SUM(x) OV`)

`max_tokens=200` in `app.py` was too small for CTEs. All callsites were updated to `max_tokens=500` as of 2026-02-26. If you see truncated output, verify `app.py` uses 500.

### "operator does not exist: integer = character"

Model is joining on a surrogate integer PK instead of the natural char key used by FK constraints. Common in MSSQL-migrated schemas. Add a confusable table warning in `schema_grounding.ts`:
```typescript
export const CONFUSABLE_TABLES: Record<string, string> = {
  "Customers": "Use Customer (char) as join key, NOT ID (integer). All FKs reference Customer.",
};
```

### Context truncation / model generates prose instead of SQL

Increase `OLLAMA_NUM_CTX`. The default 4096 is too small for verbose schemas. Use 16384 for schemas with verbose column descriptions.

### Poor retrieval for hub tables (Customer, Order, etc.)

Default embed_text is the M-Schema column list, which doesn't match user query phrasing. Re-embed hub tables with query-oriented text that includes common query patterns. See Step 5.

### \n\n stop token regression

Removing `\n\n` from stop tokens causes the model to generate more elaborate/verbose SQL with wrong column names (+21 execution errors observed). **Always keep `stop_tokens = [";", "\n\n"]`** in `ollama_client.py` for both sync and async paths. CTEs generated by qwen2.5-coder do not contain `\n\n` internally — they truncated due to `max_tokens=200`, not stop tokens.
