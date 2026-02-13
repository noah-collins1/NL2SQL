# Enterprise ERP Database Schema

## Overview
- **Total Tables:** 85
- **Modules:** 8
- **Purpose:** Test NL2SQL with enterprise-scale schema that cannot fit in one prompt

## Modules

### 1. HR Module (15 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| employees | Employee master data | employee_id, first_name, last_name, email, department_id, position_id, hire_date, salary |
| departments | Organizational departments | department_id, name, manager_id, parent_department_id, budget |
| positions | Job positions/titles | position_id, title, min_salary, max_salary, department_id |
| employee_salaries | Salary history | salary_id, employee_id, amount, effective_date, end_date |
| employee_benefits | Benefits enrollment | benefit_id, employee_id, benefit_type_id, start_date, end_date |
| benefit_types | Available benefits | benefit_type_id, name, description, annual_cost |
| leave_requests | PTO/leave requests | leave_id, employee_id, leave_type_id, start_date, end_date, status |
| leave_types | Types of leave | leave_type_id, name, days_allowed, is_paid |
| employee_certifications | Employee certs | cert_id, employee_id, certification_id, obtained_date, expiry_date |
| certifications | Available certifications | certification_id, name, issuing_body, validity_years |
| performance_reviews | Annual reviews | review_id, employee_id, reviewer_id, review_date, rating, comments |
| training_courses | Training catalog | course_id, name, description, duration_hours, cost |
| employee_training | Training attendance | training_id, employee_id, course_id, completion_date, score |
| emergency_contacts | Employee emergency contacts | contact_id, employee_id, name, relationship, phone |
| employment_history | Job history | history_id, employee_id, company_name, position, start_date, end_date |

### 2. Finance Module (12 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| chart_of_accounts | GL accounts | account_id, account_number, name, account_type_id, is_active |
| account_types | Account classifications | type_id, name, category (asset/liability/equity/revenue/expense) |
| fiscal_years | Financial years | fiscal_year_id, year, start_date, end_date, is_closed |
| fiscal_periods | Monthly periods | period_id, fiscal_year_id, period_number, start_date, end_date |
| journal_entries | GL transactions | entry_id, entry_date, description, posted_by, status |
| journal_lines | Entry line items | line_id, entry_id, account_id, debit, credit, cost_center_id |
| budgets | Annual budgets | budget_id, fiscal_year_id, department_id, total_amount, status |
| budget_lines | Budget by account | line_id, budget_id, account_id, amount, period_id |
| bank_accounts | Company bank accounts | bank_account_id, account_number, bank_name, currency_id, balance |
| bank_transactions | Bank activity | transaction_id, bank_account_id, date, amount, type, reference |
| tax_rates | Tax configurations | tax_rate_id, name, rate, country_id, is_active |
| currencies | Currency master | currency_id, code, name, symbol, exchange_rate |

### 3. Sales Module (10 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| customers | Customer master | customer_id, name, email, phone, billing_address_id, credit_limit |
| customer_contacts | Customer contacts | contact_id, customer_id, name, email, phone, is_primary |
| sales_opportunities | Sales pipeline | opportunity_id, customer_id, name, amount, stage_id, probability, close_date |
| opportunity_stages | Pipeline stages | stage_id, name, sequence, probability |
| sales_quotes | Price quotes | quote_id, customer_id, opportunity_id, quote_date, valid_until, total, status |
| quote_lines | Quote line items | line_id, quote_id, product_id, quantity, unit_price, discount |
| sales_orders | Confirmed orders | order_id, customer_id, order_date, ship_date, total, status |
| order_lines | Order line items | line_id, order_id, product_id, quantity, unit_price, discount |
| sales_regions | Geographic regions | region_id, name, manager_id |
| sales_territories | Sales territories | territory_id, name, region_id, assigned_rep_id |

### 4. Procurement Module (10 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| vendors | Supplier master | vendor_id, name, email, phone, payment_terms, is_active |
| vendor_contacts | Vendor contacts | contact_id, vendor_id, name, email, phone, is_primary |
| purchase_requisitions | Internal requests | requisition_id, requested_by, request_date, status, approved_by |
| requisition_lines | Requisition items | line_id, requisition_id, product_id, quantity, estimated_cost |
| purchase_orders | Orders to vendors | po_id, vendor_id, order_date, expected_date, total, status |
| po_lines | PO line items | line_id, po_id, product_id, quantity, unit_cost |
| goods_receipts | Receiving records | receipt_id, po_id, receipt_date, received_by, warehouse_id |
| receipt_lines | Receipt line items | line_id, receipt_id, product_id, quantity_received, location_id |
| vendor_invoices | Vendor bills | invoice_id, vendor_id, po_id, invoice_date, due_date, amount, status |
| vendor_invoice_lines | Invoice details | line_id, invoice_id, description, amount, account_id |

### 5. Inventory Module (12 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| products | Product master | product_id, sku, name, description, category_id, unit_cost, list_price |
| product_categories | Product hierarchy | category_id, name, parent_category_id, description |
| warehouses | Storage facilities | warehouse_id, name, address_id, manager_id, is_active |
| warehouse_locations | Bin locations | location_id, warehouse_id, aisle, rack, bin, capacity |
| inventory_levels | Current stock | level_id, product_id, warehouse_id, location_id, quantity_on_hand |
| inventory_transactions | Stock movements | transaction_id, product_id, warehouse_id, type, quantity, date |
| stock_transfers | Inter-warehouse moves | transfer_id, from_warehouse_id, to_warehouse_id, status, transfer_date |
| transfer_lines | Transfer items | line_id, transfer_id, product_id, quantity |
| inventory_adjustments | Stock corrections | adjustment_id, warehouse_id, adjustment_date, reason, adjusted_by |
| adjustment_lines | Adjustment items | line_id, adjustment_id, product_id, quantity_change |
| units_of_measure | UOM definitions | uom_id, name, abbreviation, base_uom_id, conversion_factor |
| reorder_rules | Auto-reorder settings | rule_id, product_id, warehouse_id, min_quantity, reorder_quantity |

### 6. Project Module (10 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| projects | Project master | project_id, name, description, customer_id, start_date, end_date, status, budget |
| project_phases | Project phases | phase_id, project_id, name, start_date, end_date, status |
| project_tasks | Work breakdown | task_id, phase_id, name, description, estimated_hours, status |
| task_assignments | Task-employee links | assignment_id, task_id, employee_id, assigned_date, role |
| project_milestones | Key milestones | milestone_id, project_id, name, due_date, completed_date |
| project_budgets | Budget tracking | budget_id, project_id, category, planned_amount, actual_amount |
| project_expenses | Expense records | expense_id, project_id, employee_id, expense_date, amount, category |
| timesheets | Weekly timesheets | timesheet_id, employee_id, week_start_date, status, approved_by |
| timesheet_entries | Time entries | entry_id, timesheet_id, project_id, task_id, date, hours, description |
| project_resources | Resource allocation | resource_id, project_id, employee_id, allocation_percent, start_date, end_date |

### 7. Assets Module (8 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| fixed_assets | Asset register | asset_id, name, asset_tag, category_id, purchase_date, purchase_cost, location_id |
| asset_categories | Asset types | category_id, name, depreciation_method, useful_life_years |
| asset_locations | Physical locations | location_id, name, building, floor, room |
| depreciation_schedules | Depreciation plans | schedule_id, asset_id, method, start_date, end_date, annual_amount |
| depreciation_entries | Monthly depreciation | entry_id, asset_id, period_id, amount, accumulated_depreciation |
| asset_maintenance | Maintenance records | maintenance_id, asset_id, maintenance_type_id, scheduled_date, completed_date, cost |
| maintenance_types | Maintenance categories | type_id, name, description, frequency_months |
| asset_transfers | Asset location changes | transfer_id, asset_id, from_location_id, to_location_id, transfer_date |

### 8. Common/Lookup Module (8 tables)
| Table | Description | Key Columns |
|-------|-------------|-------------|
| countries | Country master | country_id, name, iso_code, phone_code |
| states_provinces | State/province master | state_id, country_id, name, abbreviation |
| cities | City master | city_id, state_id, name, postal_code |
| addresses | Address book | address_id, street1, street2, city_id, postal_code |
| cost_centers | Cost tracking | cost_center_id, code, name, department_id |
| business_units | Org structure | unit_id, name, parent_unit_id, manager_id |
| document_attachments | File attachments | attachment_id, entity_type, entity_id, file_name, file_path |
| audit_log | Change tracking | log_id, table_name, record_id, action, old_value, new_value, changed_by, changed_at |

## Relationships Summary
- Employees → Departments (many-to-one)
- Employees → Positions (many-to-one)
- Sales Orders → Customers (many-to-one)
- Sales Orders → Order Lines → Products (one-to-many-to-one)
- Purchase Orders → Vendors (many-to-one)
- Projects → Customers (many-to-one)
- Inventory Levels → Products, Warehouses (many-to-one)
- Journal Lines → Accounts, Cost Centers (many-to-one)
- All entities → Addresses (polymorphic)

## Data Volume Targets
- Employees: 500
- Departments: 25
- Customers: 1,000
- Vendors: 200
- Products: 2,000
- Sales Orders: 5,000
- Purchase Orders: 2,000
- Projects: 100
- Journal Entries: 10,000
