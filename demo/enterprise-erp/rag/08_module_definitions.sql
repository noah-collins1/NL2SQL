-- Migration 08: rag.module_definitions
-- Replaces hardcoded MODULE_KEYWORDS in TypeScript with DB-driven per-database definitions.
-- Each row defines one module: its human-readable description (used for embedding)
-- and its keyword list (used for fast keyword-based routing before embedding lookup).
--
-- Run against any database that has the rag schema (enterprise_erp_2000, industry-erp, etc.).
-- The TypeScript module router falls back to hardcoded keywords if this table is absent.

CREATE TABLE IF NOT EXISTS rag.module_definitions (
    module_id   SERIAL PRIMARY KEY,
    module_name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,          -- Rich text embedded for cosine-similarity routing
    keywords    TEXT[] NOT NULL DEFAULT '{}',  -- Fast keyword matching (lowercase tokens)
    table_prefixes TEXT[] NOT NULL DEFAULT '{}', -- Table name prefixes that belong to this module
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  rag.module_definitions IS 'Per-database module definitions for the module router. Keywords drive fast keyword matching; description is embedded for cosine-similarity routing.';
COMMENT ON COLUMN rag.module_definitions.description IS 'Rich text description of the module — embedded via nomic-embed-text for semantic module routing.';
COMMENT ON COLUMN rag.module_definitions.keywords IS 'Lowercase keyword tokens. Any token match scores 1.0 for this module in the keyword router.';
COMMENT ON COLUMN rag.module_definitions.table_prefixes IS 'Table name prefixes (e.g. tblso) used by setup_rag.py to assign modules to tables.';
