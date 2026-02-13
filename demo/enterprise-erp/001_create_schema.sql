-- Enterprise ERP Database Schema
-- 85 tables across 8 modules
-- For NL2SQL testing with large schema

-- ============================================
-- COMMON/LOOKUP MODULE (8 tables)
-- ============================================

CREATE TABLE countries (
    country_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    iso_code CHAR(2) NOT NULL UNIQUE,
    phone_code VARCHAR(10)
);

CREATE TABLE states_provinces (
    state_id SERIAL PRIMARY KEY,
    country_id INT NOT NULL REFERENCES countries(country_id),
    name VARCHAR(100) NOT NULL,
    abbreviation VARCHAR(10)
);

CREATE TABLE cities (
    city_id SERIAL PRIMARY KEY,
    state_id INT NOT NULL REFERENCES states_provinces(state_id),
    name VARCHAR(100) NOT NULL,
    postal_code VARCHAR(20)
);

CREATE TABLE addresses (
    address_id SERIAL PRIMARY KEY,
    street1 VARCHAR(200) NOT NULL,
    street2 VARCHAR(200),
    city_id INT REFERENCES cities(city_id),
    postal_code VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE currencies (
    currency_id SERIAL PRIMARY KEY,
    code CHAR(3) NOT NULL UNIQUE,
    name VARCHAR(50) NOT NULL,
    symbol VARCHAR(5),
    exchange_rate DECIMAL(10,4) DEFAULT 1.0000
);

CREATE TABLE business_units (
    unit_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_unit_id INT REFERENCES business_units(unit_id),
    manager_id INT, -- FK added after employees table
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE cost_centers (
    cost_center_id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    department_id INT, -- FK added after departments table
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE audit_log (
    log_id SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    record_id INT NOT NULL,
    action VARCHAR(20) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    changed_by INT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- HR MODULE (15 tables)
-- ============================================

CREATE TABLE departments (
    department_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    manager_id INT, -- FK added later
    parent_department_id INT REFERENCES departments(department_id),
    budget DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE positions (
    position_id SERIAL PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    min_salary DECIMAL(12,2),
    max_salary DECIMAL(12,2),
    department_id INT REFERENCES departments(department_id),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE employees (
    employee_id SERIAL PRIMARY KEY,
    employee_number VARCHAR(20) NOT NULL UNIQUE,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    phone VARCHAR(20),
    department_id INT REFERENCES departments(department_id),
    position_id INT REFERENCES positions(position_id),
    manager_id INT REFERENCES employees(employee_id),
    hire_date DATE NOT NULL,
    termination_date DATE,
    salary DECIMAL(12,2),
    address_id INT REFERENCES addresses(address_id),
    birth_date DATE,
    gender VARCHAR(10),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add FK for department manager
ALTER TABLE departments ADD CONSTRAINT fk_dept_manager
    FOREIGN KEY (manager_id) REFERENCES employees(employee_id);

-- Add FK for business unit manager
ALTER TABLE business_units ADD CONSTRAINT fk_bu_manager
    FOREIGN KEY (manager_id) REFERENCES employees(employee_id);

-- Add FK for cost center department
ALTER TABLE cost_centers ADD CONSTRAINT fk_cc_dept
    FOREIGN KEY (department_id) REFERENCES departments(department_id);

CREATE TABLE employee_salaries (
    salary_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    amount DECIMAL(12,2) NOT NULL,
    effective_date DATE NOT NULL,
    end_date DATE,
    change_reason VARCHAR(200),
    approved_by INT REFERENCES employees(employee_id)
);

CREATE TABLE benefit_types (
    benefit_type_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    annual_cost DECIMAL(10,2),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE employee_benefits (
    benefit_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    benefit_type_id INT NOT NULL REFERENCES benefit_types(benefit_type_id),
    start_date DATE NOT NULL,
    end_date DATE,
    coverage_level VARCHAR(50)
);

CREATE TABLE leave_types (
    leave_type_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    days_allowed INT NOT NULL,
    is_paid BOOLEAN DEFAULT TRUE,
    requires_approval BOOLEAN DEFAULT TRUE
);

CREATE TABLE leave_requests (
    leave_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    leave_type_id INT NOT NULL REFERENCES leave_types(leave_type_id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_requested DECIMAL(4,1) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    approved_by INT REFERENCES employees(employee_id),
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE certifications (
    certification_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    issuing_body VARCHAR(100),
    validity_years INT,
    description TEXT
);

CREATE TABLE employee_certifications (
    cert_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    certification_id INT NOT NULL REFERENCES certifications(certification_id),
    obtained_date DATE NOT NULL,
    expiry_date DATE,
    certificate_number VARCHAR(50)
);

CREATE TABLE performance_reviews (
    review_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    reviewer_id INT NOT NULL REFERENCES employees(employee_id),
    review_period_start DATE NOT NULL,
    review_period_end DATE NOT NULL,
    review_date DATE NOT NULL,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    goals_met_percent INT,
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE training_courses (
    course_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    duration_hours INT,
    cost DECIMAL(10,2),
    is_mandatory BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE employee_training (
    training_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    course_id INT NOT NULL REFERENCES training_courses(course_id),
    scheduled_date DATE,
    completion_date DATE,
    score INT,
    status VARCHAR(20) DEFAULT 'scheduled'
);

CREATE TABLE emergency_contacts (
    contact_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    name VARCHAR(100) NOT NULL,
    relationship VARCHAR(50),
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    is_primary BOOLEAN DEFAULT FALSE
);

CREATE TABLE employment_history (
    history_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    company_name VARCHAR(100) NOT NULL,
    position VARCHAR(100),
    start_date DATE NOT NULL,
    end_date DATE,
    reason_for_leaving VARCHAR(200)
);

-- ============================================
-- FINANCE MODULE (12 tables)
-- ============================================

CREATE TABLE account_types (
    type_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    category VARCHAR(20) NOT NULL CHECK (category IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    normal_balance VARCHAR(10) CHECK (normal_balance IN ('debit', 'credit'))
);

CREATE TABLE chart_of_accounts (
    account_id SERIAL PRIMARY KEY,
    account_number VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    account_type_id INT NOT NULL REFERENCES account_types(type_id),
    parent_account_id INT REFERENCES chart_of_accounts(account_id),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE fiscal_years (
    fiscal_year_id SERIAL PRIMARY KEY,
    year INT NOT NULL UNIQUE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE
);

CREATE TABLE fiscal_periods (
    period_id SERIAL PRIMARY KEY,
    fiscal_year_id INT NOT NULL REFERENCES fiscal_years(fiscal_year_id),
    period_number INT NOT NULL,
    name VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    UNIQUE (fiscal_year_id, period_number)
);

CREATE TABLE journal_entries (
    entry_id SERIAL PRIMARY KEY,
    entry_number VARCHAR(20) NOT NULL UNIQUE,
    entry_date DATE NOT NULL,
    period_id INT REFERENCES fiscal_periods(period_id),
    description TEXT,
    reference VARCHAR(100),
    posted_by INT REFERENCES employees(employee_id),
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE journal_lines (
    line_id SERIAL PRIMARY KEY,
    entry_id INT NOT NULL REFERENCES journal_entries(entry_id),
    account_id INT NOT NULL REFERENCES chart_of_accounts(account_id),
    debit DECIMAL(15,2) DEFAULT 0,
    credit DECIMAL(15,2) DEFAULT 0,
    cost_center_id INT REFERENCES cost_centers(cost_center_id),
    description VARCHAR(200)
);

CREATE TABLE budgets (
    budget_id SERIAL PRIMARY KEY,
    fiscal_year_id INT NOT NULL REFERENCES fiscal_years(fiscal_year_id),
    department_id INT REFERENCES departments(department_id),
    name VARCHAR(100) NOT NULL,
    total_amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'draft',
    approved_by INT REFERENCES employees(employee_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE budget_lines (
    line_id SERIAL PRIMARY KEY,
    budget_id INT NOT NULL REFERENCES budgets(budget_id),
    account_id INT NOT NULL REFERENCES chart_of_accounts(account_id),
    period_id INT REFERENCES fiscal_periods(period_id),
    amount DECIMAL(15,2) NOT NULL
);

CREATE TABLE bank_accounts (
    bank_account_id SERIAL PRIMARY KEY,
    account_number VARCHAR(50) NOT NULL,
    account_name VARCHAR(100) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    currency_id INT REFERENCES currencies(currency_id),
    gl_account_id INT REFERENCES chart_of_accounts(account_id),
    current_balance DECIMAL(15,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE bank_transactions (
    transaction_id SERIAL PRIMARY KEY,
    bank_account_id INT NOT NULL REFERENCES bank_accounts(bank_account_id),
    transaction_date DATE NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    transaction_type VARCHAR(20) NOT NULL,
    reference VARCHAR(100),
    description TEXT,
    reconciled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tax_rates (
    tax_rate_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    rate DECIMAL(5,2) NOT NULL,
    country_id INT REFERENCES countries(country_id),
    tax_type VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE
);

-- ============================================
-- SALES MODULE (10 tables)
-- ============================================

CREATE TABLE customers (
    customer_id SERIAL PRIMARY KEY,
    customer_number VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    website VARCHAR(200),
    billing_address_id INT REFERENCES addresses(address_id),
    shipping_address_id INT REFERENCES addresses(address_id),
    credit_limit DECIMAL(15,2),
    payment_terms INT DEFAULT 30,
    currency_id INT REFERENCES currencies(currency_id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customer_contacts (
    contact_id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(customer_id),
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    title VARCHAR(100),
    is_primary BOOLEAN DEFAULT FALSE
);

CREATE TABLE sales_regions (
    region_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    manager_id INT REFERENCES employees(employee_id),
    target_revenue DECIMAL(15,2)
);

CREATE TABLE sales_territories (
    territory_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    region_id INT REFERENCES sales_regions(region_id),
    assigned_rep_id INT REFERENCES employees(employee_id)
);

CREATE TABLE opportunity_stages (
    stage_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    sequence INT NOT NULL,
    probability INT CHECK (probability BETWEEN 0 AND 100),
    is_closed BOOLEAN DEFAULT FALSE,
    is_won BOOLEAN DEFAULT FALSE
);

CREATE TABLE sales_opportunities (
    opportunity_id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    customer_id INT NOT NULL REFERENCES customers(customer_id),
    owner_id INT REFERENCES employees(employee_id),
    stage_id INT REFERENCES opportunity_stages(stage_id),
    amount DECIMAL(15,2),
    probability INT,
    expected_close_date DATE,
    actual_close_date DATE,
    source VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sales_quotes (
    quote_id SERIAL PRIMARY KEY,
    quote_number VARCHAR(20) NOT NULL UNIQUE,
    customer_id INT NOT NULL REFERENCES customers(customer_id),
    opportunity_id INT REFERENCES sales_opportunities(opportunity_id),
    quote_date DATE NOT NULL,
    valid_until DATE,
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    total DECIMAL(15,2),
    status VARCHAR(20) DEFAULT 'draft',
    created_by INT REFERENCES employees(employee_id)
);

CREATE TABLE sales_orders (
    order_id SERIAL PRIMARY KEY,
    order_number VARCHAR(20) NOT NULL UNIQUE,
    customer_id INT NOT NULL REFERENCES customers(customer_id),
    quote_id INT REFERENCES sales_quotes(quote_id),
    order_date DATE NOT NULL,
    required_date DATE,
    ship_date DATE,
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    shipping_cost DECIMAL(10,2),
    total DECIMAL(15,2),
    status VARCHAR(20) DEFAULT 'pending',
    shipping_address_id INT REFERENCES addresses(address_id),
    sales_rep_id INT REFERENCES employees(employee_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INVENTORY MODULE (12 tables)
-- ============================================

CREATE TABLE product_categories (
    category_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_category_id INT REFERENCES product_categories(category_id),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE units_of_measure (
    uom_id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    abbreviation VARCHAR(10) NOT NULL,
    base_uom_id INT REFERENCES units_of_measure(uom_id),
    conversion_factor DECIMAL(10,4) DEFAULT 1
);

CREATE TABLE products (
    product_id SERIAL PRIMARY KEY,
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category_id INT REFERENCES product_categories(category_id),
    uom_id INT REFERENCES units_of_measure(uom_id),
    unit_cost DECIMAL(15,4),
    list_price DECIMAL(15,2),
    weight DECIMAL(10,2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quote and Order lines (need products first)
CREATE TABLE quote_lines (
    line_id SERIAL PRIMARY KEY,
    quote_id INT NOT NULL REFERENCES sales_quotes(quote_id),
    product_id INT NOT NULL REFERENCES products(product_id),
    description VARCHAR(200),
    quantity DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL,
    discount_percent DECIMAL(5,2) DEFAULT 0,
    line_total DECIMAL(15,2)
);

CREATE TABLE order_lines (
    line_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES sales_orders(order_id),
    product_id INT NOT NULL REFERENCES products(product_id),
    description VARCHAR(200),
    quantity DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL,
    discount_percent DECIMAL(5,2) DEFAULT 0,
    line_total DECIMAL(15,2),
    quantity_shipped DECIMAL(10,2) DEFAULT 0
);

CREATE TABLE warehouses (
    warehouse_id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    address_id INT REFERENCES addresses(address_id),
    manager_id INT REFERENCES employees(employee_id),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE warehouse_locations (
    location_id SERIAL PRIMARY KEY,
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    aisle VARCHAR(10),
    rack VARCHAR(10),
    bin VARCHAR(10),
    capacity INT,
    location_code VARCHAR(30) GENERATED ALWAYS AS (aisle || '-' || rack || '-' || bin) STORED
);

CREATE TABLE inventory_levels (
    level_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(product_id),
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    location_id INT REFERENCES warehouse_locations(location_id),
    quantity_on_hand DECIMAL(15,2) DEFAULT 0,
    quantity_reserved DECIMAL(15,2) DEFAULT 0,
    quantity_available DECIMAL(15,2) GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED,
    last_count_date DATE,
    UNIQUE (product_id, warehouse_id, location_id)
);

CREATE TABLE inventory_transactions (
    transaction_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(product_id),
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    location_id INT REFERENCES warehouse_locations(location_id),
    transaction_type VARCHAR(20) NOT NULL,
    quantity DECIMAL(15,2) NOT NULL,
    reference_type VARCHAR(50),
    reference_id INT,
    transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INT REFERENCES employees(employee_id)
);

CREATE TABLE stock_transfers (
    transfer_id SERIAL PRIMARY KEY,
    transfer_number VARCHAR(20) NOT NULL UNIQUE,
    from_warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    to_warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    status VARCHAR(20) DEFAULT 'pending',
    requested_date DATE,
    transfer_date DATE,
    created_by INT REFERENCES employees(employee_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transfer_lines (
    line_id SERIAL PRIMARY KEY,
    transfer_id INT NOT NULL REFERENCES stock_transfers(transfer_id),
    product_id INT NOT NULL REFERENCES products(product_id),
    quantity_requested DECIMAL(15,2) NOT NULL,
    quantity_transferred DECIMAL(15,2) DEFAULT 0
);

CREATE TABLE inventory_adjustments (
    adjustment_id SERIAL PRIMARY KEY,
    adjustment_number VARCHAR(20) NOT NULL UNIQUE,
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    adjustment_date DATE NOT NULL,
    reason VARCHAR(200),
    status VARCHAR(20) DEFAULT 'pending',
    adjusted_by INT REFERENCES employees(employee_id),
    approved_by INT REFERENCES employees(employee_id)
);

CREATE TABLE adjustment_lines (
    line_id SERIAL PRIMARY KEY,
    adjustment_id INT NOT NULL REFERENCES inventory_adjustments(adjustment_id),
    product_id INT NOT NULL REFERENCES products(product_id),
    location_id INT REFERENCES warehouse_locations(location_id),
    quantity_before DECIMAL(15,2),
    quantity_after DECIMAL(15,2),
    quantity_change DECIMAL(15,2) GENERATED ALWAYS AS (quantity_after - quantity_before) STORED
);

CREATE TABLE product_suppliers (
    supplier_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(product_id),
    vendor_id INT, -- FK added after vendors table
    vendor_sku VARCHAR(50),
    lead_time_days INT,
    minimum_order_qty DECIMAL(10,2),
    unit_cost DECIMAL(15,4),
    is_preferred BOOLEAN DEFAULT FALSE
);

CREATE TABLE reorder_rules (
    rule_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(product_id),
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    min_quantity DECIMAL(15,2) NOT NULL,
    reorder_quantity DECIMAL(15,2) NOT NULL,
    max_quantity DECIMAL(15,2),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE (product_id, warehouse_id)
);

-- ============================================
-- PROCUREMENT MODULE (10 tables)
-- ============================================

CREATE TABLE vendors (
    vendor_id SERIAL PRIMARY KEY,
    vendor_number VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    website VARCHAR(200),
    address_id INT REFERENCES addresses(address_id),
    payment_terms INT DEFAULT 30,
    currency_id INT REFERENCES currencies(currency_id),
    tax_id VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add FK for product_suppliers
ALTER TABLE product_suppliers ADD CONSTRAINT fk_ps_vendor
    FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id);

CREATE TABLE vendor_contacts (
    contact_id SERIAL PRIMARY KEY,
    vendor_id INT NOT NULL REFERENCES vendors(vendor_id),
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    title VARCHAR(100),
    is_primary BOOLEAN DEFAULT FALSE
);

CREATE TABLE purchase_requisitions (
    requisition_id SERIAL PRIMARY KEY,
    requisition_number VARCHAR(20) NOT NULL UNIQUE,
    requested_by INT NOT NULL REFERENCES employees(employee_id),
    department_id INT REFERENCES departments(department_id),
    request_date DATE NOT NULL,
    required_date DATE,
    status VARCHAR(20) DEFAULT 'draft',
    approved_by INT REFERENCES employees(employee_id),
    approved_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE requisition_lines (
    line_id SERIAL PRIMARY KEY,
    requisition_id INT NOT NULL REFERENCES purchase_requisitions(requisition_id),
    product_id INT REFERENCES products(product_id),
    description VARCHAR(200),
    quantity DECIMAL(10,2) NOT NULL,
    estimated_unit_cost DECIMAL(15,2),
    estimated_total DECIMAL(15,2)
);

CREATE TABLE purchase_orders (
    po_id SERIAL PRIMARY KEY,
    po_number VARCHAR(20) NOT NULL UNIQUE,
    vendor_id INT NOT NULL REFERENCES vendors(vendor_id),
    requisition_id INT REFERENCES purchase_requisitions(requisition_id),
    order_date DATE NOT NULL,
    expected_date DATE,
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    shipping_cost DECIMAL(10,2),
    total DECIMAL(15,2),
    status VARCHAR(20) DEFAULT 'draft',
    shipping_address_id INT REFERENCES addresses(address_id),
    buyer_id INT REFERENCES employees(employee_id),
    approved_by INT REFERENCES employees(employee_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE po_lines (
    line_id SERIAL PRIMARY KEY,
    po_id INT NOT NULL REFERENCES purchase_orders(po_id),
    product_id INT REFERENCES products(product_id),
    description VARCHAR(200),
    quantity DECIMAL(10,2) NOT NULL,
    unit_cost DECIMAL(15,2) NOT NULL,
    line_total DECIMAL(15,2),
    quantity_received DECIMAL(10,2) DEFAULT 0
);

CREATE TABLE goods_receipts (
    receipt_id SERIAL PRIMARY KEY,
    receipt_number VARCHAR(20) NOT NULL UNIQUE,
    po_id INT NOT NULL REFERENCES purchase_orders(po_id),
    receipt_date DATE NOT NULL,
    warehouse_id INT NOT NULL REFERENCES warehouses(warehouse_id),
    received_by INT REFERENCES employees(employee_id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receipt_lines (
    line_id SERIAL PRIMARY KEY,
    receipt_id INT NOT NULL REFERENCES goods_receipts(receipt_id),
    po_line_id INT REFERENCES po_lines(line_id),
    product_id INT NOT NULL REFERENCES products(product_id),
    quantity_received DECIMAL(10,2) NOT NULL,
    location_id INT REFERENCES warehouse_locations(location_id)
);

CREATE TABLE vendor_invoices (
    invoice_id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) NOT NULL,
    vendor_id INT NOT NULL REFERENCES vendors(vendor_id),
    po_id INT REFERENCES purchase_orders(po_id),
    invoice_date DATE NOT NULL,
    due_date DATE,
    subtotal DECIMAL(15,2),
    tax_amount DECIMAL(15,2),
    total DECIMAL(15,2),
    amount_paid DECIMAL(15,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (vendor_id, invoice_number)
);

CREATE TABLE vendor_invoice_lines (
    line_id SERIAL PRIMARY KEY,
    invoice_id INT NOT NULL REFERENCES vendor_invoices(invoice_id),
    po_line_id INT REFERENCES po_lines(line_id),
    description VARCHAR(200),
    quantity DECIMAL(10,2),
    unit_cost DECIMAL(15,2),
    amount DECIMAL(15,2) NOT NULL,
    account_id INT REFERENCES chart_of_accounts(account_id)
);

-- ============================================
-- PROJECT MODULE (10 tables)
-- ============================================

CREATE TABLE projects (
    project_id SERIAL PRIMARY KEY,
    project_number VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    customer_id INT REFERENCES customers(customer_id),
    project_manager_id INT REFERENCES employees(employee_id),
    start_date DATE,
    planned_end_date DATE,
    actual_end_date DATE,
    budget DECIMAL(15,2),
    status VARCHAR(20) DEFAULT 'planning',
    priority VARCHAR(10) DEFAULT 'medium',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_phases (
    phase_id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(project_id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    sequence INT NOT NULL,
    start_date DATE,
    end_date DATE,
    status VARCHAR(20) DEFAULT 'pending'
);

CREATE TABLE project_tasks (
    task_id SERIAL PRIMARY KEY,
    phase_id INT NOT NULL REFERENCES project_phases(phase_id),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    estimated_hours DECIMAL(8,2),
    actual_hours DECIMAL(8,2) DEFAULT 0,
    start_date DATE,
    due_date DATE,
    completed_date DATE,
    status VARCHAR(20) DEFAULT 'pending',
    priority VARCHAR(10) DEFAULT 'medium'
);

CREATE TABLE task_assignments (
    assignment_id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES project_tasks(task_id),
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    assigned_date DATE NOT NULL,
    role VARCHAR(50),
    estimated_hours DECIMAL(8,2)
);

CREATE TABLE project_milestones (
    milestone_id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(project_id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    due_date DATE NOT NULL,
    completed_date DATE,
    is_billable BOOLEAN DEFAULT FALSE,
    amount DECIMAL(15,2)
);

CREATE TABLE project_budgets (
    budget_id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(project_id),
    category VARCHAR(50) NOT NULL,
    planned_amount DECIMAL(15,2) NOT NULL,
    actual_amount DECIMAL(15,2) DEFAULT 0,
    notes TEXT
);

CREATE TABLE project_expenses (
    expense_id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(project_id),
    employee_id INT REFERENCES employees(employee_id),
    expense_date DATE NOT NULL,
    category VARCHAR(50),
    description VARCHAR(200),
    amount DECIMAL(10,2) NOT NULL,
    is_billable BOOLEAN DEFAULT TRUE,
    status VARCHAR(20) DEFAULT 'pending',
    approved_by INT REFERENCES employees(employee_id)
);

CREATE TABLE timesheets (
    timesheet_id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    week_start_date DATE NOT NULL,
    total_hours DECIMAL(8,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    submitted_date DATE,
    approved_by INT REFERENCES employees(employee_id),
    approved_date DATE
);

CREATE TABLE timesheet_entries (
    entry_id SERIAL PRIMARY KEY,
    timesheet_id INT NOT NULL REFERENCES timesheets(timesheet_id),
    project_id INT REFERENCES projects(project_id),
    task_id INT REFERENCES project_tasks(task_id),
    entry_date DATE NOT NULL,
    hours DECIMAL(4,2) NOT NULL,
    description TEXT,
    is_billable BOOLEAN DEFAULT TRUE
);

CREATE TABLE project_resources (
    resource_id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(project_id),
    employee_id INT NOT NULL REFERENCES employees(employee_id),
    role VARCHAR(50),
    allocation_percent INT CHECK (allocation_percent BETWEEN 0 AND 100),
    start_date DATE NOT NULL,
    end_date DATE,
    hourly_rate DECIMAL(10,2)
);

-- ============================================
-- ASSETS MODULE (8 tables)
-- ============================================

CREATE TABLE asset_categories (
    category_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    depreciation_method VARCHAR(20) NOT NULL,
    useful_life_years INT NOT NULL,
    salvage_value_percent DECIMAL(5,2) DEFAULT 0
);

CREATE TABLE asset_locations (
    location_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    building VARCHAR(50),
    floor VARCHAR(10),
    room VARCHAR(20),
    description TEXT
);

CREATE TABLE fixed_assets (
    asset_id SERIAL PRIMARY KEY,
    asset_tag VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category_id INT REFERENCES asset_categories(category_id),
    location_id INT REFERENCES asset_locations(location_id),
    assigned_to INT REFERENCES employees(employee_id),
    purchase_date DATE NOT NULL,
    purchase_cost DECIMAL(15,2) NOT NULL,
    vendor_id INT REFERENCES vendors(vendor_id),
    po_id INT REFERENCES purchase_orders(po_id),
    serial_number VARCHAR(100),
    warranty_expiry DATE,
    status VARCHAR(20) DEFAULT 'active',
    disposal_date DATE,
    disposal_amount DECIMAL(15,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE depreciation_schedules (
    schedule_id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES fixed_assets(asset_id),
    depreciation_method VARCHAR(20) NOT NULL,
    useful_life_months INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    monthly_amount DECIMAL(15,2),
    annual_amount DECIMAL(15,2)
);

CREATE TABLE depreciation_entries (
    entry_id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES fixed_assets(asset_id),
    period_id INT REFERENCES fiscal_periods(period_id),
    entry_date DATE NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    accumulated_depreciation DECIMAL(15,2) NOT NULL,
    book_value DECIMAL(15,2) NOT NULL,
    journal_entry_id INT REFERENCES journal_entries(entry_id)
);

CREATE TABLE maintenance_types (
    type_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    frequency_months INT,
    estimated_cost DECIMAL(10,2)
);

CREATE TABLE asset_maintenance (
    maintenance_id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES fixed_assets(asset_id),
    maintenance_type_id INT REFERENCES maintenance_types(type_id),
    scheduled_date DATE,
    completed_date DATE,
    performed_by INT REFERENCES employees(employee_id),
    vendor_id INT REFERENCES vendors(vendor_id),
    cost DECIMAL(10,2),
    notes TEXT,
    status VARCHAR(20) DEFAULT 'scheduled'
);

CREATE TABLE asset_transfers (
    transfer_id SERIAL PRIMARY KEY,
    asset_id INT NOT NULL REFERENCES fixed_assets(asset_id),
    from_location_id INT REFERENCES asset_locations(location_id),
    to_location_id INT NOT NULL REFERENCES asset_locations(location_id),
    from_employee_id INT REFERENCES employees(employee_id),
    to_employee_id INT REFERENCES employees(employee_id),
    transfer_date DATE NOT NULL,
    reason VARCHAR(200),
    transferred_by INT REFERENCES employees(employee_id)
);

-- Document attachments (polymorphic)
CREATE TABLE document_attachments (
    attachment_id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id INT NOT NULL,
    file_name VARCHAR(200) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_size INT,
    mime_type VARCHAR(100),
    uploaded_by INT REFERENCES employees(employee_id),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_manager ON employees(manager_id);
CREATE INDEX idx_sales_orders_customer ON sales_orders(customer_id);
CREATE INDEX idx_sales_orders_date ON sales_orders(order_date);
CREATE INDEX idx_purchase_orders_vendor ON purchase_orders(vendor_id);
CREATE INDEX idx_inventory_levels_product ON inventory_levels(product_id);
CREATE INDEX idx_inventory_levels_warehouse ON inventory_levels(warehouse_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_timesheet_entries_project ON timesheet_entries(project_id);
CREATE INDEX idx_fixed_assets_category ON fixed_assets(category_id);

-- Grant SELECT to read-only user (adjust username as needed)
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO nl2sql_readonly;
