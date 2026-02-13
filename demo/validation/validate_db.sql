-- Validation checks for 2000-table ERP

DROP TABLE IF EXISTS validation_results;
CREATE TEMP TABLE validation_results (
    category TEXT,
    division TEXT,
    metric TEXT,
    value NUMERIC
);

-- Table counts per division
INSERT INTO validation_results (category, division, metric, value)
SELECT 'schema', table_schema, 'table_count', COUNT(*)::NUMERIC
FROM information_schema.tables
WHERE table_schema LIKE 'div_%'
  AND table_type = 'BASE TABLE'
GROUP BY table_schema;

-- Orphan checks (deepened tables)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'div_%' LOOP
    EXECUTE format(
      'INSERT INTO validation_results (category, division, metric, value)
       SELECT ''orphan'', %L, ''cust_srv_case_orphans'', COUNT(*)
       FROM %I.cust_srv_case c
       LEFT JOIN %I.customers cu ON cu.customer_id = c.cust_id
       WHERE cu.customer_id IS NULL', r.schema_name, r.schema_name, r.schema_name);

    EXECUTE format(
      'INSERT INTO validation_results (category, division, metric, value)
       SELECT ''orphan'', %L, ''payroll_line_orphans'', COUNT(*)
       FROM %I.payroll_run_line l
       LEFT JOIN %I.payroll_run_hdr h ON h.run_id = l.run_id
       WHERE h.run_id IS NULL', r.schema_name, r.schema_name, r.schema_name);
  END LOOP;
END $$;

-- Workflow plausibility: receipts should not be before PO order date
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'div_%' LOOP
    EXECUTE format(
      'INSERT INTO validation_results (category, division, metric, value)
       SELECT ''workflow'', %L, ''receipt_before_po'', COUNT(*)
       FROM %I.goods_receipts gr
       JOIN %I.purchase_orders po ON po.po_id = gr.po_id
       WHERE gr.receipt_date < po.order_date', r.schema_name, r.schema_name, r.schema_name);
  END LOOP;
END $$;

-- Distribution check: sales orders per division
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'div_%' LOOP
    EXECUTE format(
      'INSERT INTO validation_results (category, division, metric, value)
       SELECT ''distribution'', %L, ''sales_orders'', COUNT(*)
       FROM %I.sales_orders', r.schema_name, r.schema_name);
  END LOOP;
END $$;

-- Summary output
SELECT category, division, metric, value
FROM validation_results
ORDER BY category, division, metric;
