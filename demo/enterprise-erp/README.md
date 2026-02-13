# Enterprise ERP Database for NL2SQL Testing

A comprehensive 85-table Enterprise ERP database designed to test NL2SQL schema filtering capabilities with large schemas that cannot fit in a single LLM prompt.

## Overview

| Metric | Value |
|--------|-------|
| Total Tables | 85 |
| Modules | 8 |
| Sample Records | ~134,000 rows |
| Test Questions | 60 |
| DDL File Size | ~22KB |
| Data File Size | ~21MB |

## Files

| File | Description |
|------|-------------|
| `schema_design.md` | Schema design document with table descriptions |
| `001_create_schema.sql` | PostgreSQL DDL script (85 tables) |
| `002_sample_data.sql` | INSERT statements for sample data |
| `002_generate_sample_data.py` | Python script that generates the data |
| `003_test_questions.json` | 60 test questions across difficulty levels |
| `erp_sidecar_config.py` | Python sidecar configuration for schema |
| `setup_database.sh` | Setup script for database initialization |

## Modules

### 1. HR Module (15 tables)
- `employees`, `departments`, `positions`
- `employee_salaries`, `benefit_types`, `employee_benefits`
- `leave_types`, `leave_requests`
- `certifications`, `employee_certifications`
- `performance_reviews`, `training_courses`, `employee_training`
- `emergency_contacts`, `employment_history`

### 2. Finance Module (12 tables)
- `account_types`, `chart_of_accounts`
- `fiscal_years`, `fiscal_periods`
- `journal_entries`, `journal_lines`
- `budgets`, `budget_lines`
- `bank_accounts`, `bank_transactions`
- `tax_rates`

### 3. Sales Module (10 tables)
- `customers`, `customer_contacts`
- `sales_regions`, `sales_territories`
- `opportunity_stages`, `sales_opportunities`
- `sales_quotes`, `quote_lines`
- `sales_orders`, `order_lines`

### 4. Procurement Module (10 tables)
- `vendors`, `vendor_contacts`
- `purchase_requisitions`, `requisition_lines`
- `purchase_orders`, `po_lines`
- `goods_receipts`, `receipt_lines`
- `vendor_invoices`, `vendor_invoice_lines`

### 5. Inventory Module (12 tables)
- `product_categories`, `units_of_measure`, `products`
- `warehouses`, `warehouse_locations`
- `inventory_levels`, `inventory_transactions`
- `stock_transfers`, `transfer_lines`
- `inventory_adjustments`, `adjustment_lines`
- `reorder_rules`

### 6. Project Module (10 tables)
- `projects`, `project_phases`, `project_tasks`
- `task_assignments`, `project_milestones`
- `project_budgets`, `project_expenses`
- `timesheets`, `timesheet_entries`, `project_resources`

### 7. Assets Module (8 tables)
- `asset_categories`, `asset_locations`, `fixed_assets`
- `depreciation_schedules`, `depreciation_entries`
- `maintenance_types`, `asset_maintenance`, `asset_transfers`

### 8. Common/Lookup Module (8 tables)
- `countries`, `states_provinces`, `cities`, `addresses`
- `currencies`, `business_units`, `cost_centers`
- `audit_log`, `document_attachments`

## Data Volumes

| Entity | Count |
|--------|-------|
| Employees | 500 |
| Departments | 25 |
| Customers | 1,000 |
| Vendors | 200 |
| Products | 2,000 |
| Sales Orders | 5,000 |
| Purchase Orders | 2,000 |
| Projects | 100 |
| Journal Entries | 10,000 |

## Quick Start

### 1. Setup Database

```bash
# Make script executable
chmod +x setup_database.sh

# Run setup (creates DB, schema, loads data, creates read-only user)
./setup_database.sh
```

### 2. Verify Installation

```bash
psql -d enterprise_erp -c "SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public';"
# Should return 85

psql -d enterprise_erp -c "SELECT COUNT(*) FROM employees;"
# Should return 500
```

### 3. Test Connection

```bash
psql postgresql://erp_readonly:erp_readonly_pass@localhost:5432/enterprise_erp
```

## Test Questions

The test suite (`003_test_questions.json`) includes 60 questions:

| Difficulty | Count | Description |
|------------|-------|-------------|
| Easy | 20 | Single table, simple aggregations |
| Medium | 25 | Multi-table joins, basic analytics |
| Hard | 15 | Complex joins, window functions, cross-module |

### Sample Questions

**Easy:**
- "List all employees in the Sales department"
- "How many customers have credit limit over $100,000?"

**Medium:**
- "What is the total sales amount by customer for 2024?"
- "List employees with expiring certifications in the next 6 months"

**Hard:**
- "Calculate month-over-month sales growth rate for the past 12 months"
- "Find resource utilization rate by employee across all projects"

## Schema Filtering Test

This schema is specifically designed to test schema filtering because:

1. **Cannot fit in one prompt**: 85 tables × ~10 columns each = ~850 schema elements
2. **Module boundaries**: Questions often need tables from multiple modules
3. **Foreign key chains**: Deep joins required (e.g., timesheet_entries → timesheets → employees → departments)
4. **Ambiguous keywords**: "orders" could mean sales_orders or purchase_orders

## Integration with Python Sidecar

The `erp_sidecar_config.py` provides:

- Complete schema definition (`ERP_SCHEMA`)
- Module groupings (`ERP_MODULES`)
- Keyword-based table filtering (`ERP_TABLE_KEYWORDS`)
- Domain knowledge (`ERP_DOMAIN_KNOWLEDGE`)
- Helper functions for schema navigation

To use in the sidecar:

```python
from enterprise_erp.erp_sidecar_config import (
    ERP_SCHEMA,
    ERP_TABLE_KEYWORDS,
    get_tables_by_module,
    get_related_tables
)

# Filter schema based on question keywords
relevant_tables = filter_tables_by_keywords(question, ERP_TABLE_KEYWORDS)

# Get related tables via foreign keys
all_needed = expand_with_related_tables(relevant_tables, get_related_tables)

# Build prompt with filtered schema
filtered_schema = {t: ERP_SCHEMA[t] for t in all_needed}
```


## 2000-Table Variant

If you need a much larger schema for NL2SQL filtering experiments, use the 2000-table setup:

```
chmod +x setup_database_2000.sh
./setup_database_2000.sh
```

This wraps `schema_gen/apply_schema.sh` and builds the 20-division, 2000-table database.
See `ARCHITECTURE.md` for the scaling plan and `LOGIN_2000.md` for connection details.
