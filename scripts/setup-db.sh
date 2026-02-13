#!/usr/bin/env bash
set -euo pipefail

# ── Database Setup ──────────────────────────────────────────────────
# Creates the database, loads schema + data, sets up RAG, populates embeddings.
#
# Usage:
#   ./scripts/setup-db.sh            # 70-table DB (default)
#   ./scripts/setup-db.sh --db=2000  # 2000-table DB
#
# Wraps existing scripts — idempotent where possible.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  [ok] $1${NC}"; }
warn() { echo -e "${YELLOW}  [warn] $1${NC}"; }
fail() { echo -e "${RED}  [FAIL] $1${NC}"; exit 1; }

# Parse args
DB_SIZE=70
for arg in "$@"; do
    case "$arg" in
        --db=2000) DB_SIZE=2000 ;;
        --db=70)   DB_SIZE=70 ;;
        --help|-h)
            echo "Usage: $0 [--db=70|--db=2000]"
            echo ""
            echo "  --db=70    Set up the 70-table enterprise_erp database (default)"
            echo "  --db=2000  Set up the 2000-table enterprise_erp_2000 database"
            exit 0
            ;;
    esac
done

# Source .env if present
[ -f "$ROOT_DIR/.env" ] && set -a && source "$ROOT_DIR/.env" && set +a

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo -e "${GREEN}=== NL2SQL Database Setup (${DB_SIZE}-table) ===${NC}"
echo ""

if [ "$DB_SIZE" -eq 70 ]; then
    DB_NAME="${ACTIVE_DATABASE:-enterprise_erp}"

    # Check if DB already exists with tables
    TABLE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null || echo "0")
    TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d ' ')

    if [ "$TABLE_COUNT" -gt 50 ]; then
        ok "Database $DB_NAME already has $TABLE_COUNT tables — skipping schema creation"
    else
        echo "Running enterprise-erp setup..."
        bash "$ROOT_DIR/enterprise-erp/setup_database.sh"
        ok "Schema + data loaded"
    fi

    # RAG setup
    RAG_EXISTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -t -c \
        "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='rag'" 2>/dev/null || echo "0")
    RAG_EXISTS=$(echo "$RAG_EXISTS" | tr -d ' ')

    if [ "$RAG_EXISTS" -eq 0 ]; then
        echo "Setting up RAG schema..."
        if [ -f "$ROOT_DIR/enterprise-erp/rag/run_phase_a.sh" ]; then
            bash "$ROOT_DIR/enterprise-erp/rag/run_phase_a.sh"
        fi
        ok "RAG schema created"
    else
        ok "RAG schema already exists"
    fi

    # Embeddings
    EMB_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -t -c \
        "SELECT COUNT(*) FROM rag.table_embeddings" 2>/dev/null || echo "0")
    EMB_COUNT=$(echo "$EMB_COUNT" | tr -d ' ')

    if [ "$EMB_COUNT" -lt 10 ]; then
        echo "Populating embeddings (this may take a few minutes)..."
        (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/populate_embeddings.ts)
        ok "Embeddings populated"
    else
        ok "Embeddings already populated ($EMB_COUNT rows)"
    fi

else
    # 2000-table setup
    DB_NAME="enterprise_erp_2000"

    TABLE_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema LIKE 'div_%' AND table_type='BASE TABLE'" 2>/dev/null || echo "0")
    TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d ' ')

    if [ "$TABLE_COUNT" -gt 1000 ]; then
        ok "Database $DB_NAME already has $TABLE_COUNT tables — skipping"
    else
        echo "Running 2000-table setup (this takes several minutes)..."
        bash "$ROOT_DIR/enterprise-erp/setup_database_2000.sh"
        ok "2000-table DB created"
    fi
fi

echo ""
echo -e "${GREEN}=== Database setup complete ===${NC}"
echo "DB: $DB_NAME ($DB_SIZE tables)"
