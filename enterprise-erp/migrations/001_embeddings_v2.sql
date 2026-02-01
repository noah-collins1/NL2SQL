-- ============================================================================
-- Migration: Embeddings V2 - Dual-Entity Schema RAG
--
-- Changes:
-- 1. Add database_id for multi-database support
-- 2. Separate entity_type: 'table' | 'column'
-- 3. Add embed_text (rich text for embedding) vs m_schema_compact (for prompts)
-- 4. Change to 768-dim vectors (nomic-embed-text)
-- 5. Add column-level metadata for scoring
-- ============================================================================

-- Backup existing data (optional, for rollback)
-- CREATE TABLE rag.schema_embeddings_backup AS SELECT * FROM rag.schema_embeddings;

-- ============================================================================
-- Drop old table and recreate with new schema
-- ============================================================================
DROP TABLE IF EXISTS rag.schema_embeddings CASCADE;

CREATE TABLE rag.schema_embeddings (
    embed_id        BIGSERIAL PRIMARY KEY,

    -- Multi-database support
    database_id     TEXT NOT NULL DEFAULT 'enterprise_erp',

    -- Entity identification
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('table', 'column')),
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    column_name     TEXT NULL,              -- NULL for table embeddings

    -- Module assignment (from rag.module_mapping or inferred)
    module          TEXT NULL,

    -- Semantic content
    gloss           TEXT NOT NULL,          -- Human-readable description
    synonyms        TEXT[] DEFAULT '{}',    -- Alternative terms for retrieval

    -- Embedding source text (what we actually embed)
    embed_text      TEXT NOT NULL,          -- Rich text chunk for embedding

    -- Compact schema for prompts (tables only)
    m_schema_compact TEXT NULL,             -- Dense DDL-like format, NULL for columns

    -- Column-specific metadata (columns only)
    data_type       TEXT NULL,
    is_pk           BOOLEAN DEFAULT FALSE,
    is_fk           BOOLEAN DEFAULT FALSE,
    fk_target       TEXT NULL,              -- 'schema.table.column' format
    is_nullable     BOOLEAN DEFAULT TRUE,
    is_generic      BOOLEAN DEFAULT FALSE,  -- True for id/name/status/created_at/etc

    -- Embedding
    embed_model     TEXT NOT NULL DEFAULT 'nomic-embed-text',
    embedding       vector(768) NOT NULL,

    -- Metadata
    fingerprint     TEXT NOT NULL,          -- For change detection
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Constraints
    UNIQUE (database_id, entity_type, table_schema, table_name, column_name)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- HNSW index for fast similarity search (cosine distance)
CREATE INDEX idx_embeddings_hnsw ON rag.schema_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Lookup indexes
CREATE INDEX idx_embeddings_entity_type ON rag.schema_embeddings (database_id, entity_type);
CREATE INDEX idx_embeddings_table ON rag.schema_embeddings (database_id, table_schema, table_name);
CREATE INDEX idx_embeddings_module ON rag.schema_embeddings (database_id, module);

-- ============================================================================
-- Table: rag.generic_columns
-- Columns to downweight in scoring (0.7x factor)
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.generic_columns (
    column_pattern  TEXT PRIMARY KEY,
    category        TEXT NOT NULL           -- 'pk', 'timestamp', 'audit', 'status'
);

INSERT INTO rag.generic_columns (column_pattern, category) VALUES
    -- Primary keys (generic identifiers)
    ('_id', 'pk'),
    ('id', 'pk'),

    -- Timestamps
    ('created_at', 'timestamp'),
    ('updated_at', 'timestamp'),
    ('deleted_at', 'timestamp'),
    ('modified_at', 'timestamp'),

    -- Audit columns
    ('created_by', 'audit'),
    ('updated_by', 'audit'),
    ('modified_by', 'audit'),

    -- Generic status/type
    ('status', 'status'),
    ('is_active', 'status'),
    ('is_deleted', 'status'),

    -- Generic names (context-dependent)
    ('name', 'generic'),
    ('description', 'generic'),
    ('notes', 'generic'),
    ('comments', 'generic')
ON CONFLICT (column_pattern) DO NOTHING;

-- ============================================================================
-- View: rag.retrieval_stats
-- For debugging retrieval quality
-- ============================================================================
CREATE OR REPLACE VIEW rag.retrieval_stats AS
SELECT
    database_id,
    entity_type,
    module,
    COUNT(*) AS embedding_count,
    COUNT(*) FILTER (WHERE is_generic) AS generic_count,
    AVG(LENGTH(embed_text)) AS avg_embed_text_length
FROM rag.schema_embeddings
GROUP BY database_id, entity_type, module
ORDER BY database_id, entity_type, module;

-- ============================================================================
-- Function: Check if column is generic (for scoring downweight)
-- ============================================================================
CREATE OR REPLACE FUNCTION rag.is_generic_column(p_column_name TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM rag.generic_columns
        WHERE p_column_name LIKE '%' || column_pattern
           OR p_column_name = column_pattern
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- Verification
-- ============================================================================
SELECT
    'rag.schema_embeddings' AS table_name,
    (SELECT COUNT(*) FROM rag.schema_embeddings) AS row_count;

SELECT
    'rag.generic_columns' AS table_name,
    (SELECT COUNT(*) FROM rag.generic_columns) AS row_count;
