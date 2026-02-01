-- ============================================================================
-- Infer Glosses: Generate human-readable column descriptions
-- Phase A: Schema Infrastructure
-- ============================================================================

-- ============================================================================
-- Step 1: Load glossary abbreviations into rag.glossary
-- ============================================================================
TRUNCATE rag.glossary;

INSERT INTO rag.glossary (abbrev, expansion, category) VALUES
    -- Common abbreviations
    ('emp', 'employee', 'prefix'),
    ('dept', 'department', 'prefix'),
    ('mgr', 'manager', 'prefix'),
    ('amt', 'amount', 'suffix'),
    ('qty', 'quantity', 'suffix'),
    ('num', 'number', 'prefix'),
    ('desc', 'description', 'suffix'),
    ('fy', 'fiscal year', 'prefix'),
    ('fp', 'fiscal period', 'prefix'),
    ('cc', 'cost center', 'prefix'),
    ('bu', 'business unit', 'prefix'),
    ('gl', 'general ledger', 'prefix'),
    ('ap', 'accounts payable', 'prefix'),
    ('ar', 'accounts receivable', 'prefix'),
    ('po', 'purchase order', 'prefix'),
    ('so', 'sales order', 'prefix'),
    ('pr', 'purchase requisition', 'prefix'),
    ('wip', 'work in progress', 'prefix'),
    ('bom', 'bill of materials', 'prefix'),
    ('uom', 'unit of measure', 'prefix'),
    ('sku', 'stock keeping unit', 'prefix'),
    ('coa', 'chart of accounts', 'prefix'),
    ('pto', 'paid time off', 'prefix'),
    ('ytd', 'year to date', 'prefix'),
    ('mtd', 'month to date', 'prefix'),
    ('acct', 'account', 'prefix'),
    ('addr', 'address', 'prefix'),
    ('org', 'organization', 'prefix'),
    ('pos', 'position', 'prefix'),
    ('loc', 'location', 'prefix'),
    ('inv', 'inventory', 'prefix'),
    ('txn', 'transaction', 'prefix'),
    ('xfer', 'transfer', 'prefix'),
    ('rcpt', 'receipt', 'prefix'),
    ('adj', 'adjustment', 'prefix'),
    ('alloc', 'allocation', 'prefix'),
    ('pct', 'percent', 'suffix'),
    ('dt', 'date', 'suffix'),
    ('ts', 'timestamp', 'suffix'),
    ('yr', 'year', 'suffix'),
    ('mo', 'month', 'suffix'),
    ('wk', 'week', 'suffix'),
    ('no', 'number', 'suffix'),
    ('nbr', 'number', 'suffix'),
    ('curr', 'currency', 'prefix'),
    ('src', 'source', 'prefix'),
    ('tgt', 'target', 'prefix'),
    ('cat', 'category', 'prefix'),
    ('grp', 'group', 'prefix'),
    ('lvl', 'level', 'suffix'),
    ('typ', 'type', 'suffix'),
    ('stat', 'status', 'suffix'),
    ('flg', 'flag', 'suffix'),
    ('ind', 'indicator', 'suffix'),
    ('cd', 'code', 'suffix'),
    ('nm', 'name', 'suffix'),
    ('val', 'value', 'suffix'),
    ('bal', 'balance', 'suffix'),
    ('pymt', 'payment', 'prefix'),
    ('recv', 'receivable', 'suffix'),
    ('paybl', 'payable', 'suffix'),
    ('sched', 'schedule', 'prefix'),
    ('maint', 'maintenance', 'prefix'),
    ('depr', 'depreciation', 'prefix'),
    ('accum', 'accumulated', 'prefix'),
    ('cert', 'certification', 'prefix'),
    ('perf', 'performance', 'prefix'),
    ('eval', 'evaluation', 'suffix'),
    ('rev', 'revenue', 'prefix'),
    ('exp', 'expense', 'prefix'),
    ('cogs', 'cost of goods sold', 'prefix'),
    ('opex', 'operating expense', 'prefix'),
    ('capex', 'capital expenditure', 'prefix'),
    ('min', 'minimum', 'prefix'),
    ('max', 'maximum', 'prefix'),
    ('avg', 'average', 'prefix'),
    ('tot', 'total', 'prefix'),
    ('sub', 'subtotal', 'prefix')
ON CONFLICT (abbrev) DO UPDATE SET expansion = EXCLUDED.expansion;

-- ============================================================================
-- Step 2: Generate inferred glosses using rules
-- ============================================================================

-- Create a function to generate gloss from column name and context
CREATE OR REPLACE FUNCTION rag.generate_column_gloss(
    p_table_name TEXT,
    p_column_name TEXT,
    p_data_type TEXT,
    p_is_pk BOOLEAN,
    p_is_fk BOOLEAN,
    p_fk_target_table TEXT,
    p_fk_target_column TEXT
) RETURNS TEXT AS $$
DECLARE
    v_gloss TEXT;
    v_words TEXT[];
    v_word TEXT;
    v_expanded TEXT;
    v_result TEXT := '';
BEGIN
    -- Rule 1: Primary key
    IF p_is_pk THEN
        v_gloss := 'Primary key';
        IF p_column_name LIKE '%_id' THEN
            v_gloss := v_gloss || ' - unique identifier';
        END IF;
        RETURN v_gloss;
    END IF;

    -- Rule 2: Foreign key with context
    IF p_is_fk AND p_fk_target_table IS NOT NULL THEN
        v_gloss := 'FK to ' || p_fk_target_table;
        -- Add semantic context based on column name
        IF p_column_name LIKE 'manager%' THEN
            v_gloss := 'Manager (' || v_gloss || ')';
        ELSIF p_column_name LIKE 'approved_by%' OR p_column_name LIKE '%_approved_by' THEN
            v_gloss := 'Approver (' || v_gloss || ')';
        ELSIF p_column_name LIKE 'created_by%' THEN
            v_gloss := 'Creator (' || v_gloss || ')';
        ELSIF p_column_name LIKE '%_by' THEN
            v_gloss := 'Performed by (' || v_gloss || ')';
        END IF;
        RETURN v_gloss;
    END IF;

    -- Rule 3: Expand column name using glossary and patterns
    -- Split on underscores
    v_words := string_to_array(p_column_name, '_');

    FOREACH v_word IN ARRAY v_words LOOP
        -- Check glossary for expansion
        SELECT expansion INTO v_expanded
        FROM rag.glossary
        WHERE abbrev = lower(v_word)
        LIMIT 1;

        IF v_expanded IS NOT NULL THEN
            v_result := v_result || ' ' || initcap(v_expanded);
        ELSE
            v_result := v_result || ' ' || initcap(v_word);
        END IF;
    END LOOP;

    v_gloss := trim(v_result);

    -- Rule 4: Add type hints based on data type
    IF p_data_type IN ('date', 'timestamp', 'timestamptz') THEN
        IF p_column_name LIKE '%_at' THEN
            v_gloss := v_gloss || ' timestamp';
        ELSIF p_column_name NOT LIKE '%date%' THEN
            v_gloss := v_gloss || ' (date)';
        END IF;
    ELSIF p_data_type IN ('numeric', 'decimal', 'money') THEN
        IF p_column_name LIKE '%amount%' OR p_column_name LIKE '%cost%' OR
           p_column_name LIKE '%price%' OR p_column_name LIKE '%total%' OR
           p_column_name LIKE '%salary%' OR p_column_name LIKE '%budget%' THEN
            v_gloss := v_gloss || ' (monetary)';
        ELSIF p_column_name LIKE '%rate%' OR p_column_name LIKE '%percent%' THEN
            v_gloss := v_gloss || ' (rate/percentage)';
        END IF;
    ELSIF p_data_type = 'boolean' THEN
        IF v_gloss NOT LIKE '%flag%' AND v_gloss NOT LIKE '%indicator%' THEN
            v_gloss := v_gloss || ' flag';
        END IF;
    END IF;

    -- Rule 5: Special column patterns
    IF p_column_name = 'status' THEN
        v_gloss := 'Status (e.g., pending, active, completed)';
    ELSIF p_column_name = 'created_at' THEN
        v_gloss := 'Record creation timestamp';
    ELSIF p_column_name = 'updated_at' THEN
        v_gloss := 'Last update timestamp';
    ELSIF p_column_name = 'is_active' THEN
        v_gloss := 'Active/inactive flag';
    ELSIF p_column_name = 'name' THEN
        v_gloss := initcap(replace(p_table_name, '_', ' ')) || ' name';
    ELSIF p_column_name = 'description' THEN
        v_gloss := initcap(replace(p_table_name, '_', ' ')) || ' description';
    ELSIF p_column_name = 'email' THEN
        v_gloss := 'Email address';
    ELSIF p_column_name = 'phone' THEN
        v_gloss := 'Phone number';
    END IF;

    RETURN v_gloss;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Step 3: Apply gloss generation to all columns
-- ============================================================================
UPDATE rag.schema_columns c
SET inferred_gloss = rag.generate_column_gloss(
    c.table_name,
    c.column_name,
    c.data_type,
    c.is_pk,
    c.is_fk,
    c.fk_target_table,
    c.fk_target_column
),
updated_at = now();

-- ============================================================================
-- Step 4: Generate table glosses
-- ============================================================================
UPDATE rag.schema_tables t
SET table_gloss = (
    SELECT initcap(replace(t.table_name, '_', ' ')) || ': ' ||
           string_agg(c.column_name, ', ' ORDER BY c.ordinal_pos)
    FROM rag.schema_columns c
    WHERE c.table_schema = t.table_schema
      AND c.table_name = t.table_name
      AND c.ordinal_pos <= 5  -- First 5 columns only for brevity
),
updated_at = now();

-- ============================================================================
-- Verification: Sample glosses
-- ============================================================================
SELECT
    table_name,
    column_name,
    data_type,
    is_pk,
    is_fk,
    fk_target_table,
    inferred_gloss
FROM rag.schema_columns
WHERE table_name IN ('employees', 'sales_orders', 'journal_entries')
ORDER BY table_name, ordinal_pos
LIMIT 30;
