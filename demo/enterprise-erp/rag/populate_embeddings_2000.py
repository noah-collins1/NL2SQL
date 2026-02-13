#!/usr/bin/env python3
"""Populate rag.schema_embeddings for enterprise_erp_2000 using the sidecar."""
import json
import subprocess
import urllib.request
import os
import sys

DB = "enterprise_erp_2000"
SIDECAR_URL = os.environ.get("PYTHON_SIDECAR_URL", "http://localhost:8001")
EMBED_MODEL = "nomic-embed-text"
BATCH_SIZE = 20

os.environ["PGPASSWORD"] = "1219"

def psql(sql):
    """Run SQL and return rows as list of dicts."""
    result = subprocess.run(
        ["psql", "-h", "localhost", "-U", "postgres", "-d", DB,
         "-t", "-A", "-F", "\t", "-c", sql],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"SQL error: {result.stderr}", file=sys.stderr)
        return []
    rows = []
    for line in result.stdout.strip().split("\n"):
        if line:
            rows.append(line.split("\t"))
    return rows

def psql_exec(sql):
    """Execute SQL without returning results (uses temp file for large SQL)."""
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sql', delete=False) as f:
        f.write(sql)
        tmppath = f.name
    try:
        result = subprocess.run(
            ["psql", "-h", "localhost", "-U", "postgres", "-d", DB, "-f", tmppath],
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            print(f"SQL error: {result.stderr[:200]}", file=sys.stderr)
        return result.returncode == 0
    finally:
        os.unlink(tmppath)

def embed_batch(texts):
    """Call sidecar /embed_batch endpoint."""
    data = json.dumps({"texts": texts, "model": EMBED_MODEL}).encode()
    req = urllib.request.Request(
        f"{SIDECAR_URL}/embed_batch",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    resp = urllib.request.urlopen(req, timeout=120)
    return json.loads(resp.read())

# ============================================================================
# Step 1: Load table metadata from rag tables
# ============================================================================
print("Loading table metadata from rag.schema_tables...")
tables = psql("""
    SELECT st.table_name, st.module, st.table_gloss, st.is_hub, st.fk_degree
    FROM rag.schema_tables st
    ORDER BY st.table_name
""")
print(f"  Found {len(tables)} tables")

print("Loading column metadata from rag.schema_columns...")
columns = psql("""
    SELECT table_name, column_name, data_type, is_pk, is_fk,
           fk_target_table, fk_target_column, ordinal_pos
    FROM rag.schema_columns
    ORDER BY table_name, ordinal_pos
""")
print(f"  Found {len(columns)} columns")

# Group columns by table
cols_by_table = {}
for row in columns:
    tname = row[0]
    cols_by_table.setdefault(tname, []).append({
        "name": row[1],
        "type": row[2],
        "is_pk": row[3] == "t",
        "is_fk": row[4] == "t",
        "fk_target": row[5] if row[5] else None,
        "fk_col": row[6] if row[6] else None,
    })

# Load FK info
fks = psql("""
    SELECT table_name, column_name, ref_table_name, ref_column_name
    FROM rag.schema_fks
    ORDER BY table_name
""")
fks_by_table = {}
for row in fks:
    fks_by_table.setdefault(row[0], []).append({
        "column": row[1],
        "ref_table": row[2],
        "ref_column": row[3],
    })

# ============================================================================
# Step 2: Build embed_text for each table
# ============================================================================
print("\nBuilding embed texts...")

table_records = []
column_records = []

for row in tables:
    tname, module, gloss, is_hub, fk_degree = row[0], row[1], row[2], row[3], row[4]
    tcols = cols_by_table.get(tname, [])
    tfks = fks_by_table.get(tname, [])

    # Build table embed_text
    parts = [f"Table: {tname}"]
    if module:
        parts.append(f"Module: {module}")
    if gloss:
        parts.append(f"Description: {gloss}")

    # Column list
    col_strs = []
    for c in tcols:
        s = f"  {c['name']} ({c['type']})"
        if c["is_pk"]:
            s += " [PK]"
        if c["is_fk"] and c["fk_target"]:
            s += f" -> {c['fk_target']}.{c['fk_col']}"
        col_strs.append(s)
    if col_strs:
        parts.append("Columns:\n" + "\n".join(col_strs))

    # FK relationships
    if tfks:
        fk_strs = [f"  {f['column']} -> {f['ref_table']}.{f['ref_column']}" for f in tfks]
        parts.append("Foreign Keys:\n" + "\n".join(fk_strs))

    embed_text = "\n".join(parts)
    table_records.append({
        "entity_type": "table",
        "table_name": tname,
        "column_name": None,
        "embed_text": embed_text,
    })

    # Build column embed_texts (only non-generic columns)
    for c in tcols:
        # Skip generic columns (id, created_at, updated_at)
        if c["name"] in ("created_at", "updated_at"):
            continue
        col_embed = f"Column: {tname}.{c['name']} ({c['type']})"
        if c["is_pk"]:
            col_embed += " [Primary Key]"
        if c["is_fk"] and c["fk_target"]:
            col_embed += f" [Foreign Key -> {c['fk_target']}.{c['fk_col']}]"
        if module:
            col_embed += f" in {module} module"
        column_records.append({
            "entity_type": "column",
            "table_name": tname,
            "column_name": c["name"],
            "embed_text": col_embed,
        })

all_records = table_records + column_records
print(f"  {len(table_records)} table records, {len(column_records)} column records")
print(f"  Total: {len(all_records)} records to embed")

# ============================================================================
# Step 3: Generate embeddings in batches
# ============================================================================
print(f"\nGenerating embeddings (batch_size={BATCH_SIZE})...")

# Clear existing embeddings
psql_exec("TRUNCATE rag.schema_embeddings;")

total_inserted = 0
for i in range(0, len(all_records), BATCH_SIZE):
    batch = all_records[i:i+BATCH_SIZE]
    texts = [r["embed_text"] for r in batch]

    try:
        result = embed_batch(texts)
        embeddings = result["embeddings"]
        dim = result["dimensions"]
    except Exception as e:
        print(f"  ERROR embedding batch {i}-{i+len(batch)}: {e}")
        continue

    # Insert into DB
    values = []
    for j, rec in enumerate(batch):
        emb_str = "[" + ",".join(str(x) for x in embeddings[j]) + "]"
        # Escape single quotes in embed_text
        safe_text = rec["embed_text"].replace("'", "''")
        col_name = f"'{rec['column_name']}'" if rec["column_name"] else "NULL"
        values.append(
            f"('{rec['entity_type']}', 'public', '{rec['table_name']}', {col_name}, "
            f"'{EMBED_MODEL}', {dim}, '{safe_text}', '{emb_str}')"
        )

    insert_sql = f"""
        INSERT INTO rag.schema_embeddings
            (entity_type, table_schema, table_name, column_name,
             embed_model, embed_dim, embed_text, embedding)
        VALUES {','.join(values)}
        ON CONFLICT (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
        DO UPDATE SET embedding = EXCLUDED.embedding, embed_text = EXCLUDED.embed_text, updated_at = now();
    """
    if psql_exec(insert_sql):
        total_inserted += len(batch)
    else:
        print(f"  ERROR inserting batch {i}-{i+len(batch)}")

    pct = min(100, (i + len(batch)) * 100 // len(all_records))
    print(f"  [{pct:3d}%] Embedded {min(i+len(batch), len(all_records))}/{len(all_records)}")

# ============================================================================
# Step 4: Update search_vector for BM25
# ============================================================================
print("\nUpdating BM25 search vectors...")
psql_exec("""
    UPDATE rag.schema_embeddings
    SET search_vector = to_tsvector('english', embed_text)
    WHERE search_vector IS NULL;
""")

# ============================================================================
# Step 5: Generate module embeddings
# ============================================================================
print("Generating module embeddings...")
modules = psql("SELECT DISTINCT module FROM rag.module_mapping WHERE module IS NOT NULL ORDER BY module;")
module_names = [r[0] for r in modules]
print(f"  Modules: {module_names}")

if module_names:
    # Build module descriptions for embedding
    module_texts = []
    for mod in module_names:
        mod_tables = psql(f"SELECT table_name FROM rag.module_mapping WHERE module = '{mod}' ORDER BY table_name;")
        tnames = [r[0] for r in mod_tables]
        desc = f"Module: {mod}. Tables: {', '.join(tnames[:20])}"
        module_texts.append(desc)

    result = embed_batch(module_texts)

    psql_exec("TRUNCATE rag.module_embeddings;")
    for idx, mod in enumerate(module_names):
        emb_str = "[" + ",".join(str(x) for x in result["embeddings"][idx]) + "]"
        psql_exec(f"""
            INSERT INTO rag.module_embeddings (module_name, embedding)
            VALUES ('{mod}', '{emb_str}')
            ON CONFLICT (module_name) DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now();
        """)
    print(f"  Inserted {len(module_names)} module embeddings")

# ============================================================================
# Verification
# ============================================================================
print("\n" + "=" * 60)
counts = psql("""
    SELECT 'schema_tables' AS t, COUNT(*) FROM rag.schema_tables
    UNION ALL SELECT 'schema_columns', COUNT(*) FROM rag.schema_columns
    UNION ALL SELECT 'schema_fks', COUNT(*) FROM rag.schema_fks
    UNION ALL SELECT 'schema_embeddings', COUNT(*) FROM rag.schema_embeddings
    UNION ALL SELECT 'module_embeddings', COUNT(*) FROM rag.module_embeddings
    UNION ALL SELECT 'embeddings_with_bm25', COUNT(*) FROM rag.schema_embeddings WHERE search_vector IS NOT NULL;
""")
for row in counts:
    print(f"  rag.{row[0]}: {row[1]}")
print(f"\nTotal inserted: {total_inserted}")
print("Done!")
