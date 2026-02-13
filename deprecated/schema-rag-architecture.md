# Schema RAG Architecture

## Overview

The NL2SQL system uses **Schema RAG (Retrieval-Augmented Generation)** to handle large databases with many tables. Instead of sending all 86 table schemas to the LLM (which would exceed context limits), we retrieve only the relevant tables for each question.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LibreChat                                       │
│                         (User asks question)                                 │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MCP Server (TypeScript)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  1. Schema Retriever                                                 │    │
│  │     • Embed question via Python sidecar                              │    │
│  │     • Query pgvector for similar table descriptions                  │    │
│  │     • Expand via FK relationships                                    │    │
│  │     • Build SchemaContextPacket                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                  │                                           │
│                                  ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  2. Send to Python Sidecar                                           │    │
│  │     • Question + SchemaContextPacket                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Python Sidecar (FastAPI)                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  3. Build RAG Prompt                                                 │    │
│  │     • Render M-Schema for each retrieved table                       │    │
│  │     • Include FK relationships                                       │    │
│  │     • Add module context                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                  │                                           │
│                                  ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  4. Generate SQL via Hrida LLM                                       │    │
│  │     • Send prompt to Ollama (HridaAI/hrida-t2sql)                    │    │
│  │     • Return generated SQL                                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MCP Server (TypeScript)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  5. Validate & Execute SQL                                           │    │
│  │     • Check SQL only uses retrieved tables                           │    │
│  │     • Enforce LIMIT clause                                           │    │
│  │     • Execute against PostgreSQL                                     │    │
│  │     • Return results to LibreChat                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Schema Embeddings (PostgreSQL + pgvector)

Table descriptions are pre-embedded and stored in PostgreSQL:

```sql
-- rag.schema_embeddings table
CREATE TABLE rag.schema_embeddings (
    id SERIAL PRIMARY KEY,
    table_schema VARCHAR(128),
    table_name VARCHAR(128),
    module VARCHAR(64),           -- e.g., 'HR', 'Sales', 'Finance'
    gloss TEXT,                   -- Human-readable description
    m_schema TEXT,                -- Compact DDL with FK annotations
    embedding vector(768),        -- nomic-embed-text embedding
    created_at TIMESTAMPTZ
);

-- HNSW index for fast similarity search
CREATE INDEX ON rag.schema_embeddings
    USING hnsw (embedding vector_cosine_ops);
```

**757 embeddings** cover all 86 tables with column-level descriptions.

### 2. Schema Retriever (TypeScript)

**File:** `mcp-server-nl2sql/src/schema_retriever.ts`

The retriever performs a 3-step process:

#### Step 1: Embed the Question
```typescript
const embedding = await this.pythonClient.embedText(question)
// Returns 768-dimension vector from nomic-embed-text
```

#### Step 2: Vector Similarity Search
```typescript
const results = await client.query(`
    SELECT table_schema, table_name, module, gloss, m_schema,
           1 - (embedding <=> $1::vector) as similarity
    FROM rag.schema_embeddings
    WHERE 1 - (embedding <=> $1::vector) > $2  -- threshold (0.25)
    ORDER BY embedding <=> $1::vector
    LIMIT $3  -- topK (15)
`, [embedding, threshold, topK])
```

#### Step 3: FK Expansion
```typescript
// For each retrieved table, find related tables via foreign keys
const fkResults = await client.query(`
    SELECT DISTINCT ref_table_name as related_table
    FROM rag.fk_graph
    WHERE table_name = $1
    LIMIT $2  -- fkExpansionLimit (3 per table)
`, [tableName, limit])
```

**Hub table protection:** Tables like `employees` (48 FK references) are capped at 5 expansions to prevent context explosion.

### 3. SchemaContextPacket

The retriever builds a JSON packet passed to the Python sidecar:

```typescript
interface SchemaContextPacket {
    query_id: string
    database_id: string
    question: string
    tables: Array<{
        table_name: string
        table_schema: string
        module: string
        gloss: string
        m_schema: string           // Compact DDL
        similarity: number         // 0.0 - 1.0
        source: "retrieval" | "fk_expansion"
        is_hub?: boolean
    }>
    fk_edges: Array<{
        from_table: string
        from_column: string
        to_table: string
        to_column: string
    }>
    modules: string[]              // Unique modules involved
    retrieval_meta: {
        top_k: number
        threshold: number
        retrieved_count: number
        expanded_count: number
    }
}
```

### 4. Python Sidecar

**File:** `python-sidecar/app.py`

Receives the question + schema context and builds the LLM prompt:

```python
@app.post("/generate-sql")
async def generate_sql(request: NLQueryRequest):
    if request.schema_context:
        # Use RAG prompt with retrieved tables only
        prompt = build_rag_prompt(request.question, request.schema_context)
    else:
        # Fallback to full schema (small databases)
        prompt = build_prompt(request.question, full_schema)

    # Generate SQL via Hrida
    sql = await call_ollama(prompt)
    return {"sql": sql}
```

#### RAG Prompt Template

```python
HRIDA_RAG_PROMPT = """
### Task
Generate a SQL query to answer: {question}

### Database: {database_id}
Modules involved: {modules}

### Available Tables (retrieved by relevance)
{table_schemas}

### Foreign Key Relationships
{fk_relationships}

### Instructions
- Use ONLY the tables listed above
- Join tables using the FK relationships provided
- Return minimal columns needed to answer the question

### Response
```sql
"""
```

### 5. SQL Validation

**File:** `mcp-server-nl2sql/src/nl_query_tool.ts`

Before execution, the SQL is validated:

```typescript
// Extract tables used in SQL
const usedTables = extractTablesFromSQL(sql)

// Verify all tables were in the retrieved context
for (const table of usedTables) {
    if (!allowedTables.has(table)) {
        throw new ValidationError(`Table '${table}' not in retrieved context`)
    }
}

// Ensure LIMIT clause exists
if (!sql.toLowerCase().includes('limit')) {
    sql = sql.replace(/;?\s*$/, ' LIMIT 1000;')
}
```

---

## Configuration

**File:** `mcp-server-nl2sql/src/config.ts`

```typescript
export const ENTERPRISE_ERP_CONFIG = {
    databaseId: "enterprise_erp",
    maxLimit: 1000,
    requireLimit: true,
    useSchemaRAG: true,
    ragConfig: {
        topK: 15,              // Max tables from vector search
        threshold: 0.25,       // Min similarity score
        maxTables: 10,         // Final table limit after expansion
        fkExpansionLimit: 3,   // FK expansions per table
        hubFKCap: 5,           // Cap for high-degree tables
    },
}
```

---

## Data Flow Example

**Question:** "Which employees have pending leave requests?"

1. **Embed:** Question → 768-dim vector

2. **Retrieve:** Vector search finds:
   - `leave_requests` (similarity: 0.756)
   - `leave_types` (similarity: 0.689)
   - `employees` (similarity: 0.605)

3. **Expand FKs:**
   - `leave_requests` → `employees` (already retrieved)
   - `leave_requests` → `leave_types` (already retrieved)

4. **Build Context:** 8 tables, 2 modules (HR), 10 FK edges

5. **Generate SQL:**
   ```sql
   SELECT e.employee_id, e.first_name || ' ' || e.last_name AS employee_full_name
   FROM employees e
   JOIN leave_requests lr ON e.employee_id = lr.employee_id
   WHERE lr.status = 'pending'
   LIMIT 1000;
   ```

6. **Validate:** Tables `employees`, `leave_requests` are in allowed set

7. **Execute:** Returns 242 rows

---

## Key Files

| File | Purpose |
|------|---------|
| `mcp-server-nl2sql/src/schema_retriever.ts` | Vector search + FK expansion |
| `mcp-server-nl2sql/src/schema_types.ts` | TypeScript types for schema context |
| `mcp-server-nl2sql/src/nl_query_tool.ts` | Main query handler with validation |
| `mcp-server-nl2sql/src/python_client.ts` | HTTP client for sidecar |
| `python-sidecar/app.py` | FastAPI server, SQL generation |
| `python-sidecar/config.py` | Prompt templates |
| `enterprise-erp/populate_rag_schema.py` | Embedding generation script |

---

## Performance

- **Embedding:** ~30-50ms (cached after first call)
- **Vector Search:** ~5-10ms (HNSW index)
- **FK Expansion:** ~5ms
- **SQL Generation:** 1-4 seconds (depends on complexity)
- **Total E2E:** 2-5 seconds per query
