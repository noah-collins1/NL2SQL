#!/usr/bin/env bash
set -euo pipefail

# ── Start Python Sidecar ────────────────────────────────────────────
# Activates venv, starts the sidecar, and verifies health.
#
# Usage:
#   ./scripts/start-sidecar.sh         # Start in foreground
#   ./scripts/start-sidecar.sh --bg    # Start in background (writes PID file)
#   ./scripts/start-sidecar.sh --stop  # Stop background sidecar

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.sidecar.pid"
SIDECAR_DIR="$ROOT_DIR/python-sidecar"
LOG_FILE="/tmp/nl2sql-sidecar.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  [ok] $1${NC}"; }
warn() { echo -e "${YELLOW}  [warn] $1${NC}"; }
fail() { echo -e "${RED}  [FAIL] $1${NC}"; exit 1; }

# Source .env if present
[ -f "$ROOT_DIR/.env" ] && set -a && source "$ROOT_DIR/.env" && set +a

# ── Stop mode ───────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            ok "Stopped sidecar (PID $PID)"
        else
            warn "Sidecar PID $PID not running"
        fi
        rm -f "$PID_FILE"
    else
        # Also try pkill as fallback
        pkill -f "python.*app.py" 2>/dev/null && ok "Stopped sidecar via pkill" || warn "No sidecar running"
    fi
    exit 0
fi

# ── Pre-flight checks ──────────────────────────────────────────────

if [ ! -d "$SIDECAR_DIR/venv" ]; then
    fail "Python venv not found. Run ./scripts/setup-deps.sh first."
fi

# Check if Ollama is reachable
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
if ! curl -s --connect-timeout 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    fail "Ollama not reachable at $OLLAMA_URL. Start Ollama first."
fi
ok "Ollama reachable at $OLLAMA_URL"

# Check if sidecar is already running
SIDECAR_URL="${PYTHON_SIDECAR_URL:-http://localhost:8001}"
if curl -s --connect-timeout 2 "$SIDECAR_URL/health" >/dev/null 2>&1; then
    ok "Sidecar already running at $SIDECAR_URL"
    exit 0
fi

# ── Start sidecar ──────────────────────────────────────────────────

echo "Starting sidecar..."

if [[ "${1:-}" == "--bg" ]]; then
    (
        cd "$SIDECAR_DIR"
        source venv/bin/activate
        nohup python app.py > "$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
    )
    PID=$(cat "$PID_FILE")

    # Wait for health check
    for i in $(seq 1 15); do
        if curl -s --connect-timeout 2 "$SIDECAR_URL/health" >/dev/null 2>&1; then
            ok "Sidecar started in background (PID $PID, log: $LOG_FILE)"
            exit 0
        fi
        sleep 1
    done
    fail "Sidecar failed to start within 15s. Check $LOG_FILE"
else
    echo "Running in foreground (Ctrl+C to stop)..."
    cd "$SIDECAR_DIR"
    source venv/bin/activate
    exec python app.py
fi
