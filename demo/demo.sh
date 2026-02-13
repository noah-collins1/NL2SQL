#!/usr/bin/env bash
set -euo pipefail

# ── NL2SQL Demo ─────────────────────────────────────────────────────
# One-command demo: installs deps, sets up DB, starts sidecar, runs exam.
#
# Usage: ./demo/demo.sh
#
# Total time: ~5 minutes (mostly embedding generation)

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEMO_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}"
echo "  _   _ _    ____  ____   ___  _     "
echo " | \\ | | |  |___ \\/ ___| / _ \\| |    "
echo " |  \\| | |    __) \\___ \\| | | | |    "
echo " | |\\  | |___/ __/ ___) | |_| | |___ "
echo " |_| \\_|_____|_____|____/ \\__\\_\\_____|"
echo -e "${NC}"
echo "Natural Language to SQL — Demo"
echo ""

# ── Step 1: Dependencies ───────────────────────────────────────────

echo -e "${YELLOW}[1/4] Setting up dependencies...${NC}"
bash "$ROOT_DIR/scripts/setup-deps.sh"
echo ""

# ── Step 2: Database ───────────────────────────────────────────────

echo -e "${YELLOW}[2/4] Setting up database (70-table)...${NC}"
bash "$DEMO_DIR/setup-db.sh" --db=70
echo ""

# ── Step 3: Sidecar ───────────────────────────────────────────────

echo -e "${YELLOW}[3/4] Starting sidecar...${NC}"
bash "$ROOT_DIR/scripts/start-sidecar.sh" --bg
echo ""

# ── Step 4: Run sample exam ────────────────────────────────────────

echo -e "${YELLOW}[4/4] Running exam (10 questions)...${NC}"
# For demo, run 10 questions from the 70-table exam
export EXAM_MODE=true
(cd "$ROOT_DIR/mcp-server-nl2sql" && npx tsx scripts/run_exam.ts 2>&1 | head -60) || true
echo ""

# ── Done ───────────────────────────────────────────────────────────

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Demo complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. View full results:  cat mcp-server-nl2sql/exam_logs/exam_results_full_*.json | python3 -m json.tool | head -50"
echo "  2. Run full 60-question exam:  ./demo/run-exam.sh"
echo "  3. Run 2000-table exam:  ./demo/run-exam.sh --db=2000 --max=10"
echo "  4. Stop sidecar:  ./scripts/start-sidecar.sh --stop"
echo ""
echo "Config:  config/config.yaml"
echo "Docs:    docs/"
echo "Status:  STATUS.md"
