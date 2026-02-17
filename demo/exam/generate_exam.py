#!/usr/bin/env python3
"""Generate exam CSVs from templates without external deps.

v1: 92 templates, 300 questions, with evidence hints
v2: 152 templates (39 families), 500 questions, NO evidence, includes ambiguity
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

# Add data_gen to path for seed imports
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_gen"))

from seed import ARCHETYPE_FOR_DIVISION, DIRTY_NAMING_DIVISIONS


def parse_simple_yaml(path: Path):
    items = []
    current = None
    in_block = False
    block_key = None
    block_lines = []

    def finalize_block():
        nonlocal in_block, block_key, block_lines, current
        if in_block and current is not None and block_key:
            current[block_key] = "\n".join(block_lines)
        in_block = False
        block_key = None
        block_lines = []

    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if line.startswith("- "):
            finalize_block()
            if current:
                items.append(current)
            current = {}
            line = line[2:]
        if in_block:
            if line.startswith("  "):
                block_lines.append(line[2:])
                continue
            else:
                finalize_block()
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            if value == "|":
                in_block = True
                block_key = key
                block_lines = []
                continue
            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1].strip()
                if not inner:
                    current[key] = []
                else:
                    current[key] = [v.strip() for v in inner.split(",")]
            else:
                if (value.startswith("\"") and value.endswith("\"")) or (value.startswith("'") and value.endswith("'")):
                    value = value[1:-1]
                current[key] = value
    finalize_block()
    if current:
        items.append(current)
    return items


def pick_schema_for_template(t, archetype_divisions, dirty_divisions_by_arch, clean_divisions_by_arch, all_divisions, rng):
    """Pick an appropriate schema for a template based on its archetype/dirty tags."""
    tags = t.get("tags", [])
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.split(",")]
    is_dirty = "dirty_naming" in tags
    archetype = t.get("archetype")

    if is_dirty and archetype:
        # Dirty naming: must use a dirty division of the right archetype
        candidates = dirty_divisions_by_arch.get(archetype, [])
        if candidates:
            return rng.choice(candidates)
    if archetype:
        # Archetype-specific: use a clean division of that archetype
        candidates = clean_divisions_by_arch.get(archetype, [])
        if candidates:
            return rng.choice(candidates)
        # Fallback to any division of that archetype
        candidates = archetype_divisions.get(archetype, [])
        if candidates:
            return rng.choice(candidates)
    # Generic: any division
    return rng.choice(all_divisions)


def generate_exam(templates, count, seed, output_path, ensure_coverage=False,
                  no_evidence=False, include_ambiguous=True):
    """Generate an exam with `count` questions.

    Args:
        no_evidence: If True, omit evidence column from output CSV
        include_ambiguous: If True, include templates with difficulty='ambiguous'
    """
    rng = random.Random(seed)

    years = [2021, 2022, 2023, 2024]
    amounts = [500, 1000, 5000, 10000]
    probs = [0.6, 0.7, 0.8, 0.9]
    capacities = [50, 100, 250, 500]
    payment_terms_vals = [15, 30, 45, 60]

    # Filter out ambiguous templates if not requested
    if not include_ambiguous:
        templates = [t for t in templates if t.get("difficulty") != "ambiguous"]

    # Separate ambiguous from non-ambiguous for distribution control
    ambiguous_templates = [t for t in templates if t.get("difficulty") == "ambiguous"]
    non_ambiguous_templates = [t for t in templates if t.get("difficulty") != "ambiguous"]

    # Build archetype→divisions mappings
    archetype_divisions = {}
    dirty_divisions_by_arch = {}
    clean_divisions_by_arch = {}
    all_divisions = list(ARCHETYPE_FOR_DIVISION.keys())

    for div_schema, archetype in ARCHETYPE_FOR_DIVISION.items():
        archetype_divisions.setdefault(archetype, []).append(div_schema)
        if div_schema in DIRTY_NAMING_DIVISIONS:
            dirty_divisions_by_arch.setdefault(archetype, []).append(div_schema)
        else:
            clean_divisions_by_arch.setdefault(archetype, []).append(div_schema)

    # Split non-ambiguous templates
    generic_templates = []
    archetype_templates_list = []
    dirty_templates = []
    for t in non_ambiguous_templates:
        tags = t.get("tags", [])
        if isinstance(tags, str):
            tags = [x.strip() for x in tags.split(",")]
        if "dirty_naming" in tags:
            dirty_templates.append(t)
        elif "archetype" in t:
            archetype_templates_list.append(t)
        else:
            generic_templates.append(t)

    rows = []

    if ensure_coverage:
        # First pass: include every template at least once
        for t in templates:
            schema = pick_schema_for_template(
                t, archetype_divisions, dirty_divisions_by_arch,
                clean_divisions_by_arch, all_divisions, rng
            )
            year = rng.choice(years)
            amount = rng.choice(amounts)
            prob = rng.choice(probs)
            capacity = rng.choice(capacities)
            payment_terms = rng.choice(payment_terms_vals)

            rows.append(_make_row(t, schema, year, amount, prob, capacity, payment_terms, len(rows),
                                  no_evidence=no_evidence))

    # Target: ~7% ambiguous if include_ambiguous
    ambiguous_target = int(count * 0.07) if ambiguous_templates else 0
    ambiguous_count = sum(1 for r in rows if r["difficulty"] == "ambiguous")

    # Fill remaining slots
    while len(rows) < count:
        # Reserve slots for ambiguous questions
        if ambiguous_templates and ambiguous_count < ambiguous_target and len(rows) >= count - (ambiguous_target - ambiguous_count):
            t = rng.choice(ambiguous_templates)
            ambiguous_count += 1
        elif ambiguous_templates and ambiguous_count < ambiguous_target and rng.random() < 0.07:
            t = rng.choice(ambiguous_templates)
            ambiguous_count += 1
        else:
            # Distribution: 60% generic, 20% archetype, 12% dirty
            r = rng.random()
            if dirty_templates and r < 0.12:
                t = rng.choice(dirty_templates)
            elif archetype_templates_list and r < 0.32:
                t = rng.choice(archetype_templates_list)
            else:
                t = rng.choice(generic_templates)

        schema = pick_schema_for_template(
            t, archetype_divisions, dirty_divisions_by_arch,
            clean_divisions_by_arch, all_divisions, rng
        )
        year = rng.choice(years)
        amount = rng.choice(amounts)
        prob = rng.choice(probs)
        capacity = rng.choice(capacities)
        payment_terms = rng.choice(payment_terms_vals)

        rows.append(_make_row(t, schema, year, amount, prob, capacity, payment_terms, len(rows),
                              no_evidence=no_evidence))

    # Shuffle (but keep stable seed)
    rng.shuffle(rows)
    # Re-number
    for i, row in enumerate(rows):
        row["qid"] = f"Q{i+1:04d}"

    # Determine CSV fields
    if no_evidence:
        fieldnames = [
            "qid", "difficulty", "question", "gold_sql",
            "expected_tables", "expected_columns", "tags", "template_id", "family"
        ]
    else:
        fieldnames = [
            "qid", "difficulty", "question", "evidence", "gold_sql",
            "expected_tables", "expected_columns", "tags", "template_id", "family"
        ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)

    # Stats
    diff_counts = {}
    tag_counts = {}
    family_counts = {}
    arch_counts = {"generic": 0}
    for row in rows:
        diff_counts[row["difficulty"]] = diff_counts.get(row["difficulty"], 0) + 1
        for tag in row["tags"].split(","):
            tag = tag.strip()
            if tag:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
        fam = row.get("family", "?")
        family_counts[fam] = family_counts.get(fam, 0) + 1
        tid = row["template_id"]
        # Find template
        matching = [t for t in templates if t["id"] == tid]
        if matching and "archetype" in matching[0]:
            a = matching[0]["archetype"]
            arch_counts[a] = arch_counts.get(a, 0) + 1
        else:
            arch_counts["generic"] += 1

    print(f"Generated {len(rows)} questions → {output_path}")
    print(f"  Difficulty: {diff_counts}")
    print(f"  Archetypes: {arch_counts}")
    unique_templates = len(set(r["template_id"] for r in rows))
    print(f"  Unique templates used: {unique_templates}/{len(templates)}")
    print(f"  Families: {len(family_counts)} unique")
    if ambiguous_templates:
        amb_count = diff_counts.get("ambiguous", 0)
        print(f"  Ambiguous questions: {amb_count} ({100*amb_count/len(rows):.1f}%)")


def _make_row(t, schema, year, amount, prob, capacity, payment_terms, idx,
              no_evidence=False):
    """Create a single exam row from a template."""
    fmt_kwargs = dict(
        schema=schema, year=year, amount=amount, prob=prob,
        capacity=capacity, payment_terms=payment_terms,
    )

    question = t["question"]
    evidence = t.get("evidence", "")
    gold_sql = t["gold_sql"]

    # Apply formatting (ignore missing keys gracefully)
    for key, val in fmt_kwargs.items():
        question = question.replace(f"{{{key}}}", str(val))
        evidence = evidence.replace(f"{{{key}}}", str(val))
        gold_sql = gold_sql.replace(f"{{{key}}}", str(val))

    tables = t.get("tables", [])
    columns = t.get("columns", [])
    tags = t.get("tags", [])
    if isinstance(tables, str):
        tables = [x.strip() for x in tables.split(",")]
    if isinstance(columns, str):
        columns = [x.strip() for x in columns.split(",")]
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.split(",")]

    row = {
        "qid": f"Q{idx+1:04d}",
        "difficulty": t["difficulty"],
        "question": question,
        "gold_sql": gold_sql,
        "expected_tables": ",".join(tables),
        "expected_columns": ",".join(columns),
        "tags": ",".join(tags),
        "template_id": t["id"],
        "family": t.get("family", ""),
    }
    if not no_evidence:
        row["evidence"] = evidence
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate exam CSVs from templates")
    parser.add_argument("--templates", type=Path, default=Path("exam/templates.yaml"))
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20240213)
    parser.add_argument("--ensure-coverage", action="store_true",
                        help="Include every template at least once")
    # v2 flags
    parser.add_argument("--v2", action="store_true",
                        help="Use v2 templates (templates_v2.yaml, 500 questions, no evidence)")
    parser.add_argument("--no-evidence", action="store_true",
                        help="Omit evidence column from output CSV")
    parser.add_argument("--include-ambiguous", action="store_true",
                        help="Include ambiguity family templates (A1-A4)")
    parser.add_argument("--target-count", type=int, default=None,
                        help="Override question count (alias for --count)")
    args = parser.parse_args()

    # v2 mode sets defaults
    if args.v2:
        if args.templates == Path("exam/templates.yaml"):
            args.templates = Path("exam/templates_v2.yaml")
        if args.count == 300:
            args.count = 500
        args.no_evidence = True
        args.include_ambiguous = True
        args.ensure_coverage = True
        if args.output is None:
            args.output = Path("exam/exam_v2_500.csv")

    if args.target_count is not None:
        args.count = args.target_count

    if args.output is None:
        args.output = Path(f"exam/exam_{args.count}.csv")

    templates = parse_simple_yaml(args.templates)
    print(f"Loaded {len(templates)} templates from {args.templates}")

    generate_exam(templates, args.count, args.seed, args.output,
                  ensure_coverage=args.ensure_coverage,
                  no_evidence=args.no_evidence,
                  include_ambiguous=args.include_ambiguous)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
