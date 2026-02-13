-- ============================================================================
-- RAG Schema Setup for enterprise_erp_2000
-- Populates rag.* from 20 division schemas (162 unique tables)
-- ============================================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create rag schema
CREATE SCHEMA IF NOT EXISTS rag;

-- ============================================================================
-- Create RAG tables (same structure as original)
-- ============================================================================
CREATE TABLE IF NOT EXISTS rag.schema_tables (
    table_id        BIGSERIAL PRIMARY KEY,
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    module          TEXT NULL,
    table_gloss     TEXT NULL,
    fk_degree       INTEGER DEFAULT 0,
    is_hub          BOOLEAN DEFAULT FALSE,
    fingerprint     TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (table_schema, table_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_tables_module
    ON rag.schema_tables (module);

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
    fk_target_table TEXT NULL,
    fk_target_column TEXT NULL,
    comment         TEXT NULL,
    inferred_gloss  TEXT NULL,
    fingerprint     TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (table_schema, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_columns_table
    ON rag.schema_columns (table_schema, table_name);

CREATE INDEX IF NOT EXISTS idx_rag_columns_trgm
    ON rag.schema_columns USING gin (column_name gin_trgm_ops);

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

CREATE TABLE IF NOT EXISTS rag.schema_embeddings (
    embed_id        BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('table', 'column')),
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    column_name     TEXT NULL,
    embed_model     TEXT NOT NULL,
    embed_dim       INTEGER NOT NULL,
    embed_text      TEXT NOT NULL,
    embedding       vector(768) NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
);

CREATE INDEX IF NOT EXISTS idx_rag_embed_hnsw
    ON rag.schema_embeddings
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_rag_embed_lookup
    ON rag.schema_embeddings (entity_type, table_schema, table_name);

CREATE TABLE IF NOT EXISTS rag.glossary (
    abbrev      TEXT PRIMARY KEY,
    expansion   TEXT NOT NULL,
    category    TEXT NULL
);

CREATE TABLE IF NOT EXISTS rag.module_mapping (
    table_name  TEXT PRIMARY KEY,
    module      TEXT NOT NULL
);

-- ============================================================================
-- BM25 support
-- ============================================================================
ALTER TABLE rag.schema_embeddings ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_rag_embed_bm25
    ON rag.schema_embeddings USING gin (search_vector);

-- Module embeddings for module router
CREATE TABLE IF NOT EXISTS rag.module_embeddings (
    module_id   SERIAL PRIMARY KEY,
    module_name TEXT NOT NULL UNIQUE,
    embedding   vector(768) NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Step 1: Module mapping for ALL tables (base + deepening + archetype)
-- ============================================================================
TRUNCATE rag.module_mapping;

INSERT INTO rag.module_mapping (table_name, module) VALUES
    -- Common Module
    ('countries', 'Common'),
    ('states_provinces', 'Common'),
    ('cities', 'Common'),
    ('addresses', 'Common'),
    ('currencies', 'Common'),
    ('business_units', 'Common'),
    ('cost_centers', 'Common'),
    ('audit_log', 'Common'),
    ('document_attachments', 'Common'),
    ('lookup_codes', 'Common'),

    -- HR Module
    ('departments', 'HR'),
    ('positions', 'HR'),
    ('employees', 'HR'),
    ('employee_salaries', 'HR'),
    ('benefit_types', 'HR'),
    ('employee_benefits', 'HR'),
    ('leave_types', 'HR'),
    ('leave_requests', 'HR'),
    ('certifications', 'HR'),
    ('employee_certifications', 'HR'),
    ('performance_reviews', 'HR'),
    ('training_courses', 'HR'),
    ('employee_training', 'HR'),
    ('emergency_contacts', 'HR'),
    ('employment_history', 'HR'),
    ('hr_benefit_elections', 'HR'),
    ('hr_onboarding_tasks', 'HR'),
    ('hr_time_clock_entries', 'HR'),
    ('payroll_run_hdr', 'HR'),
    ('payroll_run_line', 'HR'),

    -- Finance Module
    ('account_types', 'Finance'),
    ('chart_of_accounts', 'Finance'),
    ('fiscal_years', 'Finance'),
    ('fiscal_periods', 'Finance'),
    ('journal_entries', 'Finance'),
    ('journal_lines', 'Finance'),
    ('budgets', 'Finance'),
    ('budget_lines', 'Finance'),
    ('bank_accounts', 'Finance'),
    ('bank_transactions', 'Finance'),
    ('tax_rates', 'Finance'),
    ('finance_ar_invoices', 'Finance'),
    ('finance_ar_payments', 'Finance'),
    ('finance_ap_invoices', 'Finance'),

    -- Sales Module
    ('customers', 'Sales'),
    ('customer_contacts', 'Sales'),
    ('sales_regions', 'Sales'),
    ('sales_territories', 'Sales'),
    ('opportunity_stages', 'Sales'),
    ('sales_opportunities', 'Sales'),
    ('sales_quotes', 'Sales'),
    ('quote_lines', 'Sales'),
    ('sales_orders', 'Sales'),
    ('order_lines', 'Sales'),
    ('customer_ship_to_sites', 'Sales'),

    -- Procurement Module
    ('vendors', 'Procurement'),
    ('vendor_contacts', 'Procurement'),
    ('purchase_requisitions', 'Procurement'),
    ('requisition_lines', 'Procurement'),
    ('purchase_orders', 'Procurement'),
    ('po_lines', 'Procurement'),
    ('goods_receipts', 'Procurement'),
    ('receipt_lines', 'Procurement'),
    ('vendor_invoices', 'Procurement'),
    ('vendor_invoice_lines', 'Procurement'),
    ('procurement_rfqs', 'Procurement'),
    ('procurement_rfq_responses', 'Procurement'),
    ('procurement_po_approvals', 'Procurement'),

    -- Inventory Module
    ('product_categories', 'Inventory'),
    ('units_of_measure', 'Inventory'),
    ('products', 'Inventory'),
    ('product_suppliers', 'Inventory'),
    ('warehouses', 'Inventory'),
    ('warehouse_locations', 'Inventory'),
    ('inventory_levels', 'Inventory'),
    ('inventory_transactions', 'Inventory'),
    ('stock_transfers', 'Inventory'),
    ('transfer_lines', 'Inventory'),
    ('inventory_adjustments', 'Inventory'),
    ('adjustment_lines', 'Inventory'),
    ('reorder_rules', 'Inventory'),
    ('inventory_lots', 'Inventory'),
    ('inventory_qc_inspections', 'Inventory'),

    -- Projects Module
    ('projects', 'Projects'),
    ('project_phases', 'Projects'),
    ('project_tasks', 'Projects'),
    ('task_assignments', 'Projects'),
    ('project_milestones', 'Projects'),
    ('project_budgets', 'Projects'),
    ('project_expenses', 'Projects'),
    ('timesheets', 'Projects'),
    ('timesheet_entries', 'Projects'),
    ('project_resources', 'Projects'),
    ('project_cost_allocations', 'Projects'),

    -- Assets Module
    ('asset_categories', 'Assets'),
    ('asset_locations', 'Assets'),
    ('fixed_assets', 'Assets'),
    ('depreciation_schedules', 'Assets'),
    ('depreciation_entries', 'Assets'),
    ('maintenance_types', 'Assets'),
    ('asset_maintenance', 'Assets'),
    ('asset_transfers', 'Assets'),

    -- Support Module
    ('cust_srv_case', 'Support'),
    ('support_ticket_comments', 'Support'),

    -- Workflow Module
    ('wf_approval_step', 'Workflow'),
    ('cost_center_assignments', 'Workflow'),

    -- Manufacturing Module (clean + dirty)
    ('mfg_work_orders', 'Manufacturing'),
    ('mfg_wo_operations', 'Manufacturing'),
    ('mfg_work_centers', 'Manufacturing'),
    ('mfg_bill_of_materials', 'Manufacturing'),
    ('mfg_bom_revisions', 'Manufacturing'),
    ('mfg_quality_holds', 'Manufacturing'),
    ('mfg_scrap_log', 'Manufacturing'),
    ('mfg_routing_master', 'Manufacturing'),
    ('xx_mfg_wo', 'Manufacturing'),
    ('xx_mfg_wo_ops', 'Manufacturing'),
    ('xx_mfg_wc', 'Manufacturing'),
    ('xx_mfg_bom', 'Manufacturing'),
    ('xx_mfg_bom_rev', 'Manufacturing'),
    ('xx_mfg_qhold', 'Manufacturing'),
    ('xx_mfg_scrap', 'Manufacturing'),
    ('xx_mfg_routing', 'Manufacturing'),

    -- Services Module (clean + dirty)
    ('svc_statements_of_work', 'Services'),
    ('svc_deliverables', 'Services'),
    ('svc_resource_plan', 'Services'),
    ('svc_billing_milestones', 'Services'),
    ('svc_skill_matrix', 'Services'),
    ('svc_engagement_log', 'Services'),
    ('svc_rate_cards', 'Services'),
    ('zz_svc_sow', 'Services'),
    ('zz_svc_dlvr', 'Services'),
    ('zz_svc_rsrc_plan', 'Services'),
    ('zz_svc_bill_ms', 'Services'),
    ('zz_svc_skill', 'Services'),
    ('zz_svc_engage_log', 'Services'),
    ('zz_svc_rate_cd', 'Services'),

    -- Retail Module (clean + dirty)
    ('rtl_pos_transactions', 'Retail'),
    ('rtl_pos_line_items', 'Retail'),
    ('rtl_loyalty_members', 'Retail'),
    ('rtl_loyalty_txns', 'Retail'),
    ('rtl_promotions', 'Retail'),
    ('rtl_promo_products', 'Retail'),
    ('rtl_store_inventory', 'Retail'),
    ('zz_pos_trnx', 'Retail'),
    ('zz_pos_ln', 'Retail'),
    ('zz_loy_mbr', 'Retail'),
    ('zz_loy_txn', 'Retail'),
    ('zz_rtl_promo', 'Retail'),
    ('zz_rtl_promo_prod', 'Retail'),
    ('zz_rtl_store_inv', 'Retail'),

    -- Corporate Module
    ('corp_intercompany_txns', 'Corporate'),
    ('corp_consolidation_entries', 'Corporate'),
    ('corp_elimination_entries', 'Corporate'),
    ('corp_statutory_reports', 'Corporate'),
    ('corp_tax_provisions', 'Corporate'),
    ('corp_audit_findings', 'Corporate'),
    ('corp_compliance_checklists', 'Corporate')
ON CONFLICT (table_name) DO UPDATE SET module = EXCLUDED.module;

-- ============================================================================
-- Step 2: Build a temp table mapping each unique table_name to ONE
--         representative source schema for introspection
-- ============================================================================
CREATE TEMP TABLE representative_tables AS
WITH ranked AS (
    SELECT
        t.table_name,
        t.table_schema,
        ROW_NUMBER() OVER (
            PARTITION BY t.table_name
            ORDER BY
                -- Prefer clean divisions (div_01, div_06, div_11, div_16)
                CASE t.table_schema
                    WHEN 'div_01' THEN 1
                    WHEN 'div_06' THEN 2
                    WHEN 'div_11' THEN 3
                    WHEN 'div_16' THEN 4
                    WHEN 'div_02' THEN 5  -- dirty mfg
                    WHEN 'div_07' THEN 6  -- dirty svc
                    WHEN 'div_12' THEN 7  -- dirty rtl
                    ELSE 10
                END
        ) AS rn
    FROM information_schema.tables t
    WHERE t.table_schema LIKE 'div_%'
      AND t.table_type = 'BASE TABLE'
)
SELECT table_name, table_schema AS source_schema
FROM ranked
WHERE rn = 1;

-- ============================================================================
-- Step 3: Populate rag.schema_tables
-- ============================================================================
TRUNCATE rag.schema_tables CASCADE;

INSERT INTO rag.schema_tables (table_schema, table_name, module, fingerprint)
SELECT
    'public' AS table_schema,  -- Use 'public' so retriever works as-is
    rt.table_name,
    m.module,
    md5(
        rt.source_schema || '.' || rt.table_name || ':' ||
        string_agg(c.column_name || ':' || c.data_type, ',' ORDER BY c.ordinal_position)
    ) AS fingerprint
FROM representative_tables rt
JOIN information_schema.columns c
    ON c.table_schema = rt.source_schema AND c.table_name = rt.table_name
LEFT JOIN rag.module_mapping m ON m.table_name = rt.table_name
GROUP BY rt.source_schema, rt.table_name, m.module;

-- ============================================================================
-- Step 4: Populate rag.schema_fks (deduplicated across schemas)
-- ============================================================================
TRUNCATE rag.schema_fks;

INSERT INTO rag.schema_fks (
    table_schema, table_name, column_name,
    ref_table_schema, ref_table_name, ref_column_name,
    constraint_name
)
SELECT DISTINCT ON (kcu.table_name, kcu.column_name, ccu.table_name, ccu.column_name)
    'public' AS table_schema,
    kcu.table_name,
    kcu.column_name,
    'public' AS ref_table_schema,
    ccu.table_name AS ref_table_name,
    ccu.column_name AS ref_column_name,
    tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
JOIN representative_tables rt
    ON rt.table_name = kcu.table_name AND rt.source_schema = kcu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
ORDER BY kcu.table_name, kcu.column_name, ccu.table_name, ccu.column_name, tc.constraint_name;

-- ============================================================================
-- Step 5: Identify primary keys
-- ============================================================================
CREATE TEMP TABLE temp_pks AS
SELECT DISTINCT ON (kcu.table_name, kcu.column_name)
    'public' AS table_schema,
    kcu.table_name,
    kcu.column_name,
    kcu.ordinal_position AS pk_ordinal
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN representative_tables rt
    ON rt.table_name = kcu.table_name AND rt.source_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
ORDER BY kcu.table_name, kcu.column_name;

-- ============================================================================
-- Step 6: Populate rag.schema_columns
-- ============================================================================
TRUNCATE rag.schema_columns;

INSERT INTO rag.schema_columns (
    table_schema, table_name, column_name, data_type, is_nullable, ordinal_pos,
    is_pk, pk_ordinal, is_fk, fk_target_table, fk_target_column,
    comment, fingerprint
)
SELECT
    'public' AS table_schema,
    c.table_name,
    c.column_name,
    c.data_type,
    (c.is_nullable = 'YES') AS is_nullable,
    c.ordinal_position,
    (pk.column_name IS NOT NULL) AS is_pk,
    pk.pk_ordinal,
    (fk.column_name IS NOT NULL) AS is_fk,
    fk.ref_table_name AS fk_target_table,
    fk.ref_column_name AS fk_target_column,
    NULL AS comment,
    md5('public.' || c.table_name || '.' || c.column_name || ':' || c.data_type || ':' || c.is_nullable) AS fingerprint
FROM representative_tables rt
JOIN information_schema.columns c
    ON c.table_schema = rt.source_schema AND c.table_name = rt.table_name
LEFT JOIN temp_pks pk
    ON pk.table_name = c.table_name
    AND pk.column_name = c.column_name
LEFT JOIN rag.schema_fks fk
    ON fk.table_name = c.table_name
    AND fk.column_name = c.column_name
ORDER BY c.table_name, c.ordinal_position;

DROP TABLE temp_pks;
DROP TABLE representative_tables;

-- ============================================================================
-- Step 7: Compute FK degree and hub status
-- ============================================================================
UPDATE rag.schema_tables st
SET fk_degree = sub.degree,
    is_hub = sub.degree > 8
FROM (
    SELECT table_name, COUNT(*) AS degree
    FROM (
        SELECT table_name FROM rag.schema_fks
        UNION ALL
        SELECT ref_table_name FROM rag.schema_fks
    ) all_fks
    GROUP BY table_name
) sub
WHERE st.table_name = sub.table_name;

-- ============================================================================
-- Verification
-- ============================================================================
SELECT 'rag.schema_tables' AS table_name, COUNT(*) AS row_count FROM rag.schema_tables
UNION ALL
SELECT 'rag.schema_columns', COUNT(*) FROM rag.schema_columns
UNION ALL
SELECT 'rag.schema_fks', COUNT(*) FROM rag.schema_fks
UNION ALL
SELECT 'rag.module_mapping', COUNT(*) FROM rag.module_mapping;
