-- Base schema: shared dimensions + global reporting tables
-- This file is intended to be executed with psql

BEGIN;

-- Shared dimensions
CREATE TABLE IF NOT EXISTS dim_date (
    date_key DATE PRIMARY KEY,
    year INT NOT NULL,
    quarter INT NOT NULL,
    month INT NOT NULL,
    day INT NOT NULL,
    week_of_year INT NOT NULL,
    is_weekend BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS dim_currency (
    currency_code CHAR(3) PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT,
    iso_numeric INT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dim_org_unit (
    org_unit_id UUID PRIMARY KEY,
    org_unit_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    parent_org_unit_id UUID,
    org_type TEXT NOT NULL,
    effective_start DATE NOT NULL,
    effective_end DATE,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dim_location (
    location_id UUID PRIMARY KEY,
    location_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    country_code CHAR(2),
    region TEXT,
    city TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    postal_code TEXT
);

CREATE TABLE IF NOT EXISTS dim_employee (
    employee_dim_id UUID PRIMARY KEY,
    employee_number TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    org_unit_id UUID REFERENCES dim_org_unit(org_unit_id),
    location_id UUID REFERENCES dim_location(location_id),
    effective_start DATE NOT NULL,
    effective_end DATE,
    is_current BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dim_customer (
    customer_dim_id UUID PRIMARY KEY,
    customer_code TEXT NOT NULL,
    name TEXT NOT NULL,
    industry TEXT,
    region TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dim_vendor (
    vendor_dim_id UUID PRIMARY KEY,
    vendor_code TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    is_preferred BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS dim_product (
    product_dim_id UUID PRIMARY KEY,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    uom TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

-- Global reporting tables
CREATE TABLE IF NOT EXISTS rpt_division_sales_monthly (
    division_code TEXT NOT NULL,
    year INT NOT NULL,
    month INT NOT NULL,
    total_orders INT NOT NULL,
    total_revenue NUMERIC(12,2) NOT NULL,
    top_customer_code TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (division_code, year, month)
);

CREATE TABLE IF NOT EXISTS rpt_division_inventory_snapshot (
    division_code TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    total_sku_count INT NOT NULL,
    total_on_hand NUMERIC(18,2) NOT NULL,
    total_value NUMERIC(18,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (division_code, snapshot_date)
);

-- Event stream (partitioned)
CREATE TABLE IF NOT EXISTS event_stream (
    event_id UUID NOT NULL,
    division_code TEXT NOT NULL,
    event_ts TIMESTAMPTZ NOT NULL,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    payload JSONB,
    PRIMARY KEY (event_id, event_ts)
) PARTITION BY RANGE (event_ts);

-- One example partition (expand as needed)
CREATE TABLE IF NOT EXISTS event_stream_2024_q4 PARTITION OF event_stream
    FOR VALUES FROM ('2024-10-01') TO ('2025-01-01');

COMMIT;
