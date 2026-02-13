#!/bin/bash
# Enterprise ERP Database Setup Script
# Creates database, schema, and loads sample data

set -euo pipefail

# Configuration
DB_NAME="${ERP_DB_NAME:-enterprise_erp}"
DB_USER="${ERP_DB_USER:-erp_readonly}"
DB_PASSWORD="${ERP_DB_PASSWORD:-erp_readonly_pass}"
DB_HOST="${ERP_DB_HOST:-localhost}"
DB_PORT="${ERP_DB_PORT:-5432}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Enterprise ERP Database Setup${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo -e "${RED}Error: psql command not found. Please install PostgreSQL client.${NC}"
    exit 1
fi

# Get directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${YELLOW}Step 1: Creating database...${NC}"
# Create database if it doesn't exist
psql -h $DB_HOST -p $DB_PORT -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
psql -h $DB_HOST -p $DB_PORT -U postgres -c "CREATE DATABASE $DB_NAME;"
echo -e "${GREEN}  ✓ Database '$DB_NAME' created${NC}"

echo ""
echo -e "${YELLOW}Step 2: Creating schema (85 tables)...${NC}"
psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -f "$SCRIPT_DIR/001_create_schema.sql"
echo -e "${GREEN}  ✓ Schema created successfully${NC}"

echo ""
echo -e "${YELLOW}Step 3: Loading sample data (~134K rows)...${NC}"
echo -e "  This may take a few minutes..."
psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -f "$SCRIPT_DIR/002_sample_data.sql"
echo -e "${GREEN}  ✓ Sample data loaded successfully${NC}"

echo ""
echo -e "${YELLOW}Step 4: Creating read-only user...${NC}"
psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME <<EOF
-- Create read-only user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
        CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;

-- Grant read-only access
GRANT CONNECT ON DATABASE $DB_NAME TO $DB_USER;
GRANT USAGE ON SCHEMA public TO $DB_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $DB_USER;
EOF
echo -e "${GREEN}  ✓ Read-only user '$DB_USER' created${NC}"

echo ""
echo -e "${YELLOW}Step 5: Verifying installation...${NC}"
# Count tables
TABLE_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
echo -e "${GREEN}  ✓ Tables created: $TABLE_COUNT${NC}"

# Count sample records
EMPLOYEE_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -t -c "SELECT COUNT(*) FROM employees;")
CUSTOMER_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -t -c "SELECT COUNT(*) FROM customers;")
PRODUCT_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -t -c "SELECT COUNT(*) FROM products;")
ORDER_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U postgres -d $DB_NAME -t -c "SELECT COUNT(*) FROM sales_orders;")

echo -e "${GREEN}  ✓ Employees: $EMPLOYEE_COUNT${NC}"
echo -e "${GREEN}  ✓ Customers: $CUSTOMER_COUNT${NC}"
echo -e "${GREEN}  ✓ Products: $PRODUCT_COUNT${NC}"
echo -e "${GREEN}  ✓ Sales Orders: $ORDER_COUNT${NC}"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Connection string for NL2SQL:"
echo "  postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "To test connection:"
echo "  psql postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
