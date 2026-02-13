#!/bin/bash
# Apply schema for 2000-table ERP (hybrid: deepened + replicated)
set -e

DB_NAME="${ERP_DB_NAME:-enterprise_erp_2000}"
DB_USER="${ERP_DB_USER:-erp_readonly}"
DB_PASSWORD="${ERP_DB_PASSWORD:-treyco}"
DB_HOST="${ERP_DB_HOST:-localhost}"
DB_PORT="${ERP_DB_PORT:-5432}"
DIVISIONS="${ERP_DIVISIONS:-20}"
BASE_SEED="${ERP_BASE_SEED:-20240213}"
PARALLEL="${ERP_PARALLEL:-5}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! command -v psql &> /dev/null; then
  echo "Error: psql not found"
  exit 1
fi

echo "=== Phase 1: Generate schemas ==="
python3 "$ROOT_DIR/schema_gen/generate_schema.py" --divisions "$DIVISIONS" --output "$ROOT_DIR/schema_gen/generated_divisions.sql"

echo "=== Phase 2: Create database ==="
psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -c "CREATE DATABASE $DB_NAME;"

# Shared dimensions
psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -f "$ROOT_DIR/schema_gen/base_schema.sql"

# Division schemas + base ERP tables + deepening tables
echo "=== Phase 3: Create division schemas (2120 tables) ==="
psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -f "$ROOT_DIR/schema_gen/generated_divisions.sql"

# Pre-generate all division SQL files in parallel
echo "=== Phase 4: Pre-generate base data for $DIVISIONS divisions ==="
for i in $(seq -f "%02g" 1 "$DIVISIONS"); do
  SCHEMA="div_${i}"
  SEED=$((BASE_SEED + 10#${i}))
  python3 "$ROOT_DIR/data_gen/generate_base_division_sql.py" --seed "$SEED" --schema "$SCHEMA" \
    > "$TMP_DIR/${SCHEMA}.sql" &
done
wait
echo "  All $DIVISIONS division SQL files generated"

# Load division data in parallel batches
echo "=== Phase 5: Load base data ($PARALLEL parallel) ==="
running=0
for i in $(seq -f "%02g" 1 "$DIVISIONS"); do
  SCHEMA="div_${i}"
  psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" \
    -f "$TMP_DIR/${SCHEMA}.sql" > /dev/null 2>&1 &
  running=$((running + 1))
  if [ "$running" -ge "$PARALLEL" ]; then
    wait -n
    running=$((running - 1))
  fi
  echo "  Queued base data for ${SCHEMA}"
done
wait
echo "  All base data loaded"

# Create read-only user and grant permissions
echo "=== Phase 6: Create user & grant permissions ==="
GRANT_DIVISIONS=""
for i in $(seq -f "%02g" 1 "$DIVISIONS"); do
  GRANT_DIVISIONS="${GRANT_DIVISIONS}
GRANT USAGE ON SCHEMA div_${i} TO $DB_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA div_${i} TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA div_${i} GRANT SELECT ON TABLES TO $DB_USER;"
done

psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
        CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;
GRANT CONNECT ON DATABASE $DB_NAME TO $DB_USER;
GRANT USAGE ON SCHEMA public TO $DB_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $DB_USER;
${GRANT_DIVISIONS}
EOF

# Load generated data (shared dims + deepened tables)
if [ -x "$ROOT_DIR/data_gen/load_data.sh" ]; then
  "$ROOT_DIR/data_gen/load_data.sh" "$DB_NAME" "$DB_HOST" "$DB_PORT"
fi

echo "Done. Connection string: postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
