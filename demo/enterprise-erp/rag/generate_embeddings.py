#!/usr/bin/env python3
"""
Generate embeddings for ERP schema tables and columns.

Phase B: Embedding Pipeline
- Fetches table/column data from rag.* tables
- Generates embeddings via Python sidecar
- Inserts into rag.schema_embeddings

Usage:
    python generate_embeddings.py [--tables-only] [--columns-only]
"""

import argparse
import json
import sys
import time
from typing import List, Dict, Any, Optional

import psycopg2
import psycopg2.extras
import requests

# Configuration
DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "enterprise_erp",
    "user": "postgres",
    "password": "1219"
}

SIDECAR_URL = "http://localhost:8001"
EMBED_MODEL = "nomic-embed-text:latest"
EMBED_DIM = 768

BATCH_SIZE = 10  # Embeddings per batch (for progress reporting)


def get_db_connection():
    """Get database connection"""
    return psycopg2.connect(**DB_CONFIG)


def get_embedding(text: str) -> List[float]:
    """Get embedding from sidecar"""
    response = requests.post(
        f"{SIDECAR_URL}/embed",
        json={"text": text, "model": EMBED_MODEL},
        timeout=60
    )
    response.raise_for_status()
    return response.json()["embedding"]


def build_table_embed_text(table: Dict[str, Any], columns: List[Dict[str, Any]]) -> str:
    """
    Build embedding text for a table.

    Format:
    {table_name} ({module}): {columns with FK annotations}. {table_gloss}
    """
    # Build column list with FK annotations
    col_parts = []
    for col in columns:
        col_str = col["column_name"]
        if col["is_fk"] and col["fk_target_table"]:
            col_str += f" → {col['fk_target_table']}"
        col_parts.append(col_str)

    columns_str = ", ".join(col_parts)

    text = f"{table['table_name']} ({table['module']}): {columns_str}. {table['table_gloss']}"
    return text


def build_column_embed_text(col: Dict[str, Any], table: Dict[str, Any]) -> str:
    """
    Build embedding text for a column.

    Format:
    {table_name}.{column_name} ({type}): {gloss}
    """
    type_str = col["data_type"]
    if col["is_pk"]:
        type_str = f"PK, {type_str}"
    elif col["is_fk"]:
        type_str = f"FK → {col['fk_target_table']}"

    text = f"{table['table_name']}.{col['column_name']} ({type_str}): {col['inferred_gloss']}"
    return text


def fetch_tables(conn) -> List[Dict[str, Any]]:
    """Fetch all tables from rag.schema_tables"""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT table_schema, table_name, module, table_gloss
            FROM rag.schema_tables
            ORDER BY table_name
        """)
        return list(cur.fetchall())


def fetch_columns(conn, table_name: str) -> List[Dict[str, Any]]:
    """Fetch columns for a specific table"""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT column_name, data_type, is_pk, is_fk,
                   fk_target_table, fk_target_column, inferred_gloss, ordinal_pos
            FROM rag.schema_columns
            WHERE table_name = %s
            ORDER BY ordinal_pos
        """, (table_name,))
        return list(cur.fetchall())


def insert_embedding(
    conn,
    entity_type: str,
    table_schema: str,
    table_name: str,
    column_name: Optional[str],
    embed_text: str,
    embedding: List[float]
):
    """Insert embedding into rag.schema_embeddings"""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO rag.schema_embeddings
                (entity_type, table_schema, table_name, column_name,
                 embed_model, embed_dim, embed_text, embedding)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (entity_type, table_schema, table_name, column_name, embed_model, embed_dim)
            DO UPDATE SET
                embed_text = EXCLUDED.embed_text,
                embedding = EXCLUDED.embedding,
                updated_at = now()
        """, (
            entity_type,
            table_schema,
            table_name,
            column_name,
            EMBED_MODEL,
            EMBED_DIM,
            embed_text,
            embedding
        ))


def generate_table_embeddings(conn, tables: List[Dict[str, Any]]) -> int:
    """Generate embeddings for all tables"""
    print(f"\n📊 Generating table embeddings ({len(tables)} tables)...")

    count = 0
    start_time = time.time()

    for i, table in enumerate(tables):
        # Fetch columns for this table
        columns = fetch_columns(conn, table["table_name"])

        # Build embedding text
        embed_text = build_table_embed_text(table, columns)

        # Generate embedding
        try:
            embedding = get_embedding(embed_text)

            # Insert into database
            insert_embedding(
                conn,
                entity_type="table",
                table_schema=table["table_schema"],
                table_name=table["table_name"],
                column_name=None,
                embed_text=embed_text,
                embedding=embedding
            )
            conn.commit()
            count += 1

            # Progress update
            if (i + 1) % BATCH_SIZE == 0:
                elapsed = time.time() - start_time
                rate = count / elapsed
                print(f"  [{i+1}/{len(tables)}] {table['table_name']:<30} ({rate:.1f} tables/sec)")

        except Exception as e:
            print(f"  ❌ Error embedding {table['table_name']}: {e}")
            conn.rollback()

    elapsed = time.time() - start_time
    print(f"\n✅ Generated {count} table embeddings in {elapsed:.1f}s ({count/elapsed:.1f}/sec)")
    return count


def generate_column_embeddings(conn, tables: List[Dict[str, Any]]) -> int:
    """Generate embeddings for all columns"""
    # First, count total columns
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM rag.schema_columns")
        total_columns = cur.fetchone()[0]

    print(f"\n📊 Generating column embeddings ({total_columns} columns)...")

    count = 0
    start_time = time.time()

    for table in tables:
        columns = fetch_columns(conn, table["table_name"])

        for col in columns:
            # Build embedding text
            embed_text = build_column_embed_text(col, table)

            try:
                # Generate embedding
                embedding = get_embedding(embed_text)

                # Insert into database
                insert_embedding(
                    conn,
                    entity_type="column",
                    table_schema=table["table_schema"],
                    table_name=table["table_name"],
                    column_name=col["column_name"],
                    embed_text=embed_text,
                    embedding=embedding
                )
                conn.commit()
                count += 1

                # Progress update
                if count % (BATCH_SIZE * 5) == 0:
                    elapsed = time.time() - start_time
                    rate = count / elapsed
                    print(f"  [{count}/{total_columns}] {table['table_name']}.{col['column_name']:<20} ({rate:.1f} cols/sec)")

            except Exception as e:
                print(f"  ❌ Error embedding {table['table_name']}.{col['column_name']}: {e}")
                conn.rollback()

    elapsed = time.time() - start_time
    print(f"\n✅ Generated {count} column embeddings in {elapsed:.1f}s ({count/elapsed:.1f}/sec)")
    return count


def verify_embeddings(conn):
    """Verify embeddings were created correctly"""
    print("\n🔍 Verifying embeddings...")

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Count by entity type
        cur.execute("""
            SELECT entity_type, COUNT(*) as count
            FROM rag.schema_embeddings
            GROUP BY entity_type
        """)
        counts = {row["entity_type"]: row["count"] for row in cur.fetchall()}

        print(f"  Table embeddings: {counts.get('table', 0)}")
        print(f"  Column embeddings: {counts.get('column', 0)}")

        # Sample a vector search
        cur.execute("""
            SELECT table_name, embed_text
            FROM rag.schema_embeddings
            WHERE entity_type = 'table'
            LIMIT 1
        """)
        sample = cur.fetchone()
        if sample:
            print(f"\n  Sample table: {sample['table_name']}")
            print(f"  Embed text: {sample['embed_text'][:100]}...")


def main():
    parser = argparse.ArgumentParser(description="Generate schema embeddings")
    parser.add_argument("--tables-only", action="store_true", help="Only generate table embeddings")
    parser.add_argument("--columns-only", action="store_true", help="Only generate column embeddings")
    args = parser.parse_args()

    print("=" * 60)
    print("Phase B: Embedding Pipeline")
    print("=" * 60)

    # Check sidecar health
    print("\n🔌 Checking sidecar connection...")
    try:
        response = requests.get(f"{SIDECAR_URL}/health", timeout=5)
        health = response.json()
        print(f"  Sidecar: {health['status']}")
        print(f"  Ollama: {health['ollama']}")
    except Exception as e:
        print(f"  ❌ Sidecar not reachable: {e}")
        print("  Start sidecar with: cd python-sidecar && uvicorn app:app --port 8001")
        sys.exit(1)

    # Connect to database
    print("\n🗄️  Connecting to database...")
    conn = get_db_connection()
    print(f"  Connected to {DB_CONFIG['database']}")

    # Fetch tables
    tables = fetch_tables(conn)
    print(f"  Found {len(tables)} tables")

    # Generate embeddings
    table_count = 0
    column_count = 0

    if not args.columns_only:
        table_count = generate_table_embeddings(conn, tables)

    if not args.tables_only:
        column_count = generate_column_embeddings(conn, tables)

    # Verify
    verify_embeddings(conn)

    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"  Tables embedded: {table_count}")
    print(f"  Columns embedded: {column_count}")
    print(f"  Total embeddings: {table_count + column_count}")
    print("=" * 60)

    conn.close()


if __name__ == "__main__":
    main()
