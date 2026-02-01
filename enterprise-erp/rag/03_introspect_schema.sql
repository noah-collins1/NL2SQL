-- ============================================================================
-- Introspect Schema: Populate rag.* tables from information_schema
-- Phase A: Schema Infrastructure
-- ============================================================================

-- ============================================================================
-- Step 1: Populate module mapping (from erp_sidecar_config.py)
-- ============================================================================
TRUNCATE rag.module_mapping;

INSERT INTO rag.module_mapping (table_name, module) VALUES
    -- Common Module (8 tables)
    ('countries', 'Common'),
    ('states_provinces', 'Common'),
    ('cities', 'Common'),
    ('addresses', 'Common'),
    ('currencies', 'Common'),
    ('business_units', 'Common'),
    ('cost_centers', 'Common'),
    ('audit_log', 'Common'),
    ('document_attachments', 'Common'),

    -- HR Module (15 tables)
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

    -- Finance Module (12 tables)
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

    -- Sales Module (10 tables)
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

    -- Procurement Module (10 tables)
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

    -- Inventory Module (12 tables)
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

    -- Projects Module (10 tables)
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

    -- Assets Module (8 tables)
    ('asset_categories', 'Assets'),
    ('asset_locations', 'Assets'),
    ('fixed_assets', 'Assets'),
    ('depreciation_schedules', 'Assets'),
    ('depreciation_entries', 'Assets'),
    ('maintenance_types', 'Assets'),
    ('asset_maintenance', 'Assets'),
    ('asset_transfers', 'Assets')
ON CONFLICT (table_name) DO UPDATE SET module = EXCLUDED.module;

-- ============================================================================
-- Step 2: Populate rag.schema_tables from information_schema
-- ============================================================================
INSERT INTO rag.schema_tables (table_schema, table_name, module, fingerprint)
SELECT
    t.table_schema,
    t.table_name,
    m.module,
    md5(
        t.table_schema || '.' || t.table_name || ':' ||
        string_agg(c.column_name || ':' || c.data_type, ',' ORDER BY c.ordinal_position)
    ) AS fingerprint
FROM information_schema.tables t
JOIN information_schema.columns c
    ON c.table_schema = t.table_schema AND c.table_name = t.table_name
LEFT JOIN rag.module_mapping m ON m.table_name = t.table_name
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
GROUP BY t.table_schema, t.table_name, m.module
ON CONFLICT (table_schema, table_name)
DO UPDATE SET
    module = EXCLUDED.module,
    fingerprint = EXCLUDED.fingerprint,
    updated_at = now();

-- ============================================================================
-- Step 3: Populate rag.schema_fks from information_schema
-- ============================================================================
TRUNCATE rag.schema_fks;

INSERT INTO rag.schema_fks (
    table_schema, table_name, column_name,
    ref_table_schema, ref_table_name, ref_column_name,
    constraint_name
)
SELECT
    kcu.table_schema,
    kcu.table_name,
    kcu.column_name,
    ccu.table_schema AS ref_table_schema,
    ccu.table_name AS ref_table_name,
    ccu.column_name AS ref_column_name,
    tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public';

-- ============================================================================
-- Step 4: Identify primary keys
-- ============================================================================
CREATE TEMP TABLE temp_pks AS
SELECT
    kcu.table_schema,
    kcu.table_name,
    kcu.column_name,
    kcu.ordinal_position AS pk_ordinal
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema = 'public';

-- ============================================================================
-- Step 5: Populate rag.schema_columns with PK/FK info
-- ============================================================================
TRUNCATE rag.schema_columns;

INSERT INTO rag.schema_columns (
    table_schema, table_name, column_name, data_type, is_nullable, ordinal_pos,
    is_pk, pk_ordinal, is_fk, fk_target_table, fk_target_column,
    comment, fingerprint
)
SELECT
    c.table_schema,
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
    pd.description AS comment,
    md5(c.table_schema || '.' || c.table_name || '.' || c.column_name || ':' || c.data_type || ':' || c.is_nullable) AS fingerprint
FROM information_schema.columns c
LEFT JOIN temp_pks pk
    ON pk.table_schema = c.table_schema
    AND pk.table_name = c.table_name
    AND pk.column_name = c.column_name
LEFT JOIN rag.schema_fks fk
    ON fk.table_schema = c.table_schema
    AND fk.table_name = c.table_name
    AND fk.column_name = c.column_name
LEFT JOIN pg_catalog.pg_statio_all_tables st
    ON st.schemaname = c.table_schema AND st.relname = c.table_name
LEFT JOIN pg_catalog.pg_description pd
    ON pd.objoid = st.relid
    AND pd.objsubid = c.ordinal_position
WHERE c.table_schema = 'public'
ORDER BY c.table_schema, c.table_name, c.ordinal_position;

DROP TABLE temp_pks;

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
