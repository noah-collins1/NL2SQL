"""
Enterprise ERP Database Configuration for Python AI Sidecar

This configuration supports the 85-table Enterprise ERP schema designed
to test NL2SQL schema filtering capabilities.

Schema is organized into 8 modules:
- HR Module (15 tables)
- Finance Module (12 tables)
- Sales Module (10 tables)
- Procurement Module (10 tables)
- Inventory Module (12 tables)
- Project Module (10 tables)
- Assets Module (8 tables)
- Common/Lookup Module (8 tables)
"""

# Full ERP Schema Definition
ERP_SCHEMA = {
    # ============================================
    # COMMON/LOOKUP MODULE (8 tables)
    # ============================================
    "countries": {
        "columns": ["country_id", "name", "iso_code", "phone_code"],
        "primary_key": "country_id",
        "description": "Country master data with ISO codes",
        "module": "common"
    },
    "states_provinces": {
        "columns": ["state_id", "country_id", "name", "abbreviation"],
        "primary_key": "state_id",
        "foreign_keys": {"country_id": "countries.country_id"},
        "description": "State/province master linked to countries",
        "module": "common"
    },
    "cities": {
        "columns": ["city_id", "state_id", "name", "postal_code"],
        "primary_key": "city_id",
        "foreign_keys": {"state_id": "states_provinces.state_id"},
        "description": "City master with postal codes",
        "module": "common"
    },
    "addresses": {
        "columns": ["address_id", "street1", "street2", "city_id", "postal_code", "created_at"],
        "primary_key": "address_id",
        "foreign_keys": {"city_id": "cities.city_id"},
        "description": "Address book for all entities",
        "module": "common"
    },
    "currencies": {
        "columns": ["currency_id", "code", "name", "symbol", "exchange_rate"],
        "primary_key": "currency_id",
        "description": "Currency master with exchange rates (USD base)",
        "module": "common"
    },
    "business_units": {
        "columns": ["unit_id", "name", "parent_unit_id", "manager_id", "is_active"],
        "primary_key": "unit_id",
        "foreign_keys": {"manager_id": "employees.employee_id"},
        "description": "Organizational structure / business units",
        "module": "common"
    },
    "cost_centers": {
        "columns": ["cost_center_id", "code", "name", "department_id", "is_active"],
        "primary_key": "cost_center_id",
        "foreign_keys": {"department_id": "departments.department_id"},
        "description": "Cost tracking centers by department",
        "module": "common"
    },
    "audit_log": {
        "columns": ["log_id", "table_name", "record_id", "action", "old_value", "new_value", "changed_by", "changed_at"],
        "primary_key": "log_id",
        "description": "Change tracking audit log",
        "module": "common"
    },

    # ============================================
    # HR MODULE (15 tables)
    # ============================================
    "departments": {
        "columns": ["department_id", "name", "manager_id", "parent_department_id", "budget", "created_at"],
        "primary_key": "department_id",
        "foreign_keys": {"manager_id": "employees.employee_id"},
        "description": "Organizational departments with budgets",
        "module": "hr"
    },
    "positions": {
        "columns": ["position_id", "title", "min_salary", "max_salary", "department_id", "is_active"],
        "primary_key": "position_id",
        "foreign_keys": {"department_id": "departments.department_id"},
        "description": "Job positions with salary ranges",
        "module": "hr"
    },
    "employees": {
        "columns": ["employee_id", "employee_number", "first_name", "last_name", "email", "phone",
                   "department_id", "position_id", "manager_id", "hire_date", "termination_date",
                   "salary", "address_id", "birth_date", "gender", "is_active", "created_at"],
        "primary_key": "employee_id",
        "foreign_keys": {
            "department_id": "departments.department_id",
            "position_id": "positions.position_id",
            "manager_id": "employees.employee_id",
            "address_id": "addresses.address_id"
        },
        "description": "Employee master data with all HR details",
        "module": "hr"
    },
    "employee_salaries": {
        "columns": ["salary_id", "employee_id", "amount", "effective_date", "end_date", "change_reason", "approved_by"],
        "primary_key": "salary_id",
        "foreign_keys": {"employee_id": "employees.employee_id"},
        "description": "Salary history tracking",
        "module": "hr"
    },
    "benefit_types": {
        "columns": ["benefit_type_id", "name", "description", "annual_cost", "is_active"],
        "primary_key": "benefit_type_id",
        "description": "Available employee benefit types",
        "module": "hr"
    },
    "employee_benefits": {
        "columns": ["benefit_id", "employee_id", "benefit_type_id", "start_date", "end_date", "coverage_level"],
        "primary_key": "benefit_id",
        "foreign_keys": {
            "employee_id": "employees.employee_id",
            "benefit_type_id": "benefit_types.benefit_type_id"
        },
        "description": "Employee benefit enrollments",
        "module": "hr"
    },
    "leave_types": {
        "columns": ["leave_type_id", "name", "days_allowed", "is_paid", "requires_approval"],
        "primary_key": "leave_type_id",
        "description": "Types of leave (vacation, sick, etc.)",
        "module": "hr"
    },
    "leave_requests": {
        "columns": ["leave_id", "employee_id", "leave_type_id", "start_date", "end_date",
                   "days_requested", "status", "approved_by", "comments", "created_at"],
        "primary_key": "leave_id",
        "foreign_keys": {
            "employee_id": "employees.employee_id",
            "leave_type_id": "leave_types.leave_type_id"
        },
        "description": "Employee leave requests with approval workflow",
        "module": "hr"
    },
    "certifications": {
        "columns": ["certification_id", "name", "issuing_body", "validity_years", "description"],
        "primary_key": "certification_id",
        "description": "Available professional certifications",
        "module": "hr"
    },
    "employee_certifications": {
        "columns": ["cert_id", "employee_id", "certification_id", "obtained_date", "expiry_date", "certificate_number"],
        "primary_key": "cert_id",
        "foreign_keys": {
            "employee_id": "employees.employee_id",
            "certification_id": "certifications.certification_id"
        },
        "description": "Employee certification records",
        "module": "hr"
    },
    "performance_reviews": {
        "columns": ["review_id", "employee_id", "reviewer_id", "review_period_start", "review_period_end",
                   "review_date", "rating", "goals_met_percent", "comments", "created_at"],
        "primary_key": "review_id",
        "foreign_keys": {"employee_id": "employees.employee_id", "reviewer_id": "employees.employee_id"},
        "description": "Annual performance reviews (rating 1-5)",
        "module": "hr"
    },
    "training_courses": {
        "columns": ["course_id", "name", "description", "duration_hours", "cost", "is_mandatory", "is_active"],
        "primary_key": "course_id",
        "description": "Training course catalog",
        "module": "hr"
    },
    "employee_training": {
        "columns": ["training_id", "employee_id", "course_id", "scheduled_date", "completion_date", "score", "status"],
        "primary_key": "training_id",
        "foreign_keys": {
            "employee_id": "employees.employee_id",
            "course_id": "training_courses.course_id"
        },
        "description": "Employee training attendance records",
        "module": "hr"
    },
    "emergency_contacts": {
        "columns": ["contact_id", "employee_id", "name", "relationship", "phone", "email", "is_primary"],
        "primary_key": "contact_id",
        "foreign_keys": {"employee_id": "employees.employee_id"},
        "description": "Employee emergency contact information",
        "module": "hr"
    },
    "employment_history": {
        "columns": ["history_id", "employee_id", "company_name", "position", "start_date", "end_date", "reason_for_leaving"],
        "primary_key": "history_id",
        "foreign_keys": {"employee_id": "employees.employee_id"},
        "description": "Previous employment history",
        "module": "hr"
    },

    # ============================================
    # FINANCE MODULE (12 tables)
    # ============================================
    "account_types": {
        "columns": ["type_id", "name", "category", "normal_balance"],
        "primary_key": "type_id",
        "description": "Account classifications (asset/liability/equity/revenue/expense)",
        "module": "finance"
    },
    "chart_of_accounts": {
        "columns": ["account_id", "account_number", "name", "account_type_id", "parent_account_id",
                   "description", "is_active", "created_at"],
        "primary_key": "account_id",
        "foreign_keys": {"account_type_id": "account_types.type_id"},
        "description": "General ledger chart of accounts",
        "module": "finance"
    },
    "fiscal_years": {
        "columns": ["fiscal_year_id", "year", "start_date", "end_date", "is_closed"],
        "primary_key": "fiscal_year_id",
        "description": "Financial years (2022-2025)",
        "module": "finance"
    },
    "fiscal_periods": {
        "columns": ["period_id", "fiscal_year_id", "period_number", "name", "start_date", "end_date", "is_closed"],
        "primary_key": "period_id",
        "foreign_keys": {"fiscal_year_id": "fiscal_years.fiscal_year_id"},
        "description": "Monthly fiscal periods within years",
        "module": "finance"
    },
    "journal_entries": {
        "columns": ["entry_id", "entry_number", "entry_date", "period_id", "description",
                   "reference", "posted_by", "status", "created_at"],
        "primary_key": "entry_id",
        "foreign_keys": {"period_id": "fiscal_periods.period_id", "posted_by": "employees.employee_id"},
        "description": "General ledger journal entries",
        "module": "finance"
    },
    "journal_lines": {
        "columns": ["line_id", "entry_id", "account_id", "debit", "credit", "cost_center_id", "description"],
        "primary_key": "line_id",
        "foreign_keys": {
            "entry_id": "journal_entries.entry_id",
            "account_id": "chart_of_accounts.account_id",
            "cost_center_id": "cost_centers.cost_center_id"
        },
        "description": "Journal entry line items (debits and credits)",
        "module": "finance"
    },
    "budgets": {
        "columns": ["budget_id", "fiscal_year_id", "department_id", "name", "total_amount",
                   "status", "approved_by", "created_at"],
        "primary_key": "budget_id",
        "foreign_keys": {
            "fiscal_year_id": "fiscal_years.fiscal_year_id",
            "department_id": "departments.department_id"
        },
        "description": "Annual department budgets",
        "module": "finance"
    },
    "budget_lines": {
        "columns": ["line_id", "budget_id", "account_id", "period_id", "amount"],
        "primary_key": "line_id",
        "foreign_keys": {
            "budget_id": "budgets.budget_id",
            "account_id": "chart_of_accounts.account_id",
            "period_id": "fiscal_periods.period_id"
        },
        "description": "Budget allocations by account and period",
        "module": "finance"
    },
    "bank_accounts": {
        "columns": ["bank_account_id", "account_number", "account_name", "bank_name",
                   "currency_id", "gl_account_id", "current_balance", "is_active"],
        "primary_key": "bank_account_id",
        "foreign_keys": {
            "currency_id": "currencies.currency_id",
            "gl_account_id": "chart_of_accounts.account_id"
        },
        "description": "Company bank accounts",
        "module": "finance"
    },
    "bank_transactions": {
        "columns": ["transaction_id", "bank_account_id", "transaction_date", "amount",
                   "transaction_type", "reference", "description", "reconciled", "created_at"],
        "primary_key": "transaction_id",
        "foreign_keys": {"bank_account_id": "bank_accounts.bank_account_id"},
        "description": "Bank transaction records",
        "module": "finance"
    },
    "tax_rates": {
        "columns": ["tax_rate_id", "name", "rate", "country_id", "tax_type", "is_active"],
        "primary_key": "tax_rate_id",
        "foreign_keys": {"country_id": "countries.country_id"},
        "description": "Tax rate configurations by country",
        "module": "finance"
    },

    # ============================================
    # SALES MODULE (10 tables)
    # ============================================
    "customers": {
        "columns": ["customer_id", "customer_number", "name", "email", "phone", "website",
                   "billing_address_id", "shipping_address_id", "credit_limit", "payment_terms",
                   "currency_id", "is_active", "created_at"],
        "primary_key": "customer_id",
        "foreign_keys": {
            "billing_address_id": "addresses.address_id",
            "shipping_address_id": "addresses.address_id",
            "currency_id": "currencies.currency_id"
        },
        "description": "Customer master data",
        "module": "sales"
    },
    "customer_contacts": {
        "columns": ["contact_id", "customer_id", "first_name", "last_name", "email",
                   "phone", "title", "is_primary"],
        "primary_key": "contact_id",
        "foreign_keys": {"customer_id": "customers.customer_id"},
        "description": "Customer contact persons",
        "module": "sales"
    },
    "sales_regions": {
        "columns": ["region_id", "name", "manager_id", "target_revenue"],
        "primary_key": "region_id",
        "foreign_keys": {"manager_id": "employees.employee_id"},
        "description": "Geographic sales regions",
        "module": "sales"
    },
    "sales_territories": {
        "columns": ["territory_id", "name", "region_id", "assigned_rep_id"],
        "primary_key": "territory_id",
        "foreign_keys": {
            "region_id": "sales_regions.region_id",
            "assigned_rep_id": "employees.employee_id"
        },
        "description": "Sales territories within regions",
        "module": "sales"
    },
    "opportunity_stages": {
        "columns": ["stage_id", "name", "sequence", "probability", "is_closed", "is_won"],
        "primary_key": "stage_id",
        "description": "Sales pipeline stages (Lead through Closed)",
        "module": "sales"
    },
    "sales_opportunities": {
        "columns": ["opportunity_id", "name", "customer_id", "owner_id", "stage_id", "amount",
                   "probability", "expected_close_date", "actual_close_date", "source", "created_at"],
        "primary_key": "opportunity_id",
        "foreign_keys": {
            "customer_id": "customers.customer_id",
            "owner_id": "employees.employee_id",
            "stage_id": "opportunity_stages.stage_id"
        },
        "description": "Sales pipeline opportunities",
        "module": "sales"
    },
    "sales_quotes": {
        "columns": ["quote_id", "quote_number", "customer_id", "opportunity_id", "quote_date",
                   "valid_until", "subtotal", "tax_amount", "total", "status", "created_by"],
        "primary_key": "quote_id",
        "foreign_keys": {
            "customer_id": "customers.customer_id",
            "opportunity_id": "sales_opportunities.opportunity_id",
            "created_by": "employees.employee_id"
        },
        "description": "Sales price quotes",
        "module": "sales"
    },
    "quote_lines": {
        "columns": ["line_id", "quote_id", "product_id", "description", "quantity", "unit_price", "discount"],
        "primary_key": "line_id",
        "foreign_keys": {
            "quote_id": "sales_quotes.quote_id",
            "product_id": "products.product_id"
        },
        "description": "Quote line items",
        "module": "sales"
    },
    "sales_orders": {
        "columns": ["order_id", "order_number", "customer_id", "quote_id", "order_date",
                   "required_date", "ship_date", "subtotal", "tax_amount", "shipping_cost",
                   "total", "status", "shipping_address_id", "sales_rep_id", "created_at"],
        "primary_key": "order_id",
        "foreign_keys": {
            "customer_id": "customers.customer_id",
            "quote_id": "sales_quotes.quote_id",
            "shipping_address_id": "addresses.address_id",
            "sales_rep_id": "employees.employee_id"
        },
        "description": "Sales orders",
        "module": "sales"
    },
    "order_lines": {
        "columns": ["line_id", "order_id", "product_id", "quantity", "unit_price", "discount"],
        "primary_key": "line_id",
        "foreign_keys": {
            "order_id": "sales_orders.order_id",
            "product_id": "products.product_id"
        },
        "description": "Sales order line items",
        "module": "sales"
    },

    # ============================================
    # PROCUREMENT MODULE (10 tables)
    # ============================================
    "vendors": {
        "columns": ["vendor_id", "vendor_number", "name", "email", "phone", "payment_terms",
                   "address_id", "is_active", "created_at"],
        "primary_key": "vendor_id",
        "foreign_keys": {"address_id": "addresses.address_id"},
        "description": "Vendor/supplier master data",
        "module": "procurement"
    },
    "vendor_contacts": {
        "columns": ["contact_id", "vendor_id", "first_name", "last_name", "email", "phone", "title", "is_primary"],
        "primary_key": "contact_id",
        "foreign_keys": {"vendor_id": "vendors.vendor_id"},
        "description": "Vendor contact persons",
        "module": "procurement"
    },
    "purchase_requisitions": {
        "columns": ["requisition_id", "requisition_number", "requested_by", "request_date",
                   "status", "approved_by", "created_at"],
        "primary_key": "requisition_id",
        "foreign_keys": {"requested_by": "employees.employee_id", "approved_by": "employees.employee_id"},
        "description": "Internal purchase requests",
        "module": "procurement"
    },
    "requisition_lines": {
        "columns": ["line_id", "requisition_id", "product_id", "quantity", "estimated_cost"],
        "primary_key": "line_id",
        "foreign_keys": {
            "requisition_id": "purchase_requisitions.requisition_id",
            "product_id": "products.product_id"
        },
        "description": "Requisition line items",
        "module": "procurement"
    },
    "purchase_orders": {
        "columns": ["po_id", "po_number", "vendor_id", "order_date", "expected_date",
                   "subtotal", "tax_amount", "total", "status", "created_by", "created_at"],
        "primary_key": "po_id",
        "foreign_keys": {"vendor_id": "vendors.vendor_id", "created_by": "employees.employee_id"},
        "description": "Purchase orders to vendors",
        "module": "procurement"
    },
    "po_lines": {
        "columns": ["line_id", "po_id", "product_id", "quantity", "unit_cost"],
        "primary_key": "line_id",
        "foreign_keys": {"po_id": "purchase_orders.po_id", "product_id": "products.product_id"},
        "description": "Purchase order line items",
        "module": "procurement"
    },
    "goods_receipts": {
        "columns": ["receipt_id", "receipt_number", "po_id", "receipt_date", "received_by",
                   "warehouse_id", "status", "created_at"],
        "primary_key": "receipt_id",
        "foreign_keys": {
            "po_id": "purchase_orders.po_id",
            "received_by": "employees.employee_id",
            "warehouse_id": "warehouses.warehouse_id"
        },
        "description": "Goods receipt records",
        "module": "procurement"
    },
    "receipt_lines": {
        "columns": ["line_id", "receipt_id", "product_id", "quantity_received", "location_id"],
        "primary_key": "line_id",
        "foreign_keys": {
            "receipt_id": "goods_receipts.receipt_id",
            "product_id": "products.product_id",
            "location_id": "warehouse_locations.location_id"
        },
        "description": "Goods receipt line items",
        "module": "procurement"
    },
    "vendor_invoices": {
        "columns": ["invoice_id", "invoice_number", "vendor_id", "po_id", "invoice_date",
                   "due_date", "amount", "status", "created_at"],
        "primary_key": "invoice_id",
        "foreign_keys": {"vendor_id": "vendors.vendor_id", "po_id": "purchase_orders.po_id"},
        "description": "Vendor invoices/bills",
        "module": "procurement"
    },
    "vendor_invoice_lines": {
        "columns": ["line_id", "invoice_id", "description", "amount", "account_id"],
        "primary_key": "line_id",
        "foreign_keys": {
            "invoice_id": "vendor_invoices.invoice_id",
            "account_id": "chart_of_accounts.account_id"
        },
        "description": "Vendor invoice line items",
        "module": "procurement"
    },

    # ============================================
    # INVENTORY MODULE (12 tables)
    # ============================================
    "product_categories": {
        "columns": ["category_id", "name", "parent_category_id", "description", "is_active"],
        "primary_key": "category_id",
        "description": "Product category hierarchy",
        "module": "inventory"
    },
    "units_of_measure": {
        "columns": ["uom_id", "name", "abbreviation", "base_uom_id", "conversion_factor"],
        "primary_key": "uom_id",
        "description": "Units of measure with conversions",
        "module": "inventory"
    },
    "products": {
        "columns": ["product_id", "sku", "name", "description", "category_id", "uom_id",
                   "unit_cost", "list_price", "weight", "is_active", "created_at"],
        "primary_key": "product_id",
        "foreign_keys": {
            "category_id": "product_categories.category_id",
            "uom_id": "units_of_measure.uom_id"
        },
        "description": "Product master data (2000 products)",
        "module": "inventory"
    },
    "warehouses": {
        "columns": ["warehouse_id", "name", "address_id", "manager_id", "is_active"],
        "primary_key": "warehouse_id",
        "foreign_keys": {
            "address_id": "addresses.address_id",
            "manager_id": "employees.employee_id"
        },
        "description": "Warehouse facilities",
        "module": "inventory"
    },
    "warehouse_locations": {
        "columns": ["location_id", "warehouse_id", "aisle", "rack", "bin", "capacity"],
        "primary_key": "location_id",
        "foreign_keys": {"warehouse_id": "warehouses.warehouse_id"},
        "description": "Bin locations within warehouses",
        "module": "inventory"
    },
    "inventory_levels": {
        "columns": ["level_id", "product_id", "warehouse_id", "location_id", "quantity_on_hand"],
        "primary_key": "level_id",
        "foreign_keys": {
            "product_id": "products.product_id",
            "warehouse_id": "warehouses.warehouse_id",
            "location_id": "warehouse_locations.location_id"
        },
        "description": "Current inventory quantities by location",
        "module": "inventory"
    },
    "inventory_transactions": {
        "columns": ["transaction_id", "product_id", "warehouse_id", "type", "quantity", "date", "created_at"],
        "primary_key": "transaction_id",
        "foreign_keys": {
            "product_id": "products.product_id",
            "warehouse_id": "warehouses.warehouse_id"
        },
        "description": "Stock movement transactions",
        "module": "inventory"
    },
    "stock_transfers": {
        "columns": ["transfer_id", "from_warehouse_id", "to_warehouse_id", "status", "transfer_date", "created_at"],
        "primary_key": "transfer_id",
        "foreign_keys": {
            "from_warehouse_id": "warehouses.warehouse_id",
            "to_warehouse_id": "warehouses.warehouse_id"
        },
        "description": "Inter-warehouse transfers",
        "module": "inventory"
    },
    "transfer_lines": {
        "columns": ["line_id", "transfer_id", "product_id", "quantity"],
        "primary_key": "line_id",
        "foreign_keys": {
            "transfer_id": "stock_transfers.transfer_id",
            "product_id": "products.product_id"
        },
        "description": "Transfer line items",
        "module": "inventory"
    },
    "inventory_adjustments": {
        "columns": ["adjustment_id", "warehouse_id", "adjustment_date", "reason", "adjusted_by", "created_at"],
        "primary_key": "adjustment_id",
        "foreign_keys": {
            "warehouse_id": "warehouses.warehouse_id",
            "adjusted_by": "employees.employee_id"
        },
        "description": "Stock adjustment records",
        "module": "inventory"
    },
    "adjustment_lines": {
        "columns": ["line_id", "adjustment_id", "product_id", "quantity_change"],
        "primary_key": "line_id",
        "foreign_keys": {
            "adjustment_id": "inventory_adjustments.adjustment_id",
            "product_id": "products.product_id"
        },
        "description": "Adjustment line items",
        "module": "inventory"
    },
    "reorder_rules": {
        "columns": ["rule_id", "product_id", "warehouse_id", "min_quantity", "reorder_quantity"],
        "primary_key": "rule_id",
        "foreign_keys": {
            "product_id": "products.product_id",
            "warehouse_id": "warehouses.warehouse_id"
        },
        "description": "Automatic reorder point rules",
        "module": "inventory"
    },

    # ============================================
    # PROJECT MODULE (10 tables)
    # ============================================
    "projects": {
        "columns": ["project_id", "name", "description", "customer_id", "start_date", "end_date",
                   "status", "budget", "manager_id", "created_at"],
        "primary_key": "project_id",
        "foreign_keys": {
            "customer_id": "customers.customer_id",
            "manager_id": "employees.employee_id"
        },
        "description": "Project master data",
        "module": "projects"
    },
    "project_phases": {
        "columns": ["phase_id", "project_id", "name", "start_date", "end_date", "status"],
        "primary_key": "phase_id",
        "foreign_keys": {"project_id": "projects.project_id"},
        "description": "Project phases/stages",
        "module": "projects"
    },
    "project_tasks": {
        "columns": ["task_id", "phase_id", "name", "description", "estimated_hours", "status", "priority"],
        "primary_key": "task_id",
        "foreign_keys": {"phase_id": "project_phases.phase_id"},
        "description": "Project work tasks",
        "module": "projects"
    },
    "task_assignments": {
        "columns": ["assignment_id", "task_id", "employee_id", "assigned_date", "role"],
        "primary_key": "assignment_id",
        "foreign_keys": {
            "task_id": "project_tasks.task_id",
            "employee_id": "employees.employee_id"
        },
        "description": "Task-employee assignments",
        "module": "projects"
    },
    "project_milestones": {
        "columns": ["milestone_id", "project_id", "name", "due_date", "completed_date"],
        "primary_key": "milestone_id",
        "foreign_keys": {"project_id": "projects.project_id"},
        "description": "Project milestones",
        "module": "projects"
    },
    "project_budgets": {
        "columns": ["budget_id", "project_id", "category", "planned_amount", "actual_amount"],
        "primary_key": "budget_id",
        "foreign_keys": {"project_id": "projects.project_id"},
        "description": "Project budget by category",
        "module": "projects"
    },
    "project_expenses": {
        "columns": ["expense_id", "project_id", "employee_id", "expense_date", "amount", "category", "description"],
        "primary_key": "expense_id",
        "foreign_keys": {
            "project_id": "projects.project_id",
            "employee_id": "employees.employee_id"
        },
        "description": "Project expense records",
        "module": "projects"
    },
    "timesheets": {
        "columns": ["timesheet_id", "employee_id", "week_start_date", "status", "approved_by"],
        "primary_key": "timesheet_id",
        "foreign_keys": {"employee_id": "employees.employee_id", "approved_by": "employees.employee_id"},
        "description": "Weekly employee timesheets",
        "module": "projects"
    },
    "timesheet_entries": {
        "columns": ["entry_id", "timesheet_id", "project_id", "task_id", "date", "hours", "description"],
        "primary_key": "entry_id",
        "foreign_keys": {
            "timesheet_id": "timesheets.timesheet_id",
            "project_id": "projects.project_id",
            "task_id": "project_tasks.task_id"
        },
        "description": "Timesheet line entries",
        "module": "projects"
    },
    "project_resources": {
        "columns": ["resource_id", "project_id", "employee_id", "allocation_percent", "start_date", "end_date"],
        "primary_key": "resource_id",
        "foreign_keys": {
            "project_id": "projects.project_id",
            "employee_id": "employees.employee_id"
        },
        "description": "Project resource allocation",
        "module": "projects"
    },

    # ============================================
    # ASSETS MODULE (8 tables)
    # ============================================
    "asset_categories": {
        "columns": ["category_id", "name", "depreciation_method", "useful_life_years"],
        "primary_key": "category_id",
        "description": "Asset classification with depreciation settings",
        "module": "assets"
    },
    "asset_locations": {
        "columns": ["location_id", "name", "building", "floor", "room"],
        "primary_key": "location_id",
        "description": "Physical asset locations",
        "module": "assets"
    },
    "fixed_assets": {
        "columns": ["asset_id", "name", "asset_tag", "category_id", "purchase_date",
                   "purchase_cost", "location_id", "serial_number", "status", "created_at"],
        "primary_key": "asset_id",
        "foreign_keys": {
            "category_id": "asset_categories.category_id",
            "location_id": "asset_locations.location_id"
        },
        "description": "Fixed asset register",
        "module": "assets"
    },
    "depreciation_schedules": {
        "columns": ["schedule_id", "asset_id", "method", "start_date", "end_date", "annual_amount"],
        "primary_key": "schedule_id",
        "foreign_keys": {"asset_id": "fixed_assets.asset_id"},
        "description": "Asset depreciation schedules",
        "module": "assets"
    },
    "depreciation_entries": {
        "columns": ["entry_id", "asset_id", "period_id", "amount", "accumulated_depreciation"],
        "primary_key": "entry_id",
        "foreign_keys": {
            "asset_id": "fixed_assets.asset_id",
            "period_id": "fiscal_periods.period_id"
        },
        "description": "Monthly depreciation entries",
        "module": "assets"
    },
    "maintenance_types": {
        "columns": ["type_id", "name", "description", "frequency_months"],
        "primary_key": "type_id",
        "description": "Maintenance type definitions",
        "module": "assets"
    },
    "asset_maintenance": {
        "columns": ["maintenance_id", "asset_id", "maintenance_type_id", "scheduled_date",
                   "completed_date", "cost"],
        "primary_key": "maintenance_id",
        "foreign_keys": {
            "asset_id": "fixed_assets.asset_id",
            "maintenance_type_id": "maintenance_types.type_id"
        },
        "description": "Asset maintenance records",
        "module": "assets"
    },
    "asset_transfers": {
        "columns": ["transfer_id", "asset_id", "from_location_id", "to_location_id",
                   "transfer_date", "transferred_by", "reason"],
        "primary_key": "transfer_id",
        "foreign_keys": {
            "asset_id": "fixed_assets.asset_id",
            "from_location_id": "asset_locations.location_id",
            "to_location_id": "asset_locations.location_id",
            "transferred_by": "employees.employee_id"
        },
        "description": "Asset location transfers",
        "module": "assets"
    },

    # ============================================
    # DOCUMENT ATTACHMENTS (Common)
    # ============================================
    "document_attachments": {
        "columns": ["attachment_id", "entity_type", "entity_id", "file_name", "file_path",
                   "uploaded_by", "created_at"],
        "primary_key": "attachment_id",
        "foreign_keys": {"uploaded_by": "employees.employee_id"},
        "description": "Document attachments (polymorphic - any entity type)",
        "module": "common"
    }
}

# Module-based table grouping for schema filtering
ERP_MODULES = {
    "hr": [
        "employees", "departments", "positions", "employee_salaries", "benefit_types",
        "employee_benefits", "leave_types", "leave_requests", "certifications",
        "employee_certifications", "performance_reviews", "training_courses",
        "employee_training", "emergency_contacts", "employment_history"
    ],
    "finance": [
        "account_types", "chart_of_accounts", "fiscal_years", "fiscal_periods",
        "journal_entries", "journal_lines", "budgets", "budget_lines",
        "bank_accounts", "bank_transactions", "tax_rates"
    ],
    "sales": [
        "customers", "customer_contacts", "sales_regions", "sales_territories",
        "opportunity_stages", "sales_opportunities", "sales_quotes", "quote_lines",
        "sales_orders", "order_lines"
    ],
    "procurement": [
        "vendors", "vendor_contacts", "purchase_requisitions", "requisition_lines",
        "purchase_orders", "po_lines", "goods_receipts", "receipt_lines",
        "vendor_invoices", "vendor_invoice_lines"
    ],
    "inventory": [
        "product_categories", "units_of_measure", "products", "warehouses",
        "warehouse_locations", "inventory_levels", "inventory_transactions",
        "stock_transfers", "transfer_lines", "inventory_adjustments",
        "adjustment_lines", "reorder_rules"
    ],
    "projects": [
        "projects", "project_phases", "project_tasks", "task_assignments",
        "project_milestones", "project_budgets", "project_expenses",
        "timesheets", "timesheet_entries", "project_resources"
    ],
    "assets": [
        "asset_categories", "asset_locations", "fixed_assets", "depreciation_schedules",
        "depreciation_entries", "maintenance_types", "asset_maintenance", "asset_transfers"
    ],
    "common": [
        "countries", "states_provinces", "cities", "addresses", "currencies",
        "business_units", "cost_centers", "audit_log", "document_attachments"
    ]
}

# Keyword-based table filtering for schema selection
ERP_TABLE_KEYWORDS = {
    # HR Module
    "employees": ["employee", "employees", "staff", "worker", "workers", "person", "people", "hire", "hired", "salary", "salaries"],
    "departments": ["department", "departments", "dept", "depts", "division", "team", "teams"],
    "positions": ["position", "positions", "job", "jobs", "title", "titles", "role", "roles"],
    "employee_salaries": ["salary", "salaries", "pay", "compensation", "wage", "wages", "raise"],
    "benefit_types": ["benefit", "benefits", "insurance", "healthcare", "401k", "pension"],
    "employee_benefits": ["benefit", "benefits", "enrollment", "enrolled", "coverage"],
    "leave_types": ["leave", "pto", "vacation", "sick", "time off", "absence"],
    "leave_requests": ["leave", "pto", "vacation", "time off", "request", "absence"],
    "certifications": ["certification", "certifications", "certificate", "certified", "license"],
    "employee_certifications": ["certification", "certifications", "certificate", "certified"],
    "performance_reviews": ["performance", "review", "reviews", "rating", "evaluation", "appraisal"],
    "training_courses": ["training", "course", "courses", "learning", "education"],
    "employee_training": ["training", "trained", "completed", "attendance"],
    "emergency_contacts": ["emergency", "contact", "contacts", "family"],
    "employment_history": ["history", "previous", "past", "experience", "work history"],

    # Finance Module
    "account_types": ["account type", "account types", "classification"],
    "chart_of_accounts": ["account", "accounts", "gl", "general ledger", "coa"],
    "fiscal_years": ["fiscal year", "fiscal years", "fy", "financial year"],
    "fiscal_periods": ["fiscal period", "period", "periods", "month", "monthly"],
    "journal_entries": ["journal", "journal entry", "entries", "posting", "transaction"],
    "journal_lines": ["journal line", "debit", "credit", "line item"],
    "budgets": ["budget", "budgets", "budgeted", "planned"],
    "budget_lines": ["budget line", "budget allocation", "budget detail"],
    "bank_accounts": ["bank", "bank account", "checking", "savings"],
    "bank_transactions": ["bank transaction", "deposit", "withdrawal", "transfer"],
    "tax_rates": ["tax", "taxes", "tax rate", "vat", "sales tax"],

    # Sales Module
    "customers": ["customer", "customers", "client", "clients", "buyer", "buyers"],
    "customer_contacts": ["customer contact", "contact person", "buyer contact"],
    "sales_regions": ["region", "regions", "territory", "geographic"],
    "sales_territories": ["territory", "territories", "sales area"],
    "opportunity_stages": ["stage", "stages", "pipeline stage", "opportunity stage"],
    "sales_opportunities": ["opportunity", "opportunities", "deal", "deals", "prospect", "pipeline"],
    "sales_quotes": ["quote", "quotes", "quotation", "proposal"],
    "quote_lines": ["quote line", "quote item", "quoted product"],
    "sales_orders": ["sales order", "order", "orders", "sale", "sales", "sold"],
    "order_lines": ["order line", "order item", "line item"],

    # Procurement Module
    "vendors": ["vendor", "vendors", "supplier", "suppliers", "provider"],
    "vendor_contacts": ["vendor contact", "supplier contact"],
    "purchase_requisitions": ["requisition", "requisitions", "request", "pr"],
    "requisition_lines": ["requisition line", "requisition item"],
    "purchase_orders": ["purchase order", "po", "purchase orders", "procurement"],
    "po_lines": ["po line", "purchase line", "po item"],
    "goods_receipts": ["receipt", "receipts", "receiving", "received", "goods receipt"],
    "receipt_lines": ["receipt line", "received item"],
    "vendor_invoices": ["vendor invoice", "bill", "bills", "ap invoice"],
    "vendor_invoice_lines": ["invoice line", "bill line"],

    # Inventory Module
    "product_categories": ["category", "categories", "product category", "classification"],
    "units_of_measure": ["unit", "units", "uom", "measure", "measurement"],
    "products": ["product", "products", "item", "items", "sku", "part", "parts"],
    "warehouses": ["warehouse", "warehouses", "facility", "facilities", "storage"],
    "warehouse_locations": ["location", "locations", "bin", "bins", "aisle", "rack"],
    "inventory_levels": ["inventory", "stock", "quantity", "on hand", "available"],
    "inventory_transactions": ["inventory transaction", "stock movement", "in/out"],
    "stock_transfers": ["transfer", "transfers", "move", "movement"],
    "transfer_lines": ["transfer line", "transfer item"],
    "inventory_adjustments": ["adjustment", "adjustments", "correction", "cycle count"],
    "adjustment_lines": ["adjustment line", "adjustment item"],
    "reorder_rules": ["reorder", "reorder point", "min quantity", "auto order"],

    # Project Module
    "projects": ["project", "projects", "initiative", "program"],
    "project_phases": ["phase", "phases", "stage", "stages"],
    "project_tasks": ["task", "tasks", "work item", "activity"],
    "task_assignments": ["assignment", "assignments", "assigned", "assignee"],
    "project_milestones": ["milestone", "milestones", "deliverable"],
    "project_budgets": ["project budget", "project cost", "project spend"],
    "project_expenses": ["expense", "expenses", "project expense", "cost"],
    "timesheets": ["timesheet", "timesheets", "time tracking", "hours"],
    "timesheet_entries": ["time entry", "time entries", "hours logged"],
    "project_resources": ["resource", "resources", "allocation", "assigned"],

    # Assets Module
    "asset_categories": ["asset category", "asset type", "asset classification"],
    "asset_locations": ["asset location", "physical location", "building", "room"],
    "fixed_assets": ["asset", "assets", "fixed asset", "equipment", "property"],
    "depreciation_schedules": ["depreciation", "depreciation schedule", "useful life"],
    "depreciation_entries": ["depreciation entry", "accumulated depreciation"],
    "maintenance_types": ["maintenance type", "maintenance category"],
    "asset_maintenance": ["maintenance", "repair", "service", "upkeep"],
    "asset_transfers": ["asset transfer", "asset move", "relocation"],

    # Common Module
    "countries": ["country", "countries", "nation"],
    "states_provinces": ["state", "states", "province", "provinces"],
    "cities": ["city", "cities", "town"],
    "addresses": ["address", "addresses", "location"],
    "currencies": ["currency", "currencies", "exchange rate", "forex"],
    "business_units": ["business unit", "bu", "division", "subsidiary"],
    "cost_centers": ["cost center", "cost centers", "cc"],
    "audit_log": ["audit", "audit log", "history", "changes", "track"],
    "document_attachments": ["document", "documents", "attachment", "attachments", "file", "files"]
}

# ERP-specific domain knowledge
ERP_DOMAIN_KNOWLEDGE = """
Domain-Specific Rules for Enterprise ERP:

## Data Conventions
- Employee IDs are sequential (1-500)
- Customer IDs are sequential (1-1000)
- Dates are in YYYY-MM-DD format
- Currency amounts are in decimal (15,2) format
- Status fields use lowercase values: 'pending', 'approved', 'active', etc.

## Common Joins
- employees → departments (department_id)
- employees → positions (position_id)
- sales_orders → customers (customer_id)
- sales_orders → order_lines → products
- purchase_orders → vendors (vendor_id)
- projects → customers (customer_id)
- inventory_levels → products, warehouses
- journal_lines → chart_of_accounts (account_id)

## Fiscal Data
- Fiscal years: 2022, 2023, 2024, 2025
- Fiscal periods: 1-12 per year (48 total)
- Current year: 2024

## Status Values
- Orders: pending, confirmed, shipped, delivered, cancelled
- Leave: pending, approved, denied, completed
- Projects: planning, active, on_hold, completed, cancelled
- POs: draft, sent, confirmed, received, cancelled
- Journal entries: draft, posted
"""

# Get all table names for quick reference
def get_all_tables():
    """Return list of all 85 table names"""
    return list(ERP_SCHEMA.keys())

def get_tables_by_module(module: str):
    """Return tables for a specific module"""
    return ERP_MODULES.get(module, [])

def get_related_tables(table_name: str):
    """Get tables related via foreign keys"""
    table_info = ERP_SCHEMA.get(table_name, {})
    related = set()

    # Get tables this table references
    if "foreign_keys" in table_info:
        for fk_ref in table_info["foreign_keys"].values():
            ref_table = fk_ref.split(".")[0]
            related.add(ref_table)

    # Get tables that reference this table
    for other_table, other_info in ERP_SCHEMA.items():
        if "foreign_keys" in other_info:
            for fk_ref in other_info["foreign_keys"].values():
                if fk_ref.startswith(f"{table_name}."):
                    related.add(other_table)

    return list(related)


# Export for use by sidecar
__all__ = [
    'ERP_SCHEMA',
    'ERP_MODULES',
    'ERP_TABLE_KEYWORDS',
    'ERP_DOMAIN_KNOWLEDGE',
    'get_all_tables',
    'get_tables_by_module',
    'get_related_tables'
]
