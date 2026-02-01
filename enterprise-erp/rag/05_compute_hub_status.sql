-- ============================================================================
-- Compute Hub Status: Calculate FK degree and identify hub tables
-- Phase A: Schema Infrastructure
-- ============================================================================

-- ============================================================================
-- Step 1: Count outbound FKs (this table references others)
-- ============================================================================
CREATE TEMP TABLE temp_outbound_fks AS
SELECT
    table_schema,
    table_name,
    COUNT(*) AS outbound_count
FROM rag.schema_fks
GROUP BY table_schema, table_name;

-- ============================================================================
-- Step 2: Count inbound FKs (other tables reference this one)
-- ============================================================================
CREATE TEMP TABLE temp_inbound_fks AS
SELECT
    ref_table_schema AS table_schema,
    ref_table_name AS table_name,
    COUNT(*) AS inbound_count
FROM rag.schema_fks
GROUP BY ref_table_schema, ref_table_name;

-- ============================================================================
-- Step 3: Compute total FK degree and hub status
-- ============================================================================
UPDATE rag.schema_tables t
SET
    fk_degree = COALESCE(o.outbound_count, 0) + COALESCE(i.inbound_count, 0),
    is_hub = (COALESCE(o.outbound_count, 0) + COALESCE(i.inbound_count, 0)) > 8,
    updated_at = now()
FROM (SELECT table_schema, table_name FROM rag.schema_tables) AS base
LEFT JOIN temp_outbound_fks o
    ON o.table_schema = base.table_schema AND o.table_name = base.table_name
LEFT JOIN temp_inbound_fks i
    ON i.table_schema = base.table_schema AND i.table_name = base.table_name
WHERE t.table_schema = base.table_schema
  AND t.table_name = base.table_name;

DROP TABLE temp_outbound_fks;
DROP TABLE temp_inbound_fks;

-- ============================================================================
-- Step 4: Verification - Show hub tables and FK degrees
-- ============================================================================
SELECT
    table_name,
    module,
    fk_degree,
    is_hub,
    table_gloss
FROM rag.schema_tables
ORDER BY fk_degree DESC
LIMIT 20;

-- ============================================================================
-- Step 5: Summary statistics
-- ============================================================================
SELECT
    'Total tables' AS metric,
    COUNT(*)::TEXT AS value
FROM rag.schema_tables
UNION ALL
SELECT
    'Hub tables (fk_degree > 8)',
    COUNT(*)::TEXT
FROM rag.schema_tables WHERE is_hub = TRUE
UNION ALL
SELECT
    'Avg FK degree',
    ROUND(AVG(fk_degree), 2)::TEXT
FROM rag.schema_tables
UNION ALL
SELECT
    'Max FK degree',
    MAX(fk_degree)::TEXT
FROM rag.schema_tables
UNION ALL
SELECT
    'Tables by module',
    module || ': ' || COUNT(*)::TEXT
FROM rag.schema_tables
WHERE module IS NOT NULL
GROUP BY module
ORDER BY metric;

-- ============================================================================
-- Step 6: FK graph preview (for debugging)
-- ============================================================================
SELECT
    f.table_name AS from_table,
    t1.module AS from_module,
    f.column_name,
    f.ref_table_name AS to_table,
    t2.module AS to_module,
    t2.is_hub AS to_is_hub
FROM rag.schema_fks f
JOIN rag.schema_tables t1
    ON t1.table_schema = f.table_schema AND t1.table_name = f.table_name
JOIN rag.schema_tables t2
    ON t2.table_schema = f.ref_table_schema AND t2.table_name = f.ref_table_name
WHERE t1.module != t2.module  -- Cross-module FKs only
ORDER BY f.table_name
LIMIT 30;
