#!/usr/bin/env bash
set -euo pipefail

# ── Setup Dependencies ──────────────────────────────────────────────
# Checks prerequisites, installs npm/pip packages, and pulls the Ollama model.
#
# Usage: ./scripts/setup-deps.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  [ok] $1${NC}"; }
warn() { echo -e "${YELLOW}  [warn] $1${NC}"; }
fail() { echo -e "${RED}  [FAIL] $1${NC}"; exit 1; }

echo -e "${GREEN}=== NL2SQL Dependency Setup ===${NC}"
echo ""

# ── 1. Check prerequisites ─────────────────────────────────────────

echo "Checking prerequisites..."

command -v psql >/dev/null 2>&1 && ok "PostgreSQL client (psql)" || fail "psql not found. Install PostgreSQL."

NODE_VER=$(node -v 2>/dev/null | sed 's/v//' || echo "0")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js $NODE_VER"
else
    fail "Node.js >= 18 required (found: $NODE_VER)"
fi

PYTHON_VER=$(python3 --version 2>/dev/null | awk '{print $2}' || echo "0")
PYTHON_MINOR=$(echo "$PYTHON_VER" | cut -d. -f2)
if [ "${PYTHON_MINOR:-0}" -ge 10 ] 2>/dev/null; then
    ok "Python $PYTHON_VER"
else
    fail "Python >= 3.10 required (found: $PYTHON_VER)"
fi

if command -v ollama >/dev/null 2>&1; then
    ok "Ollama"
    HAVE_OLLAMA=true
else
    warn "Ollama not found — you will need it to run the LLM"
    HAVE_OLLAMA=false
fi

echo ""

# ── 2. Install npm dependencies ────────────────────────────────────

echo "Installing npm packages..."
(cd "$ROOT_DIR/mcp-server-nl2sql" && npm install --silent)
ok "mcp-server-nl2sql npm install"

# ── 3. Create Python venv + install pip deps ───────────────────────

echo "Setting up Python sidecar..."
if [ ! -d "$ROOT_DIR/python-sidecar/venv" ]; then
    python3 -m venv "$ROOT_DIR/python-sidecar/venv"
    ok "Created venv"
else
    ok "venv already exists"
fi

(
    source "$ROOT_DIR/python-sidecar/venv/bin/activate"
    pip install -q -r "$ROOT_DIR/python-sidecar/requirements.txt"
)
ok "pip install"

# ── 4. Pull Ollama model ───────────────────────────────────────────

if [ "$HAVE_OLLAMA" = true ]; then
    # Source .env for OLLAMA_MODEL if available
    [ -f "$ROOT_DIR/.env" ] && set -a && source "$ROOT_DIR/.env" && set +a
    MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
    echo "Pulling Ollama model: $MODEL ..."
    ollama pull "$MODEL"
    ok "Ollama model $MODEL"
fi

echo ""
echo -e "${GREEN}=== Dependencies ready ===${NC}"
