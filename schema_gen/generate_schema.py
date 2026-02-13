#!/usr/bin/env python3
"""
Generate division schemas (schema-per-division) using a Jinja2 template.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add data_gen to path so we can import seed
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_gen"))

from seed import ARCHETYPE_FOR_DIVISION, DIRTY_NAMING_DIVISIONS


def load_template(path: Path) -> str:
    return path.read_text()


def render_template(template_text: str, context: dict) -> str:
    from jinja2 import Template  # type: ignore
    return Template(template_text).render(**context)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--divisions", type=int, default=20)
    parser.add_argument("--output", type=Path, default=Path("schema_gen/generated_divisions.sql"))
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    template_path = repo_root / "schema_gen" / "division_schema_template.sql.jinja"
    base_schema_path = repo_root / "enterprise-erp" / "001_create_schema.sql"

    template_text = load_template(template_path)

    output_lines = []
    for i in range(1, args.divisions + 1):
        division_code = f"DIV{i:02d}"
        division_schema = f"div_{i:02d}"
        archetype = ARCHETYPE_FOR_DIVISION.get(division_schema, "manufacturing")
        dirty_naming = division_schema in DIRTY_NAMING_DIVISIONS
        context = {
            "division_code": division_code,
            "division_schema": division_schema,
            "base_schema_path": str(base_schema_path),
            "archetype": archetype,
            "dirty_naming": dirty_naming,
        }
        output_lines.append(render_template(template_text, context))

    args.output.write_text("\n".join(output_lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
