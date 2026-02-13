#!/usr/bin/env python3
"""Run SQL validation checks via psql."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="enterprise_erp_2000")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", default="5432")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    sql_path = repo_root / "validation" / "validate_db.sql"

    cmd = [
        "psql",
        "-h", args.host,
        "-p", args.port,
        "-U", "postgres",
        "-d", args.db,
        "-f", str(sql_path),
    ]
    print("Running:", " ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
