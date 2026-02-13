-- ============================================================================
-- Phase 1: BM25 Search + Module Embeddings
-- Adds tsvector full-text search and module-level embeddings for hybrid retrieval
-- ============================================================================

-- 1a. Add search_vector tsvector column to rag.schema_tables
ALTER TABLE rag.schema_tables ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 1b. Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_rag_tables_search ON rag.schema_tables USING GIN(search_vector);

-- 1c. Populate search_vector: table_name (weight A) + table_gloss (weight B) + column names+glosses (weight C)
UPDATE rag.schema_tables st SET search_vector = (
    setweight(to_tsvector('english', replace(st.table_name, '_', ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(st.table_gloss, '')), 'B') ||
    setweight(to_tsvector('english', coalesce((
        SELECT string_agg(
            replace(sc.column_name, '_', ' ') || ' ' || coalesce(sc.inferred_gloss, ''),
            ' '
        )
        FROM rag.schema_columns sc
        WHERE sc.table_name = st.table_name AND sc.table_schema = st.table_schema
    ), '')), 'C')
);

-- 1d. Module embeddings table (average of table embeddings per module)
CREATE TABLE IF NOT EXISTS rag.module_embeddings (
    module TEXT PRIMARY KEY,
    embedding vector(768),
    table_count INTEGER,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 1e. Populate module embeddings (average embedding per module)
INSERT INTO rag.module_embeddings (module, embedding, table_count)
SELECT
    mm.module,
    avg(se.embedding)::vector(768),
    count(*)
FROM rag.module_mapping mm
JOIN rag.schema_embeddings se
    ON se.table_name = mm.table_name AND se.entity_type = 'table'
GROUP BY mm.module
ON CONFLICT (module) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    table_count = EXCLUDED.table_count,
    updated_at = now();

-- Verification
SELECT 'search_vector populated' AS check,
    count(*) AS total,
    count(*) FILTER (WHERE search_vector IS NOT NULL) AS with_vector
FROM rag.schema_tables;

SELECT 'module_embeddings' AS check, module, table_count
FROM rag.module_embeddings
ORDER BY module;
