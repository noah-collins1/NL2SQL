# Adding a New Database

Step-by-step guide to connect NL2SQL to a new PostgreSQL database.

## Overview

1. Create the database and load your schema
2. Set up the RAG infrastructure (pgvector tables)
3. Generate embeddings for your tables
4. Write exam questions
5. Run the exam

## Step 1: Database Setup

Your database needs to exist in PostgreSQL with schema and data loaded. NL2SQL connects as a read-only user.

```bash
# Example: create a database
createdb my_database

# Load your schema
psql -d my_database -f schema.sql
psql -d my_database -f data.sql
```

## Step 2: RAG Infrastructure

NL2SQL uses pgvector for schema retrieval. You need the RAG schema with table/column embedding tables.

```sql
-- Connect to your database
\c my_database

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Create RAG schema
CREATE SCHEMA IF NOT EXISTS rag;

-- Table embeddings (one row per table)
CREATE TABLE rag.table_embeddings (
    table_name TEXT PRIMARY KEY,
    table_schema TEXT DEFAULT 'public',
    module TEXT DEFAULT 'general',
    description TEXT,
    m_schema TEXT,           -- M-Schema format column listing
    gloss TEXT,              -- Human-readable table summary
    embedding vector(768),   -- nomic-embed-text dimension
    search_vector tsvector   -- For BM25 search
);

-- Create indexes
CREATE INDEX ON rag.table_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX ON rag.table_embeddings USING gin (search_vector);

-- Module embeddings (for module routing, optional)
CREATE TABLE rag.module_embeddings (
    module_name TEXT PRIMARY KEY,
    description TEXT,
    keywords TEXT[],
    embedding vector(768)
);
```

## Step 3: Populate Embeddings

The embedding population script introspects your database schema and generates embeddings.

```bash
# Configure your database
# config/config.local.yaml:
# database:
#   name: my_database
#   password: your_password

# Generate embeddings
cd mcp-server-nl2sql
ACTIVE_DATABASE=my_database npx tsx scripts/populate_embeddings.ts
```

This will:
1. Introspect all tables and columns via `information_schema`
2. Build M-Schema descriptions for each table
3. Generate embeddings via the sidecar's `/embed` endpoint
4. Insert into `rag.table_embeddings`

## Step 4: Configure

Point NL2SQL at your database:

```yaml
# config/config.local.yaml
database:
  name: my_database
  password: your_password
```

## Step 5: Write Exam Questions

Create a JSON file with test questions:

```json
[
  {
    "id": 1,
    "question": "How many customers do we have?",
    "expected_sql": "SELECT COUNT(*) FROM customers",
    "difficulty": "easy",
    "category": "general"
  },
  {
    "id": 2,
    "question": "What is the total revenue by product category?",
    "expected_sql": "SELECT category, SUM(revenue) FROM products JOIN orders ON ... GROUP BY category",
    "difficulty": "medium",
    "category": "sales"
  }
]
```

Place it in `demo/enterprise-erp/003_test_questions.json` (or modify the exam runner to point to your file).

## Step 6: Run the Exam

```bash
./scripts/start-sidecar.sh --bg
./demo/run-exam.sh
```

## Tips

- **Modules**: If your database has clear domains (HR, Finance, etc.), create module embeddings for better retrieval routing
- **Glosses**: Schema glosses auto-generate from column names, but you can improve them by adding `description` text to `rag.table_embeddings`
- **FK edges**: The retriever discovers FK relationships from `information_schema.table_constraints`. Ensure your FKs are properly declared
- **Search path**: If your tables are in schemas other than `public`, configure the search path accordingly
- **Start small**: Begin with 10-20 questions across difficulty levels, iterate on retrieval quality before scaling up
