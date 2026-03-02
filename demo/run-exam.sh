#!/usr/bin/env bash
set -euo pipefail

# ── Run Exam ────────────────────────────────────────────────────────
# Runs the NL2SQL exam and prints a summary.
#
# Usage:
#   ./demo/run-exam.sh                    # 70-table, full 60 questions
#   ./demo/run-exam.sh --db=2000          # 2000-table, full 300 questions
#   ./demo/run-exam.sh --db=2000 --max=10 # 2000-table, first 10 questions
#   ./demo/run-exam.sh --runs=3           # 70-table, 3 runs for statistical mean

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEMO_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  [ok] $1${NC}"; }
fail() { echo -e "${RED}  [FAIL] $1${NC}"; exit 1; }

# Source .env if present
[ -f "$ROOT_DIR/.env" ] && set -a && source "$ROOT_DIR/.env" && set +a

# Parse args
DB_SIZE=70
MAX_Q=""
RUNS=1
EXAM_VER=""
DB_TARGET=""
for arg in "$@"; do
    case "$arg" in
        --db=2000)      DB_SIZE=2000 ;;
        --db=70)        DB_SIZE=70 ;;
        --db=industry-erp)   DB_TARGET=industry-erp ;;
        --max=*)        MAX_Q="${arg#--max=}" ;;
        --runs=*)       RUNS="${arg#--runs=}" ;;
        --v2)           EXAM_VER=v2 ;;
        --help|-h)
            echo "Usage: $0 [--db=70|--db=2000|--db=industry-erp] [--max=N] [--runs=N] [--v2]"
            echo ""
            echo "  --db=70       Run against 70-table DB (default)"
            echo "  --db=2000     Run against 2000-table DB"
            echo "  --db=industry-erp  Run against Industry-Erp DB (79 questions)"
            echo "  --max=N       Limit to first N questions"
            echo "  --runs=N      Number of exam runs (70-table only, for statistical mean)"
            echo "  --v2          Use exam v2 (500 questions, no evidence, ambiguity grading)"
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

echo -e "${GREEN}=== NL2SQL Exam ===${NC}"
echo ""

export EXAM_MODE=true

# Industry-Erp exam
if [ "$DB_TARGET" = "industry-erp" ]; then
    export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
    export SEQUENTIAL_CANDIDATES="${SEQUENTIAL_CANDIDATES:-true}"
    export OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-16384}"  # Industry-Erp has verbose schemas — 4096 default is too small
    export DATABASE_URL="postgresql://postgres:1219@172.28.91.130:5432/industry-erp"
    export ACTIVE_DATABASE="industry-erp"
    ARGS="--exam $DEMO_DIR/exam/exam_industry-erp.csv"
    [ -n "$MAX_Q" ] && ARGS="$ARGS --max=$MAX_Q"
    (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam_2000.ts $ARGS)
    echo ""
    echo -e "${GREEN}=== Exam complete. Results in mcp-server-nl2sql/exam_logs/ ===${NC}"
    exit 0
fi

if [ "$DB_SIZE" -eq 70 ]; then
    if [ "$RUNS" -gt 1 ]; then
        (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam_multi.ts "$RUNS")
    else
        (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam.ts)
    fi
else
    if [ "$EXAM_VER" = "v2" ]; then
        ARGS="--exam $DEMO_DIR/exam/exam_v2_500.csv"
    else
        ARGS="--exam $DEMO_DIR/exam/exam_full_300.csv"
    fi
    [ -n "$MAX_Q" ] && ARGS="$ARGS --max=$MAX_Q"

    export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
    export SEQUENTIAL_CANDIDATES="${SEQUENTIAL_CANDIDATES:-true}"

    (cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam_2000.ts $ARGS)
fi

echo ""
echo -e "${GREEN}=== Exam complete. Results in mcp-server-nl2sql/exam_logs/ ===${NC}"
