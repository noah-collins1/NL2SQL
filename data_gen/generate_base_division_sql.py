#!/usr/bin/env python3
"""Generate base ERP sample data SQL for a specific division schema.
Uses the existing 002_generate_sample_data.py generator with a per-division seed.
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path


def load_generator(path: Path):
    spec = importlib.util.spec_from_file_location("erp_sample_gen", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Failed to load generator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=20240213)
    parser.add_argument("--schema", type=str, default="div_01")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    gen_path = repo_root / "enterprise-erp" / "002_generate_sample_data.py"
    gen = load_generator(gen_path)

    # Override RNG seed for per-division variance
    gen.random.seed(args.seed)

    sql = gen.generate_sql()
    # Ensure schema-targeted execution
    sql = f"SET search_path TO {args.schema};\n" + sql
    print(sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
