#!/bin/bash
# Wrapper to build the 2000-table ERP database
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

chmod +x "$ROOT_DIR/schema_gen/apply_schema.sh"
"$ROOT_DIR/schema_gen/apply_schema.sh"
