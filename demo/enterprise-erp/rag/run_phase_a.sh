#!/bin/bash
# ============================================================================
# Phase A: Schema Infrastructure Setup
# Run all RAG schema scripts in order
# ============================================================================

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-enterprise_erp}"
DB_PASS="${DB_PASS:-1219}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo "Phase A: Schema Infrastructure Setup"
echo "============================================"
echo "Database: $DB_NAME @ $DB_HOST"
echo ""

run_sql() {
    local script_name="$1"
    echo ">>> Running: $script_name"
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" \
        -f "$SCRIPT_DIR/$script_name" \
        --quiet \
        --set ON_ERROR_STOP=1
    echo "    Done."
    echo ""
}

echo "Step 1/5: Creating RAG schema and tables..."
run_sql "01_rag_schema.sql"

echo "Step 2/5: (Glossary JSON is loaded via SQL in step 4)"
echo ""

echo "Step 3/5: Introspecting schema from information_schema..."
run_sql "03_introspect_schema.sql"

echo "Step 4/5: Inferring column glosses..."
run_sql "04_infer_glosses.sql"

echo "Step 5/5: Computing FK degree and hub status..."
run_sql "05_compute_hub_status.sql"

echo "============================================"
echo "Phase A Complete!"
echo "============================================"
echo ""
echo "Verification:"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT
    'rag.schema_tables' AS table_name, COUNT(*) AS rows FROM rag.schema_tables
UNION ALL
SELECT 'rag.schema_columns', COUNT(*) FROM rag.schema_columns
UNION ALL
SELECT 'rag.schema_fks', COUNT(*) FROM rag.schema_fks
UNION ALL
SELECT 'rag.glossary', COUNT(*) FROM rag.glossary
UNION ALL
SELECT 'rag.module_mapping', COUNT(*) FROM rag.module_mapping
ORDER BY table_name;
"
