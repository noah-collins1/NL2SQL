# Enterprise ERP Database Description

## Purpose

This database was designed specifically to test NL2SQL schema filtering capabilities. The core challenge: with 85 tables and ~850 columns, the complete schema cannot fit within a single LLM prompt context window. This forces the NL2SQL system to intelligently select only the relevant tables for each natural language query.

## Design Philosophy

### Why Enterprise ERP?

We chose an Enterprise Resource Planning (ERP) domain because:

1. **Realistic complexity** - ERP systems are among the most complex database applications in real-world use
2. **Clear module boundaries** - Natural separation into HR, Finance, Sales, etc. allows testing of cross-module queries
3. **Deep relationship chains** - Many tables are connected through foreign keys, requiring multi-hop joins
4. **Ambiguous terminology** - Terms like "orders" could mean sales orders or purchase orders, testing disambiguation

### Scale Decisions

| Metric | Value | Rationale |
|--------|-------|-----------|
| Tables | 85 | Large enough to exceed prompt limits, realistic ERP size |
| Modules | 8 | Covers major ERP functional areas |
| Columns | ~850 | Average 10 columns per table |
| Sample rows | ~134,000 | Enough for meaningful query results |

## Database Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ENTERPRISE ERP DATABASE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │     HR      │  │   FINANCE   │  │    SALES    │  │ PROCUREMENT │    │
│  │  15 tables  │  │  12 tables  │  │  10 tables  │  │  10 tables  │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │            │
│         └────────────────┼────────────────┼────────────────┘            │
│                          │                │                             │
│                          ▼                ▼                             │
│                    ┌─────────────────────────────┐                      │
│                    │     COMMON / LOOKUP         │                      │
│                    │        8 tables             │                      │
│                    │  (addresses, currencies,    │                      │
│                    │   countries, audit_log)     │                      │
│                    └─────────────────────────────┘                      │
│                          ▲                ▲                             │
│         ┌────────────────┼────────────────┼────────────────┐            │
│         │                │                │                │            │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐    │
│  │  INVENTORY  │  │   PROJECTS  │  │   ASSETS    │  │             │    │
│  │  12 tables  │  │  10 tables  │  │   8 tables  │  │             │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Module Descriptions

### 1. HR Module (15 tables)

The Human Resources module manages employee lifecycle from hiring to termination.

**Core Tables:**
- `employees` - Master employee record with personal details, department, position, salary
- `departments` - Organizational hierarchy with budgets and managers
- `positions` - Job titles with salary ranges

**Supporting Tables:**
- `employee_salaries` - Salary history tracking with change reasons
- `benefit_types` / `employee_benefits` - Benefits enrollment (health, 401k, etc.)
- `leave_types` / `leave_requests` - PTO/vacation request workflow
- `certifications` / `employee_certifications` - Professional certifications with expiry
- `performance_reviews` - Annual reviews with 1-5 ratings
- `training_courses` / `employee_training` - Training catalog and attendance
- `emergency_contacts` - Employee emergency contact info
- `employment_history` - Previous job history

**Key Relationships:**
```
employees ──┬── departments (many-to-one)
            ├── positions (many-to-one)
            ├── employees [manager] (self-reference)
            └── addresses (many-to-one)
```

### 2. Finance Module (12 tables)

The Finance module handles general ledger, budgeting, and banking.

**Core Tables:**
- `chart_of_accounts` - GL account master with account numbers
- `journal_entries` / `journal_lines` - Double-entry bookkeeping transactions
- `fiscal_years` / `fiscal_periods` - Financial calendar (2022-2025)

**Supporting Tables:**
- `account_types` - Account classifications (asset, liability, equity, revenue, expense)
- `budgets` / `budget_lines` - Annual department budgets by account
- `bank_accounts` / `bank_transactions` - Company bank accounts and activity
- `tax_rates` - Tax configurations by country

**Key Relationships:**
```
journal_entries ── journal_lines ──┬── chart_of_accounts
                                   └── cost_centers

budgets ── budget_lines ── chart_of_accounts
```

### 3. Sales Module (10 tables)

The Sales module tracks the full sales cycle from opportunity to order fulfillment.

**Core Tables:**
- `customers` - Customer master with credit limits and payment terms
- `sales_orders` / `order_lines` - Confirmed sales orders with line items
- `sales_opportunities` - Sales pipeline tracking

**Supporting Tables:**
- `customer_contacts` - Contact persons at each customer
- `sales_regions` / `sales_territories` - Geographic sales organization
- `opportunity_stages` - Pipeline stages (Lead → Qualified → Proposal → Negotiation → Closed)
- `sales_quotes` / `quote_lines` - Price quotations

**Key Relationships:**
```
customers ──┬── sales_orders ── order_lines ── products
            ├── sales_quotes ── quote_lines ── products
            └── sales_opportunities ── opportunity_stages
```

### 4. Procurement Module (10 tables)

The Procurement module manages vendor relationships and purchasing.

**Core Tables:**
- `vendors` - Supplier master data
- `purchase_orders` / `po_lines` - Orders to vendors
- `vendor_invoices` / `vendor_invoice_lines` - Accounts payable

**Supporting Tables:**
- `vendor_contacts` - Vendor contact persons
- `purchase_requisitions` / `requisition_lines` - Internal purchase requests
- `goods_receipts` / `receipt_lines` - Receiving dock records

**Key Relationships:**
```
vendors ── purchase_orders ── po_lines ── products
                │
                └── goods_receipts ── receipt_lines
                │
                └── vendor_invoices ── vendor_invoice_lines
```

### 5. Inventory Module (12 tables)

The Inventory module tracks products, warehouses, and stock levels.

**Core Tables:**
- `products` - Product master (2,000 SKUs)
- `warehouses` / `warehouse_locations` - Storage facilities and bin locations
- `inventory_levels` - Current stock quantities by location

**Supporting Tables:**
- `product_categories` - Product hierarchy
- `units_of_measure` - UOM conversions
- `inventory_transactions` - Stock movements (receipts, shipments, adjustments)
- `stock_transfers` / `transfer_lines` - Inter-warehouse transfers
- `inventory_adjustments` / `adjustment_lines` - Stock corrections
- `reorder_rules` - Automatic reorder points

**Key Relationships:**
```
products ──┬── product_categories
           ├── inventory_levels ──┬── warehouses
           │                      └── warehouse_locations
           └── order_lines / po_lines
```

### 6. Project Module (10 tables)

The Project module manages project planning, execution, and time tracking.

**Core Tables:**
- `projects` - Project master with budgets and status
- `project_tasks` - Work breakdown structure
- `timesheets` / `timesheet_entries` - Employee time tracking

**Supporting Tables:**
- `project_phases` - Project stages
- `task_assignments` - Task-employee links
- `project_milestones` - Key deliverables
- `project_budgets` - Budget by category
- `project_expenses` - Expense records
- `project_resources` - Resource allocation percentages

**Key Relationships:**
```
projects ──┬── project_phases ── project_tasks ── task_assignments ── employees
           ├── project_milestones
           ├── project_budgets
           └── customers (optional)

timesheets ── timesheet_entries ──┬── projects
                                  └── project_tasks
```

### 7. Assets Module (8 tables)

The Assets module tracks fixed assets and depreciation.

**Core Tables:**
- `fixed_assets` - Asset register with purchase info
- `depreciation_schedules` / `depreciation_entries` - Depreciation tracking

**Supporting Tables:**
- `asset_categories` - Asset types with useful life settings
- `asset_locations` - Physical locations (building, floor, room)
- `maintenance_types` / `asset_maintenance` - Maintenance scheduling
- `asset_transfers` - Asset location changes

**Key Relationships:**
```
fixed_assets ──┬── asset_categories
               ├── asset_locations
               ├── depreciation_schedules ── depreciation_entries
               └── asset_maintenance ── maintenance_types
```

### 8. Common/Lookup Module (8 tables)

Shared lookup tables used across all modules.

**Tables:**
- `countries` / `states_provinces` / `cities` - Geographic hierarchy
- `addresses` - Shared address book
- `currencies` - Currency master with exchange rates
- `business_units` - Organizational structure
- `cost_centers` - Cost tracking centers
- `audit_log` - Change tracking (polymorphic)
- `document_attachments` - File attachments (polymorphic)

## Data Characteristics

### Sample Data Volumes

| Table | Record Count | Notes |
|-------|--------------|-------|
| employees | 500 | With managers, departments, positions |
| departments | 25 | Hierarchical structure |
| customers | 1,000 | With billing/shipping addresses |
| vendors | 200 | With contacts |
| products | 2,000 | Across 30 categories |
| sales_orders | 5,000 | With 15,000 line items |
| purchase_orders | 2,000 | With 6,000 line items |
| journal_entries | 10,000 | With 30,000 line items |
| projects | 100 | With phases, tasks, timesheets |

### Date Ranges

- **Hire dates:** 2018-2024
- **Fiscal years:** 2022, 2023, 2024, 2025
- **Order dates:** 2022-2024
- **Transaction dates:** 2022-2024

### Status Values

All status fields use lowercase string values:

| Module | Status Values |
|--------|---------------|
| Orders | pending, confirmed, shipped, delivered, cancelled |
| Leave | pending, approved, denied, completed |
| Projects | planning, active, on_hold, completed, cancelled |
| POs | draft, sent, confirmed, received, cancelled |
| Journal | draft, posted |

## Query Complexity Examples

### Easy (Single Table)
```sql
-- List all employees in Sales department
SELECT e.first_name, e.last_name
FROM employees e
JOIN departments d ON e.department_id = d.department_id
WHERE d.name = 'Sales';
```

### Medium (Multi-Table Join)
```sql
-- Total sales by customer for 2024
SELECT c.name, SUM(so.total) as total_sales
FROM customers c
JOIN sales_orders so ON c.customer_id = so.customer_id
WHERE EXTRACT(YEAR FROM so.order_date) = 2024
GROUP BY c.name
ORDER BY total_sales DESC;
```

### Hard (Cross-Module with Analytics)
```sql
-- Project profitability with labor costs
SELECT
    p.name as project,
    SUM(DISTINCT so.total) as revenue,
    SUM(te.hours * e.salary / 2080) as labor_cost,
    SUM(DISTINCT pe.amount) as expenses
FROM projects p
LEFT JOIN customers c ON p.customer_id = c.customer_id
LEFT JOIN sales_orders so ON so.customer_id = c.customer_id
LEFT JOIN timesheet_entries te ON te.project_id = p.project_id
LEFT JOIN timesheets ts ON te.timesheet_id = ts.timesheet_id
LEFT JOIN employees e ON ts.employee_id = e.employee_id
LEFT JOIN project_expenses pe ON pe.project_id = p.project_id
GROUP BY p.project_id, p.name;
```

## Schema Filtering Challenge

The key challenge this database presents for NL2SQL:

1. **Token limits**: 85 tables × ~200 tokens each = ~17,000 tokens just for schema
2. **Relevance detection**: Must identify which 2-5 tables are needed from 85
3. **Cross-module queries**: "Show project labor costs by department" needs tables from Projects, HR, and Common modules
4. **Ambiguity resolution**: "orders" → sales_orders vs purchase_orders

### Example Schema Filtering

**Question:** "Which employees have pending leave requests?"

**Naive approach:** Send all 85 tables → Exceeds context limit

**Filtered approach:**
1. Keywords: "employees", "pending", "leave requests"
2. Matched tables: `employees`, `leave_requests`, `leave_types`
3. Related tables (via FK): `departments`, `positions`
4. Final schema: 5 tables instead of 85

```python
# Filtered schema for this query
{
    "employees": {...},
    "leave_requests": {...},
    "leave_types": {...},
    "departments": {...},  # Related via FK
}
```

## Files Reference

| File | Purpose |
|------|---------|
| `001_create_schema.sql` | DDL to create all 85 tables |
| `002_sample_data.sql` | INSERT statements for sample data |
| `003_test_questions.json` | 60 test questions with metadata |
| `erp_sidecar_config.py` | Python schema definition for sidecar |
| `setup_database.sh` | One-command database setup |

---

*Created for NL2SQL schema filtering testing - January 2025*
