#!/usr/bin/env bash
set -euo pipefail

# ── Run Exam ────────────────────────────────────────────────────────
# Runs the NL2SQL exam and prints a summary.
#
# Usage:
#   ./scripts/run-exam.sh                    # 70-table, full 60 questions
#   ./scripts/run-exam.sh --db=2000          # 2000-table, full 300 questions
#   ./scripts/run-exam.sh --db=2000 --max=10 # 2000-table, first 10 questions
#   ./scripts/run-exam.sh --runs=3           # 70-table, 3 runs for statistical mean

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  [ok] $1${NC}"; }
fail() { echo -e "${RED}  [FAIL] $1${NC}"; exit 1; }

# Source .env if present
[ -f "$ROOT_DIR/.env" ] && set -a && source "$ROOT_DIR/.env" && set +a

# Parse args
DB_SIZE=70
MAX_Q=""
RUNS=1
for arg in "$@"; do
    case "$arg" in
        --db=2000) DB_SIZE=2000 ;;
        --db=70)   DB_SIZE=70 ;;
        --max=*)   MAX_Q="${arg#--max=}" ;;
        --runs=*)  RUNS="${arg#--runs=}" ;;
        --help|-h)
            echo "Usage: $0 [--db=70|--db=2000] [--max=N] [--runs=N]"
            echo ""
            echo "  --db=70    Run against 70-table DB (default)"
            echo "  --db=2000  Run against 2000-table DB"
            echo "  --max=N    Limit to first N questions"
            echo "  --runs=N   Number of exam runs (70-table only, for statistical mean)"
            exit 0
            ;;
    esac
done

# Check sidecar is running
SIDECAR_URL="${PYTHON_SIDECAR_URL:-http://localhost:8001}"
if ! curl -s --connect-timeout 2 "$SIDECAR_URL/health" >/dev/null 2>&1; then
    echo "Sidecar not running. Starting in background..."
    bash "$ROOT_DIR/scripts/start-sidecar.sh" --bg
fi

echo -e "${GREEN}=== NL2SQL Exam (${DB_SIZE}-table) ===${NC}"
echo ""

export EXAM_MODE=true

if [ "$DB_SIZE" -eq 70 ]; then
    if [ "$RUNS" -gt 1 ]; then
        (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam_multi.ts "$RUNS")
    else
        (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam.ts)
    fi
else
    ARGS="--exam $ROOT_DIR/exam/exam_full_300.csv"
    [ -n "$MAX_Q" ] && ARGS="$ARGS --max=$MAX_Q"

    export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
    export SEQUENTIAL_CANDIDATES="${SEQUENTIAL_CANDIDATES:-true}"

    (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam_2000.ts $ARGS)
fi

echo ""
echo -e "${GREEN}=== Exam complete. Results in mcp-server-nl2sql/exam_logs/ ===${NC}"
