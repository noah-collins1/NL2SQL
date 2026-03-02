#!/usr/bin/env python3
"""
Generic RAG Setup Script — works with any PostgreSQL database.

Replaces the ad-hoc per-database setup process with a single systematic script.
Creates the rag.* schema, introspects the database, auto-generates glosses,
populates module definitions, and generates all embeddings.

Usage:
    python scripts/setup_rag.py \\
        --db-url postgresql://postgres:pass@host:5432/mydb \\
        --modules demo/mydb/modules.yaml \\
        [--sidecar-url http://localhost:8001] \\
        [--embed-model nomic-embed-text] \\
        [--skip-embed]       # metadata only, skip embeddings
        [--regen-embed]      # force-regenerate all embeddings

Steps:
    1. Create rag schema (tables, columns, fks, embeddings, module_definitions)
    2. Introspect information_schema → populate rag.schema_tables, schema_columns, schema_fks
    3. Load modules.yaml → populate rag.module_definitions, assign modules to tables
    4. Auto-generate table_gloss from naming patterns + key columns
    5. Compute fk_degree and is_hub status
    6. Populate BM25 search_vector
    7. Generate embeddings: tables, columns, modules (via sidecar /embed_batch)

Idempotent: safe to re-run. Uses ON CONFLICT UPDATE throughout.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Optional

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not found. Run: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)

try:
    import yaml
except ImportError:
    print("ERROR: pyyaml not found. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not found. Run: pip install requests", file=sys.stderr)
    sys.exit(1)

# ─── Schema DDL ──────────────────────────────────────────────────────────────

SCHEMA_DDL = """
CREATE SCHEMA IF NOT EXISTS rag;

-- Extension for vector similarity
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Table registry
CREATE TABLE IF NOT EXISTS rag.schema_tables (
    table_id    BIGSERIAL PRIMARY KEY,
    table_schema TEXT NOT NULL DEFAULT 'public',
    table_name  TEXT NOT NULL,
    module      TEXT,
    table_gloss TEXT,
    fk_degree   INTEGER NOT NULL DEFAULT 0,
    is_hub      BOOLEAN NOT NULL DEFAULT FALSE,
    fingerprint TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (table_schema, table_name)
);
CREATE INDEX IF NOT EXISTS idx_rag_tables_module ON rag.schema_tables(module);

-- Column metadata
CREATE TABLE IF NOT EXISTS rag.schema_columns (
    column_id     BIGSERIAL PRIMARY KEY,
    table_schema  TEXT NOT NULL DEFAULT 'public',
    table_name    TEXT NOT NULL,
    column_name   TEXT NOT NULL,
    data_type     TEXT,
    is_nullable   BOOLEAN,
    ordinal_pos   INTEGER,
    is_pk         BOOLEAN NOT NULL DEFAULT FALSE,
    pk_ordinal    INTEGER,
    is_fk         BOOLEAN NOT NULL DEFAULT FALSE,
    fk_target_table  TEXT,
    fk_target_column TEXT,
    comment       TEXT,
    inferred_gloss TEXT,
    fingerprint   TEXT,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (table_schema, table_name, column_name)
);
CREATE INDEX IF NOT EXISTS idx_rag_columns_table ON rag.schema_columns(table_schema, table_name);
CREATE INDEX IF NOT EXISTS idx_rag_columns_trgm  ON rag.schema_columns USING GIN (column_name gin_trgm_ops);

-- Foreign key graph
CREATE TABLE IF NOT EXISTS rag.schema_fks (
    fk_id           BIGSERIAL PRIMARY KEY,
    table_schema    TEXT NOT NULL DEFAULT 'public',
    table_name      TEXT NOT NULL,
    column_name     TEXT NOT NULL,
    ref_table_schema TEXT NOT NULL DEFAULT 'public',
    ref_table_name  TEXT NOT NULL,
    ref_column_name TEXT NOT NULL,
    constraint_name TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (table_schema, table_name, column_name, ref_table_schema, ref_table_name, ref_column_name)
);
CREATE INDEX IF NOT EXISTS idx_rag_fks_from ON rag.schema_fks(table_schema, table_name);
CREATE INDEX IF NOT EXISTS idx_rag_fks_to   ON rag.schema_fks(ref_table_schema, ref_table_name);

-- Vector embeddings (768-dim for nomic-embed-text)
CREATE TABLE IF NOT EXISTS rag.schema_embeddings (
    embed_id      BIGSERIAL PRIMARY KEY,
    entity_type   TEXT NOT NULL CHECK (entity_type IN ('table', 'column')),
    table_schema  TEXT NOT NULL DEFAULT 'public',
    table_name    TEXT NOT NULL,
    column_name   TEXT,
    embed_model   TEXT NOT NULL DEFAULT 'nomic-embed-text',
    embed_dim     INTEGER NOT NULL DEFAULT 768,
    embed_text    TEXT NOT NULL,
    embedding     vector(768),
    search_vector tsvector,
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
-- Partial unique index to handle NULL column_name correctly
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_embed_unique_table
    ON rag.schema_embeddings (entity_type, table_schema, table_name, embed_model, embed_dim)
    WHERE column_name IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_embed_unique_column
    ON rag.schema_embeddings (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
    WHERE column_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rag_embed_lookup ON rag.schema_embeddings(entity_type, table_schema, table_name);
CREATE INDEX IF NOT EXISTS idx_rag_embed_bm25   ON rag.schema_embeddings USING GIN (search_vector);

-- Module-level embeddings (for module router)
CREATE TABLE IF NOT EXISTS rag.module_embeddings (
    module_id   SERIAL PRIMARY KEY,
    module_name TEXT UNIQUE NOT NULL,
    embed_text  TEXT,
    embedding   vector(768),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Per-database module definitions (replaces hardcoded MODULE_KEYWORDS in TypeScript)
CREATE TABLE IF NOT EXISTS rag.module_definitions (
    module_id     SERIAL PRIMARY KEY,
    module_name   TEXT UNIQUE NOT NULL,
    description   TEXT NOT NULL,
    keywords      TEXT[] NOT NULL DEFAULT '{}',
    table_prefixes TEXT[] NOT NULL DEFAULT '{}',
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Domain glossary
CREATE TABLE IF NOT EXISTS rag.schema_glossary (
    term        TEXT PRIMARY KEY,
    definition  TEXT NOT NULL,
    category    TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
"""

# ─── Helpers ─────────────────────────────────────────────────────────────────

def camel_to_words(s: str) -> str:
    """CamelCase → space-separated words."""
    return re.sub(r'(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', ' ', s).lower()


def strip_module_prefix(table_name: str, prefix: str) -> str:
    """Strip a prefix from a table name, case-insensitively."""
    lower = table_name.lower()
    lower_prefix = prefix.lower()
    if lower.startswith(lower_prefix):
        return table_name[len(lower_prefix):]
    return table_name


def detect_module(table_name: str, module_defs: list[dict]) -> str:
    """Assign a module to a table based on table_prefixes in module_definitions."""
    lower = table_name.lower()
    for mod in module_defs:
        for pfx in mod.get("table_prefixes", []):
            if pfx and lower.startswith(pfx.lower()):
                return mod["name"]
    return "Other"


def auto_generate_gloss(table_name: str, module_name: str,
                         top_columns: list[dict]) -> str:
    """Generate a descriptive gloss from table name and key columns."""
    # Strip common table prefixes like 'tbl', 'tbl{module}'
    name = table_name
    if name.lower().startswith('tbl'):
        name = name[3:]

    # Try to strip module code from front (e.g. 'soSO' → 'SO' for module SO)
    for mc in ['SO', 'AR', 'PO', 'AP', 'GL', 'IM', 'WH', 'SN', 'SA',
               'so', 'ar', 'po', 'ap', 'gl', 'im', 'wh', 'sn', 'sa']:
        if name.lower().startswith(mc.lower()) and len(name) > len(mc):
            name = name[len(mc):]
            break

    entity_words = camel_to_words(name).strip()

    # Key columns for context
    pk_cols = [c['column_name'] for c in top_columns if c.get('is_pk')]
    fk_cols = [f"{c['column_name']}→{c['fk_target_table']}"
               for c in top_columns if c.get('is_fk') and c.get('fk_target_table')]
    notable = [c['column_name'] for c in top_columns[:6]
               if not c.get('is_pk') and not c.get('is_fk')
               and c['column_name'].lower() not in ('dateadded', 'datemod', 'useridadded', 'useridmod',
                                                      'created_at', 'updated_at', 'fingerprint')]

    parts = [f"{module_name} module — {entity_words} table."]
    if pk_cols:
        parts.append(f"PK: {', '.join(pk_cols[:2])}.")
    if fk_cols:
        parts.append(f"Links to: {', '.join(fk_cols[:3])}.")
    if notable:
        parts.append(f"Key fields: {', '.join(notable[:4])}.")

    return ' '.join(parts)


# ─── Embedding via sidecar ───────────────────────────────────────────────────

def embed_batch(texts: list[str], sidecar_url: str, model: str,
                batch_size: int = 20) -> list[list[float]]:
    """Call the sidecar /embed_batch endpoint to get embeddings."""
    all_embeddings: list[list[float]] = []
    url = f"{sidecar_url.rstrip('/')}/embed_batch"

    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        resp = requests.post(url, json={"texts": batch, "model": model}, timeout=120)
        if resp.status_code != 200:
            raise RuntimeError(f"embed_batch failed: {resp.status_code} {resp.text[:200]}")
        data = resp.json()
        embeddings = data.get("embeddings", [])
        if len(embeddings) != len(batch):
            raise RuntimeError(f"embed_batch returned {len(embeddings)} for {len(batch)} texts")
        all_embeddings.extend(embeddings)
        print(f"  Embedded {min(i + batch_size, len(texts))}/{len(texts)}...", end='\r', flush=True)

    print()  # newline after \r progress
    return all_embeddings


def vec_literal(embedding: list[float]) -> str:
    return '[' + ','.join(f'{v:.8f}' for v in embedding) + ']'


# ─── Main setup steps ────────────────────────────────────────────────────────

def step_create_schema(cur):
    print("Step 1: Creating rag schema tables...")
    cur.execute(SCHEMA_DDL)
    print("  Done.")


def step_introspect(cur, target_schema: str = 'public'):
    print(f"Step 2: Introspecting {target_schema} schema...")

    # Tables
    cur.execute("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = %s AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """, (target_schema,))
    tables = [row[0] for row in cur.fetchall()]
    print(f"  Found {len(tables)} tables")

    for tbl in tables:
        cur.execute("""
            INSERT INTO rag.schema_tables (table_schema, table_name, fingerprint)
            VALUES (%s, %s, md5(%s))
            ON CONFLICT (table_schema, table_name) DO NOTHING
        """, (target_schema, tbl, tbl))

    # Columns with PK/FK info
    cur.execute("""
        WITH pk_info AS (
            SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
                   ROW_NUMBER() OVER (PARTITION BY kcu.table_schema, kcu.table_name
                                      ORDER BY kcu.ordinal_position) AS pk_ord
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = %s
        ),
        fk_info AS (
            SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
                   ccu.table_name AS ref_table, ccu.column_name AS ref_col
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = %s
        )
        SELECT
            c.table_name, c.column_name, c.data_type,
            c.is_nullable = 'YES' AS is_nullable,
            c.ordinal_position,
            pk.pk_ord IS NOT NULL AS is_pk,
            pk.pk_ord,
            fk.ref_table IS NOT NULL AS is_fk,
            fk.ref_table, fk.ref_col
        FROM information_schema.columns c
        LEFT JOIN pk_info pk USING (table_schema, table_name, column_name)
        LEFT JOIN fk_info fk USING (table_schema, table_name, column_name)
        WHERE c.table_schema = %s
        ORDER BY c.table_name, c.ordinal_position
    """, (target_schema, target_schema, target_schema))

    cols = cur.fetchall()
    print(f"  Found {len(cols)} columns")

    for row in cols:
        (tbl, col, dtype, nullable, ordpos,
         is_pk, pk_ord, is_fk, ref_table, ref_col) = row
        cur.execute("""
            INSERT INTO rag.schema_columns
              (table_schema, table_name, column_name, data_type, is_nullable,
               ordinal_pos, is_pk, pk_ordinal, is_fk, fk_target_table, fk_target_column, fingerprint)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, md5(%s || '.' || %s))
            ON CONFLICT (table_schema, table_name, column_name)
            DO UPDATE SET data_type=EXCLUDED.data_type, is_nullable=EXCLUDED.is_nullable,
              ordinal_pos=EXCLUDED.ordinal_pos, is_pk=EXCLUDED.is_pk,
              pk_ordinal=EXCLUDED.pk_ordinal, is_fk=EXCLUDED.is_fk,
              fk_target_table=EXCLUDED.fk_target_table, fk_target_column=EXCLUDED.fk_target_column,
              updated_at=NOW()
        """, (target_schema, tbl, col, dtype, nullable, ordpos,
              is_pk, pk_ord, is_fk, ref_table, ref_col, tbl, col))

    # FK graph
    cur.execute("""
        SELECT
            kcu.table_name, kcu.column_name,
            ccu.table_name AS ref_table, ccu.column_name AS ref_col,
            tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = %s
    """, (target_schema,))

    fks = cur.fetchall()
    print(f"  Found {len(fks)} FK constraints")

    for tbl, col, ref_tbl, ref_col, cname in fks:
        cur.execute("""
            INSERT INTO rag.schema_fks
              (table_schema, table_name, column_name,
               ref_table_schema, ref_table_name, ref_column_name, constraint_name)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (table_schema, table_name, column_name,
                         ref_table_schema, ref_table_name, ref_column_name)
            DO NOTHING
        """, (target_schema, tbl, col, target_schema, ref_tbl, ref_col, cname))

    print("  Introspect done.")


def step_load_modules(cur, modules_yaml: Path, target_schema: str = 'public'):
    print(f"Step 3: Loading module definitions from {modules_yaml}...")

    with open(modules_yaml) as f:
        data = yaml.safe_load(f)

    module_defs = data.get('modules', [])
    print(f"  Found {len(module_defs)} modules")

    for mod in module_defs:
        name = mod['name']
        desc = mod['description']
        kws = mod.get('keywords', [])
        prefixes = mod.get('table_prefixes', [])

        cur.execute("""
            INSERT INTO rag.module_definitions
              (module_name, description, keywords, table_prefixes)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (module_name) DO UPDATE SET
              description=EXCLUDED.description,
              keywords=EXCLUDED.keywords,
              table_prefixes=EXCLUDED.table_prefixes,
              updated_at=NOW()
        """, (name, desc, kws, prefixes))

    # Assign modules to tables
    cur.execute("SELECT table_name FROM rag.schema_tables WHERE table_schema = %s", (target_schema,))
    tables = [r[0] for r in cur.fetchall()]

    assigned = 0
    for tbl in tables:
        module = detect_module(tbl, module_defs)
        cur.execute("""
            UPDATE rag.schema_tables SET module = %s
            WHERE table_schema = %s AND table_name = %s
        """, (module, target_schema, tbl))
        assigned += 1

    print(f"  Assigned modules to {assigned} tables")

    # Print module distribution
    cur.execute("""
        SELECT module, COUNT(*) FROM rag.schema_tables
        WHERE table_schema = %s GROUP BY module ORDER BY COUNT(*) DESC
    """, (target_schema,))
    for row in cur.fetchall():
        print(f"    {row[0] or 'None':12s}: {row[1]} tables")

    return module_defs


def step_generate_glosses(cur, module_defs: list[dict], target_schema: str = 'public'):
    print("Step 4: Generating table glosses...")

    cur.execute("""
        SELECT t.table_name, t.module, t.table_gloss
        FROM rag.schema_tables t
        WHERE t.table_schema = %s
        ORDER BY t.table_name
    """, (target_schema,))
    tables = cur.fetchall()

    updated = 0
    for table_name, module_name, existing_gloss in tables:
        # Never overwrite a manually-written long gloss (>80 chars = manual)
        if existing_gloss and len(existing_gloss) > 80:
            continue

        # Load top columns for context
        cur.execute("""
            SELECT column_name, data_type, is_pk, is_fk, fk_target_table
            FROM rag.schema_columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY is_pk DESC, ordinal_pos ASC
            LIMIT 12
        """, (target_schema, table_name))
        cols = [dict(zip(['column_name','data_type','is_pk','is_fk','fk_target_table'], r))
                for r in cur.fetchall()]

        gloss = auto_generate_gloss(table_name, module_name or 'Unknown', cols)

        cur.execute("""
            UPDATE rag.schema_tables SET table_gloss = %s, updated_at = NOW()
            WHERE table_schema = %s AND table_name = %s
        """, (gloss, target_schema, table_name))
        updated += 1

    print(f"  Generated glosses for {updated} tables")


def step_compute_hub_status(cur, target_schema: str = 'public'):
    print("Step 5: Computing fk_degree and is_hub...")

    cur.execute("""
        UPDATE rag.schema_tables t
        SET fk_degree = (
            SELECT COUNT(*)
            FROM rag.schema_fks f
            WHERE (f.table_schema = t.table_schema AND f.table_name = t.table_name)
               OR (f.ref_table_schema = t.table_schema AND f.ref_table_name = t.table_name)
        ),
        updated_at = NOW()
        WHERE t.table_schema = %s
    """, (target_schema,))

    cur.execute("""
        UPDATE rag.schema_tables
        SET is_hub = (fk_degree > 8), updated_at = NOW()
        WHERE table_schema = %s
    """, (target_schema,))

    cur.execute("""
        SELECT COUNT(*) FROM rag.schema_tables WHERE table_schema = %s AND is_hub = TRUE
    """, (target_schema,))
    hub_count = cur.fetchone()[0]
    print(f"  {hub_count} hub tables (fk_degree > 8)")


def step_bm25(cur, target_schema: str = 'public'):
    print("Step 6: Updating BM25 search vectors...")

    # Refresh search_vector on schema_embeddings (if any exist)
    cur.execute("""
        UPDATE rag.schema_embeddings
        SET search_vector = to_tsvector('english', embed_text),
            updated_at = NOW()
        WHERE (search_vector IS NULL OR search_vector = to_tsvector(''))
          AND embed_text IS NOT NULL
    """)
    print("  BM25 search vectors updated")


def step_embeddings(cur, conn, target_schema: str, sidecar_url: str,
                    embed_model: str, regen: bool = False,
                    skip_columns: bool = False):
    print("Step 7: Generating embeddings...")

    # ── Table embeddings ──────────────────────────────────────────────────
    print("  Building table embed_text...")
    cur.execute("""
        SELECT t.table_name, t.module, t.table_gloss, t.is_hub,
               ARRAY_AGG(
                   c.column_name || ' (' || c.data_type || ')'
                   || CASE WHEN c.is_pk THEN ' [PK]' ELSE '' END
                   || CASE WHEN c.is_fk AND c.fk_target_table IS NOT NULL
                           THEN ' [FK→' || c.fk_target_table || ']' ELSE '' END
                   ORDER BY c.ordinal_pos
               ) AS col_descs
        FROM rag.schema_tables t
        LEFT JOIN rag.schema_columns c
               ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE t.table_schema = %s
        GROUP BY t.table_name, t.module, t.table_gloss, t.is_hub
        ORDER BY t.table_name
    """, (target_schema,))
    table_rows = cur.fetchall()

    table_records = []
    for table_name, module, gloss, is_hub, col_descs in table_rows:
        col_descs = [c for c in (col_descs or []) if c] [:20]
        embed_text = f"Table: {table_name}\nModule: {module or 'Unknown'}\n"
        if gloss:
            embed_text += f"Description: {gloss}\n"
        embed_text += "Columns:\n  " + "\n  ".join(col_descs)
        table_records.append((table_name, embed_text))

    # Filter already-embedded unless regen
    to_embed = []
    for table_name, embed_text in table_records:
        if not regen:
            cur.execute("""
                SELECT 1 FROM rag.schema_embeddings
                WHERE entity_type='table' AND table_schema=%s AND table_name=%s
                  AND column_name IS NULL AND embed_model=%s
            """, (target_schema, table_name, embed_model))
            if cur.fetchone():
                continue
        to_embed.append((table_name, embed_text))

    print(f"  Embedding {len(to_embed)}/{len(table_records)} tables...")
    if to_embed:
        texts = [r[1] for r in to_embed]
        embeddings = embed_batch(texts, sidecar_url, embed_model)
        for (table_name, embed_text), emb in zip(to_embed, embeddings):
            cur.execute("""
                INSERT INTO rag.schema_embeddings
                  (entity_type, table_schema, table_name, column_name,
                   embed_model, embed_dim, embed_text, embedding)
                VALUES ('table', %s, %s, NULL, %s, %s, %s, %s::vector)
                ON CONFLICT (entity_type, table_schema, table_name, embed_model, embed_dim)
                  WHERE column_name IS NULL
                DO UPDATE SET embed_text=EXCLUDED.embed_text,
                  embedding=EXCLUDED.embedding, updated_at=NOW()
            """, (target_schema, table_name, embed_model, len(emb),
                  embed_text, vec_literal(emb)))
        conn.commit()

    # ── Column embeddings ─────────────────────────────────────────────────
    if not skip_columns:
        print("  Building column embed_text...")
        SKIP_GENERIC = {'dateadded', 'datemod', 'useridadded', 'useridmod',
                        'created_at', 'updated_at', 'fingerprint', 'id',
                        'updated_by', 'created_by'}

        cur.execute("""
            SELECT c.table_name, c.column_name, c.data_type, c.is_pk, c.is_fk,
                   c.fk_target_table, c.fk_target_column, t.module
            FROM rag.schema_columns c
            JOIN rag.schema_tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = %s
            ORDER BY c.table_name, c.ordinal_pos
        """, (target_schema,))
        col_rows = cur.fetchall()

        col_records = []
        for row in col_rows:
            tbl, col, dtype, is_pk, is_fk, ref_tbl, ref_col, module = row
            if col.lower() in SKIP_GENERIC and not is_pk:
                continue
            text = f"Column: {tbl}.{col} ({dtype})"
            if is_pk:
                text += " [PK]"
            if is_fk and ref_tbl:
                text += f" [FK→{ref_tbl}.{ref_col}]"
            text += f"\nModule: {module or 'Unknown'}"
            col_records.append((tbl, col, text))

        to_embed_cols = []
        for tbl, col, embed_text in col_records:
            if not regen:
                cur.execute("""
                    SELECT 1 FROM rag.schema_embeddings
                    WHERE entity_type='column' AND table_schema=%s
                      AND table_name=%s AND column_name=%s AND embed_model=%s
                """, (target_schema, tbl, col, embed_model))
                if cur.fetchone():
                    continue
            to_embed_cols.append((tbl, col, embed_text))

        print(f"  Embedding {len(to_embed_cols)}/{len(col_records)} columns...")
        BATCH = 50
        for i in range(0, len(to_embed_cols), BATCH):
            batch = to_embed_cols[i:i + BATCH]
            texts = [r[2] for r in batch]
            embeddings = embed_batch(texts, sidecar_url, embed_model, batch_size=BATCH)
            for (tbl, col, embed_text), emb in zip(batch, embeddings):
                cur.execute("""
                    INSERT INTO rag.schema_embeddings
                      (entity_type, table_schema, table_name, column_name,
                       embed_model, embed_dim, embed_text, embedding)
                    VALUES ('column', %s, %s, %s, %s, %s, %s, %s::vector)
                    ON CONFLICT (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
                      WHERE column_name IS NOT NULL
                    DO UPDATE SET embed_text=EXCLUDED.embed_text,
                      embedding=EXCLUDED.embedding, updated_at=NOW()
                """, (target_schema, tbl, col, embed_model, len(emb),
                      embed_text, vec_literal(emb)))
            conn.commit()
            print(f"    Columns: {min(i+BATCH, len(to_embed_cols))}/{len(to_embed_cols)}")

    # ── Module embeddings (from module_definitions.description) ──────────
    print("  Building module embeddings from module_definitions.description...")
    cur.execute("SELECT module_name, description FROM rag.module_definitions ORDER BY module_name")
    mod_defs = cur.fetchall()

    if not mod_defs:
        print("  No module_definitions found — skipping module embeddings")
    else:
        module_texts = []
        for mod_name, desc in mod_defs:
            # Augment description with actual table names for this module
            cur.execute("""
                SELECT table_name FROM rag.schema_tables
                WHERE table_schema = %s AND module = %s
                ORDER BY table_name LIMIT 20
            """, (target_schema, mod_name))
            tbl_names = [r[0] for r in cur.fetchall()]
            text = desc
            if tbl_names:
                text += f"\nTables: {', '.join(tbl_names)}"
            module_texts.append((mod_name, text))

        print(f"  Embedding {len(module_texts)} modules...")
        texts = [r[1] for r in module_texts]
        embeddings = embed_batch(texts, sidecar_url, embed_model)

        for (mod_name, text), emb in zip(module_texts, embeddings):
            cur.execute("""
                INSERT INTO rag.module_embeddings (module_name, embed_text, embedding)
                VALUES (%s, %s, %s::vector)
                ON CONFLICT (module_name) DO UPDATE SET
                  embed_text=EXCLUDED.embed_text,
                  embedding=EXCLUDED.embedding, updated_at=NOW()
            """, (mod_name, text, vec_literal(emb)))
        conn.commit()

    # Update BM25 search vectors
    step_bm25(cur, target_schema)
    conn.commit()

    # Final counts
    cur.execute("SELECT COUNT(*) FROM rag.schema_embeddings")
    total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM rag.module_embeddings")
    mod_total = cur.fetchone()[0]
    print(f"  Total: {total} entity embeddings, {mod_total} module embeddings")


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generic NL2SQL RAG Setup")
    parser.add_argument("--db-url", required=True, help="PostgreSQL connection string")
    parser.add_argument("--modules", required=True, help="Path to modules.yaml")
    parser.add_argument("--sidecar-url", default="http://localhost:8001",
                        help="Python sidecar URL for embeddings (default: http://localhost:8001)")
    parser.add_argument("--embed-model", default="nomic-embed-text",
                        help="Embedding model (default: nomic-embed-text)")
    parser.add_argument("--schema", default="public",
                        help="Target PostgreSQL schema (default: public)")
    parser.add_argument("--skip-introspect", action="store_true",
                        help="Skip schema introspection (use if rag.schema_tables already populated)")
    parser.add_argument("--skip-embed", action="store_true",
                        help="Skip embedding generation (metadata only)")
    parser.add_argument("--skip-columns", action="store_true",
                        help="Skip column-level embeddings (only table + module)")
    parser.add_argument("--regen-embed", action="store_true",
                        help="Force-regenerate all embeddings even if they exist")
    args = parser.parse_args()

    modules_path = Path(args.modules)
    if not modules_path.exists():
        print(f"ERROR: modules file not found: {modules_path}", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"NL2SQL RAG Setup")
    print(f"  DB:      {args.db_url.split('@')[-1]}")  # hide credentials
    print(f"  Modules: {modules_path}")
    print(f"  Sidecar: {args.sidecar_url}")
    print(f"  Model:   {args.embed_model}")
    print(f"  Schema:  {args.schema}")
    print(f"{'='*60}\n")

    conn = psycopg2.connect(args.db_url)
    conn.autocommit = False
    cur = conn.cursor()

    t0 = time.time()

    step_create_schema(cur)
    conn.commit()

    if not args.skip_introspect:
        step_introspect(cur, args.schema)
        conn.commit()
    else:
        print("Step 2: Skipping introspection (--skip-introspect)")

    module_defs = step_load_modules(cur, modules_path, args.schema)
    conn.commit()

    step_generate_glosses(cur, module_defs, args.schema)
    conn.commit()

    step_compute_hub_status(cur, args.schema)
    conn.commit()

    if not args.skip_embed:
        step_embeddings(cur, conn, args.schema, args.sidecar_url,
                        args.embed_model, regen=args.regen_embed,
                        skip_columns=args.skip_columns)
    else:
        step_bm25(cur, args.schema)
        conn.commit()
        print("  (embeddings skipped)")

    # Summary
    cur.execute("SELECT COUNT(*) FROM rag.schema_tables WHERE table_schema=%s", (args.schema,))
    n_tables = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM rag.schema_columns WHERE table_schema=%s", (args.schema,))
    n_cols = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM rag.schema_fks WHERE table_schema=%s", (args.schema,))
    n_fks = cur.fetchone()[0]

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"RAG setup complete in {elapsed:.1f}s")
    print(f"  Tables:  {n_tables}")
    print(f"  Columns: {n_cols}")
    print(f"  FKs:     {n_fks}")
    print(f"{'='*60}\n")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
