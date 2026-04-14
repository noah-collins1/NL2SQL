#!/usr/bin/env python3
"""Generate Industry-Erp exam CSV from templates_industry-erp.yaml.

Single-schema exam (public), no division substitution.
Parameters expanded: {year}, {state}, {n}.
"""
from __future__ import annotations

import csv
import random
import re
import sys
from pathlib import Path

TEMPLATES_FILE = Path(__file__).parent / "templates_industry-erp.yaml"
OUTPUT_FILE = Path(__file__).parent / "exam_industry-erp.csv"

# Parameter expansion values
YEARS = [2021, 2022, 2023, 2024, 2025]
STATES = ["OH", "CA"]
TOP_N = [3, 5, 10]
LOCATIONS = ["HUDW", "BENSON"]
WO_STATUS = ["INASSY", "COMPLT", "DESIGN"]

random.seed(42)


def parse_yaml(path: Path) -> list[dict]:
    """Minimal YAML parser for the template format (no external deps)."""
    items = []
    current: dict | None = None
    in_block = False
    block_key = ""
    block_lines: list[str] = []

    def finalize_block():
        nonlocal in_block, block_key, block_lines, current
        if in_block and current is not None and block_key:
            current[block_key] = "\n".join(block_lines)
        in_block = False
        block_key = ""
        block_lines = []

    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue

        if line.startswith("- id:"):
            finalize_block()
            if current:
                items.append(current)
            current = {"id": line.split(":", 1)[1].strip()}
            continue

        if in_block:
            if line.startswith("  "):
                block_lines.append(line[2:])
                continue
            else:
                finalize_block()

        if current is None:
            continue

        # Block scalar (gold_sql)
        m_block = re.match(r"^\s{2}(\w+):\s*\|$", line)
        if m_block:
            finalize_block()
            block_key = m_block.group(1)
            block_lines = []
            in_block = True
            continue

        # List value
        m_list = re.match(r"^\s{2}(\w+):\s*\[(.+)\]$", line)
        if m_list:
            key = m_list.group(1)
            vals = [v.strip() for v in m_list.group(2).split(",")]
            current[key] = vals
            continue

        # Scalar value
        m_scalar = re.match(r"^\s{2}(\w+):\s*(.+)$", line)
        if m_scalar:
            key, val = m_scalar.group(1), m_scalar.group(2).strip()
            # Strip surrounding quotes
            if (val.startswith('"') and val.endswith('"')) or \
               (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            current[key] = val
            continue

    finalize_block()
    if current:
        items.append(current)

    return items


def expand(tmpl: dict) -> list[dict]:
    """Expand a template into one or more concrete questions."""
    question = tmpl.get("question", "")
    gold_sql = tmpl.get("gold_sql", "").strip()

    params_needed = set(re.findall(r"\{(\w+)\}", question + gold_sql))

    variants: list[dict[str, object]] = []

    if not params_needed:
        variants.append({})
    elif params_needed == {"year"}:
        for yr in YEARS:
            variants.append({"year": yr})
    elif params_needed == {"state"}:
        for st in STATES:
            variants.append({"state": st})
    elif params_needed == {"n"}:
        for n in TOP_N:
            variants.append({"n": n})
    elif params_needed == {"year", "n"}:
        for yr in YEARS:
            for n in TOP_N:
                variants.append({"year": yr, "n": n})
    elif params_needed == {"location"}:
        for loc in LOCATIONS:
            variants.append({"location": loc})
    elif params_needed == {"location", "n"}:
        for loc in LOCATIONS:
            for n in TOP_N:
                variants.append({"location": loc, "n": n})
    elif params_needed == {"location", "year"}:
        for loc in LOCATIONS:
            for yr in YEARS:
                variants.append({"location": loc, "year": yr})
    elif params_needed == {"wo_status"}:
        for ws in WO_STATUS:
            variants.append({"wo_status": ws})
    else:
        # Unknown params — emit one question with placeholders as-is
        variants.append({})

    rows = []
    for params in variants:
        q = question
        sql = gold_sql
        for k, v in params.items():
            q = q.replace(f"{{{k}}}", str(v))
            sql = sql.replace(f"{{{k}}}", str(v))

        tags = tmpl.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]

        tables = tmpl.get("tables", [])
        if isinstance(tables, str):
            tables = [t.strip() for t in tables.split(",")]

        columns = tmpl.get("columns", [])
        if isinstance(columns, str):
            columns = [c.strip() for c in columns.split(",")]

        rows.append({
            "question": q,
            "gold_sql": sql,
            "difficulty": tmpl.get("difficulty", "medium"),
            "tags": ",".join(tags) if isinstance(tags, list) else tags,
            "template_id": tmpl.get("id", ""),
            "family": tmpl.get("family", ""),
            "expected_tables": ",".join(tables) if isinstance(tables, list) else tables,
            "expected_columns": ",".join(columns) if isinstance(columns, list) else columns,
        })

    return rows


def main():
    templates = parse_yaml(TEMPLATES_FILE)
    print(f"Loaded {len(templates)} templates", file=sys.stderr)

    all_rows = []
    for tmpl in templates:
        all_rows.extend(expand(tmpl))

    # Assign question IDs
    for i, row in enumerate(all_rows, 1):
        row["qid"] = f"T{i:04d}"

    # Shuffle for variety
    random.shuffle(all_rows)

    fieldnames = ["qid", "difficulty", "question", "gold_sql",
                  "expected_tables", "expected_columns", "tags", "template_id", "family"]

    with open(OUTPUT_FILE, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"Wrote {len(all_rows)} questions to {OUTPUT_FILE}", file=sys.stderr)

    # Summary
    from collections import Counter
    diff_counts = Counter(r["difficulty"] for r in all_rows)
    print("Difficulty breakdown:", dict(diff_counts), file=sys.stderr)
    fam_counts = Counter(r["family"] for r in all_rows)
    print("Family breakdown:", dict(fam_counts), file=sys.stderr)


if __name__ == "__main__":
    main()
