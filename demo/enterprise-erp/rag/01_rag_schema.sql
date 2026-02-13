-- ============================================================================
-- RAG Schema Tables for NL2SQL
-- Phase A: Schema Infrastructure
-- ============================================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create rag schema
CREATE SCHEMA IF NOT EXISTS rag;

-- ============================================================================
-- Table: rag.schema_tables
-- Master table registry with module assignments and hub detection
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.schema_tables (
    table_id        BIGSERIAL PRIMARY KEY,
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    module          TEXT NULL,              -- HR, Finance, Sales, Procurement, Inventory, Projects, Assets, Common
    table_gloss     TEXT NULL,              -- Inferred or curated description
    fk_degree       INTEGER DEFAULT 0,      -- Count of inbound + outbound FKs
    is_hub          BOOLEAN DEFAULT FALSE,  -- TRUE if fk_degree > 8
    fingerprint     TEXT NOT NULL,          -- Hash for schema change detection
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (table_schema, table_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_tables_module
    ON rag.schema_tables (module);

-- ============================================================================
-- Table: rag.schema_columns
-- Column metadata with inferred glosses
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.schema_columns (
    column_id       BIGSERIAL PRIMARY KEY,
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    column_name     TEXT NOT NULL,
    data_type       TEXT NOT NULL,
    is_nullable     BOOLEAN NOT NULL,
    ordinal_pos     INTEGER NOT NULL,

    is_pk           BOOLEAN NOT NULL DEFAULT FALSE,
    pk_ordinal      INTEGER NULL,

    is_fk           BOOLEAN NOT NULL DEFAULT FALSE,
    fk_target_table TEXT NULL,              -- e.g., 'employees'
    fk_target_column TEXT NULL,             -- e.g., 'employee_id'

    comment         TEXT NULL,              -- From pg_description (likely null)
    inferred_gloss  TEXT NULL,              -- Generated from name + glossary + FK context

    fingerprint     TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (table_schema, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_columns_table
    ON rag.schema_columns (table_schema, table_name);

CREATE INDEX IF NOT EXISTS idx_rag_columns_trgm
    ON rag.schema_columns USING gin (column_name gin_trgm_ops);

-- ============================================================================
-- Table: rag.schema_fks
-- Foreign key relationships for graph traversal
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.schema_fks (
    fk_id               BIGSERIAL PRIMARY KEY,
    table_schema        TEXT NOT NULL DEFAULT 'public',
    table_name          TEXT NOT NULL,
    column_name         TEXT NOT NULL,

    ref_table_schema    TEXT NOT NULL DEFAULT 'public',
    ref_table_name      TEXT NOT NULL,
    ref_column_name     TEXT NOT NULL,

    constraint_name     TEXT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (constraint_name, table_schema, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_fks_from
    ON rag.schema_fks (table_schema, table_name);

CREATE INDEX IF NOT EXISTS idx_rag_fks_to
    ON rag.schema_fks (ref_table_schema, ref_table_name);

-- ============================================================================
-- Table: rag.schema_embeddings
-- Vector embeddings for tables and columns
-- entity_type = 'table' or 'column'
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.schema_embeddings (
    embed_id        BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('table', 'column')),
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    column_name     TEXT NULL,              -- NULL for table embeddings

    embed_model     TEXT NOT NULL,          -- e.g., 'nomic-embed-text'
    embed_dim       INTEGER NOT NULL,       -- e.g., 384 or 768
    embed_text      TEXT NOT NULL,          -- The text that was embedded
    embedding       vector(384) NOT NULL,   -- CHANGE DIM HERE if using different model

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
);

-- HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_rag_embed_hnsw
    ON rag.schema_embeddings
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_rag_embed_lookup
    ON rag.schema_embeddings (entity_type, table_schema, table_name);

-- ============================================================================
-- Table: rag.glossary
-- ERP abbreviation dictionary for gloss inference
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.glossary (
    abbrev      TEXT PRIMARY KEY,
    expansion   TEXT NOT NULL,
    category    TEXT NULL       -- 'column_prefix', 'domain_term', etc.
);

-- ============================================================================
-- Table: rag.module_mapping
-- Module assignments for tables (source of truth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.module_mapping (
    table_name  TEXT PRIMARY KEY,
    module      TEXT NOT NULL
);

-- ============================================================================
-- Verification query
-- ============================================================================
SELECT
    schemaname,
    tablename
FROM pg_tables
WHERE schemaname = 'rag'
ORDER BY tablename;
