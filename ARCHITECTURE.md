# ERP 2000+-Table Architecture

## Overview
This build scales the existing 85-table ERP schema to a realistic ~2000-table enterprise schema using a hybrid strategy:

1. **Module deepening**: add 15 realistic workflow tables per division.
2. **Replication**: replicate the full (85 + 15) schema across 20 divisions using a schema-per-division approach.

Total table count:
- Per division: ~118 tables (86 base + 25 core deepening + 7-8 archetype-specific)
- 20 divisions: 2,365 tables (varies slightly by archetype: Manufacturing=119, Services/Retail/Corporate=118)
- Shared/global tables in `public`: 12 tables (8 dimensions + 2 reporting + 1 event stream + 1 partition)
- **Grand total**: 2,377 tables

This scale stresses schema retrieval, join-path selection, column grounding, and value grounding in NL2SQL pipelines.

## Baseline Modules and Join Hubs (85 tables)
Modules (from `demo/enterprise-erp/schema_design.md`):
- HR: employees, departments, positions, benefits, leave, training
- Finance: chart_of_accounts, journal_entries/lines, budgets, bank accounts
- Sales: customers, sales_orders, order_lines, sales_opportunities
- Procurement: vendors, purchase_orders, goods_receipts, vendor_invoices
- Inventory: products, warehouses, inventory_transactions
- Projects: projects, tasks, timesheets, project_expenses
- Assets: fixed_assets, depreciation, maintenance
- Common/Lookup: addresses, countries, currencies, cost_centers, audit_log

Key join hubs:
- `employees` connects HR, approvals, support, project timesheets
- `customers` connects Sales, Projects, Support, AR
- `vendors` connects Procurement and AP
- `products` connects Sales/Inventory/Procurement
- `projects` connects timesheets, expenses, budgets

## Deepening Additions (15 per division)
Each division receives 15 additional ERP-style workflow tables with audit columns:

HR:
- `hr_onboarding_tasks`
- `payroll_run_hdr` (legacy naming drift)
- `payroll_run_line`
- `hr_benefit_elections`
- `hr_time_clock_entries`

Finance:
- `finance_ap_invoices`
- `finance_ar_invoices`
- `finance_ar_payments`

Procurement:
- `procurement_rfqs`
- `procurement_rfq_responses`
- `procurement_po_approvals`

Inventory:
- `inventory_lots`
- `inventory_qc_inspections`

Support:
- `cust_srv_case` (legacy naming drift)
- `support_ticket_comments`

Workflow/Approvals:
- `wf_approval_request`
- `wf_approval_step`
- `wf_approval_action`

Finance (posting/batches):
- `finance_gl_batch`
- `finance_posting_period`
- `finance_period_status`

These create realistic join paths (e.g., RFQ → RFQ responses → Vendors; AR invoices → payments → customers; lots → QC inspections → employees).

## Replication Strategy (Schema-per-Division)
**Chosen approach**: schema-per-division (e.g., `div_01.sales_orders`).

Why:
- Mirrors large enterprises with regional/tenant schemas.
- Easier to isolate division-scale queries while still testing cross-schema retrieval.
- Keeps table names consistent for BIRD-style question generation.

Each division schema is generated from a template and includes:
- The base 85-table ERP schema (from `demo/enterprise-erp/001_create_schema.sql`)
- The 15 deepening tables above

## Shared Dimensions and Reporting
Shared tables live in `public`:
- `dim_date`, `dim_currency`, `dim_org_unit`, `dim_location`, `dim_employee`, `dim_customer`, `dim_vendor`, `dim_product`
- `rpt_division_sales_monthly`, `rpt_division_inventory_snapshot`
- `event_stream` with partition `event_stream_2024_q4`

These simulate a corporate analytics layer and provide global lookup for cross-division queries.

## Schema Conventions
- Audit columns on all deepening tables: `created_at`, `created_by`, `updated_at`, `updated_by`, `is_deleted`, `source_system`, `effective_start`, `effective_end`
- Money values use `NUMERIC(12,2)`
- Some legacy naming drift: `payroll_run_hdr`, `cust_srv_case` and `cust_id`

## Data Generation Strategy
- Base data (85 tables) is generated per division with unique seeds via `demo/data_gen/generate_base_division_sql.py`.
- Deepening tables are generated with deterministic seeds and division size multipliers.
- Date ranges span 2021–2025 for temporal realism.
- Output CSVs are loaded via `psql \copy` for speed.
- `demo/data_gen/output/value_index.json` provides sample values for value grounding in exam generation.

## BIRD-Style Exam Generation
- Templates live in `demo/exam/templates.yaml`.
- `demo/exam/generate_exam.py` samples templates with real value hints and emits `demo/exam/exam_200.csv`.
- Difficulty tiers:
  - Simple: 1–2 tables
  - Moderate: 3–5 tables or group-by
  - Challenging: >5 tables or multi-hop cross-module or window/CTE logic

## Key Files
- `demo/schema_gen/base_schema.sql`
- `demo/schema_gen/division_schema_template.sql.jinja`
- `demo/schema_gen/generate_schema.py`
- `demo/schema_gen/apply_schema.sh`
- `demo/data_gen/seed.py`
- `demo/data_gen/generate_data.py`
- `demo/data_gen/load_data.sh`
- `demo/exam/templates.yaml`
- `demo/exam/generate_exam.py`
- `demo/exam/exam_200.csv`
- `demo/exam/grading.md`
- `demo/validation/validate_db.sql`
- `demo/validation/validate.py`

## How This Mirrors Real Enterprise ERP Complexity
- Multiple divisions with shared corporate dimensions.
- Cross-module workflows spanning procurement, inventory, finance, and support.
- Controlled naming drift to simulate acquisitions and legacy systems.
- Analytics layer tables and event streams to mimic reporting/telemetry loads.


