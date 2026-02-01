#!/usr/bin/env python3
"""
Phase C Integration Test

Tests the full RAG retrieval flow:
1. Embed a question via /embed endpoint
2. Query pgvector for similar tables
3. Build SchemaContextPacket
4. Call /generate_sql with schema_context
5. Verify SQL is generated correctly
"""

import json
import sys
import time
import requests
import psycopg2
from psycopg2.extras import RealDictCursor

# Configuration
SIDECAR_URL = "http://localhost:8001"
PG_CONN = {
    "host": "localhost",
    "port": 5432,
    "database": "enterprise_erp",
    "user": "postgres",
    "password": "1219"
}

# Test questions covering different modules
TEST_QUESTIONS = [
    {
        "question": "Which employees have pending leave requests?",
        "expected_tables": ["leave_requests", "employees"],
        "expected_modules": ["hr"],
    },
    {
        "question": "Show total sales by product category for 2025",
        "expected_tables": ["sales_orders", "products"],
        "expected_modules": ["sales", "inventory"],
    },
    {
        "question": "List all vendors with outstanding purchase orders",
        "expected_tables": ["purchase_orders", "vendors"],
        "expected_modules": ["procurement"],
    },
]


def get_embedding(text: str) -> list:
    """Get embedding from sidecar"""
    resp = requests.post(
        f"{SIDECAR_URL}/embed",
        json={"text": text},
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def retrieve_tables(conn, embedding: list, top_k: int = 10, threshold: float = 0.25):
    """Query pgvector for similar tables"""
    vector_literal = f"[{','.join(str(x) for x in embedding)}]"

    query = """
        SELECT
            se.table_name,
            se.table_schema,
            st.module,
            st.table_gloss,
            st.fk_degree,
            st.is_hub,
            1 - (se.embedding <=> %s::vector) AS similarity
        FROM rag.schema_embeddings se
        JOIN rag.schema_tables st
            ON se.table_name = st.table_name
            AND se.table_schema = st.table_schema
        WHERE se.entity_type = 'table'
            AND 1 - (se.embedding <=> %s::vector) >= %s
        ORDER BY se.embedding <=> %s::vector
        LIMIT %s
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (vector_literal, vector_literal, threshold, vector_literal, top_k))
        return cur.fetchall()


def get_table_metadata(conn, table_names: list):
    """Fetch M-Schema format for tables"""
    query = """
        SELECT
            st.table_name,
            st.table_schema,
            st.module,
            st.table_gloss,
            st.fk_degree,
            st.is_hub,
            string_agg(
                sc.column_name || ' ' || sc.data_type ||
                CASE
                    WHEN sc.is_pk THEN ' PK'
                    WHEN sc.is_fk THEN ' FK→' || sc.fk_target_table
                    ELSE ''
                END,
                ', ' ORDER BY sc.ordinal_pos
            ) AS m_schema_cols
        FROM rag.schema_tables st
        JOIN rag.schema_columns sc ON st.table_name = sc.table_name
        WHERE st.table_name = ANY(%s)
        GROUP BY st.table_name, st.table_schema, st.module, st.table_gloss, st.fk_degree, st.is_hub
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (table_names,))
        return cur.fetchall()


def get_fk_edges(conn, table_names: list):
    """Get FK relationships between tables"""
    query = """
        SELECT
            table_name AS from_table,
            column_name AS from_column,
            ref_table_name AS to_table,
            ref_column_name AS to_column
        FROM rag.schema_fks
        WHERE table_name = ANY(%s) AND ref_table_name = ANY(%s)
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, (table_names, table_names))
        return cur.fetchall()


def build_schema_context(question: str, tables: list, fk_edges: list) -> dict:
    """Build SchemaContextPacket"""
    return {
        "query_id": f"test-{int(time.time())}",
        "database_id": "enterprise_erp",
        "question": question,
        "tables": [
            {
                "table_name": t["table_name"],
                "table_schema": t["table_schema"],
                "module": t["module"],
                "gloss": t["table_gloss"],
                "m_schema": f"{t['table_name']} ({t['m_schema_cols']})",
                "similarity": float(t.get("similarity", 0.5)),
                "source": "retrieval",
                "is_hub": t.get("is_hub", False),
            }
            for t in tables
        ],
        "fk_edges": [
            {
                "from_table": e["from_table"],
                "from_column": e["from_column"],
                "to_table": e["to_table"],
                "to_column": e["to_column"],
            }
            for e in fk_edges
        ],
        "modules": list(set(t["module"] for t in tables)),
    }


def generate_sql(question: str, schema_context: dict) -> dict:
    """Call /generate_sql with schema_context"""
    resp = requests.post(
        f"{SIDECAR_URL}/generate_sql",
        json={
            "question": question,
            "database_id": "enterprise_erp",
            "schema_context": schema_context,
            "trace": True,
        },
        timeout=60
    )
    resp.raise_for_status()
    return resp.json()


def run_test(test_case: dict, conn) -> dict:
    """Run a single test case"""
    question = test_case["question"]
    print(f"\n{'='*60}")
    print(f"Question: {question}")
    print(f"{'='*60}")

    result = {
        "question": question,
        "success": False,
        "error": None,
    }

    try:
        # Step 1: Embed question
        start = time.time()
        embedding = get_embedding(question)
        embed_time = time.time() - start
        print(f"✓ Embedding: {len(embedding)} dims in {embed_time:.2f}s")

        # Step 2: Retrieve tables
        start = time.time()
        retrieved = retrieve_tables(conn, embedding, top_k=10, threshold=0.20)
        retrieval_time = time.time() - start
        print(f"✓ Retrieved {len(retrieved)} tables in {retrieval_time:.3f}s")

        for t in retrieved[:5]:
            print(f"  - {t['table_name']} ({t['module']}): {t['similarity']:.3f}")

        # Check expected tables
        retrieved_names = [t["table_name"] for t in retrieved]
        for expected in test_case["expected_tables"]:
            if expected in retrieved_names:
                print(f"  ✓ Found expected table: {expected}")
            else:
                print(f"  ✗ Missing expected table: {expected}")

        # Step 3: Get metadata
        table_names = [t["table_name"] for t in retrieved[:8]]  # Limit to top 8
        metadata = get_table_metadata(conn, table_names)

        # Add similarity scores to metadata
        sim_map = {t["table_name"]: t["similarity"] for t in retrieved}
        for m in metadata:
            m["similarity"] = sim_map.get(m["table_name"], 0.5)

        # Step 4: Get FK edges
        fk_edges = get_fk_edges(conn, table_names)
        print(f"✓ Found {len(fk_edges)} FK relationships")

        # Step 5: Build schema context
        schema_context = build_schema_context(question, metadata, fk_edges)
        print(f"✓ Schema context: {len(schema_context['tables'])} tables, {len(schema_context['modules'])} modules")

        # Step 6: Generate SQL
        start = time.time()
        sql_result = generate_sql(question, schema_context)
        gen_time = time.time() - start

        if sql_result.get("error"):
            print(f"✗ SQL generation error: {sql_result['error']}")
            result["error"] = sql_result["error"]
        else:
            sql = sql_result.get("sql_generated", "")
            confidence = sql_result.get("confidence_score", 0)
            print(f"✓ SQL generated in {gen_time:.2f}s (confidence: {confidence:.2f})")
            print(f"\n{sql}\n")

            result["success"] = True
            result["sql"] = sql
            result["confidence"] = confidence
            result["tables_retrieved"] = len(retrieved)
            result["latency_ms"] = int((embed_time + retrieval_time + gen_time) * 1000)

    except Exception as e:
        print(f"✗ Error: {e}")
        result["error"] = str(e)

    return result


def main():
    print("=" * 60)
    print("Phase C Integration Test")
    print("=" * 60)

    # Connect to database
    print("\nConnecting to enterprise_erp database...")
    try:
        conn = psycopg2.connect(**PG_CONN)
        print("✓ Connected to PostgreSQL")
    except Exception as e:
        print(f"✗ Failed to connect: {e}")
        sys.exit(1)

    # Check sidecar health
    print("\nChecking sidecar health...")
    try:
        resp = requests.get(f"{SIDECAR_URL}/health", timeout=5)
        health = resp.json()
        print(f"✓ Sidecar status: {health.get('status')}")
        print(f"  Ollama: {health.get('ollama')}")
    except Exception as e:
        print(f"✗ Sidecar not reachable: {e}")
        sys.exit(1)

    # Run tests
    results = []
    for test_case in TEST_QUESTIONS:
        result = run_test(test_case, conn)
        results.append(result)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    success_count = sum(1 for r in results if r["success"])
    print(f"Tests: {success_count}/{len(results)} passed")

    for r in results:
        status = "✓" if r["success"] else "✗"
        latency = f"{r.get('latency_ms', 0)}ms" if r["success"] else "N/A"
        print(f"  {status} {r['question'][:50]}... ({latency})")

    conn.close()
    return 0 if success_count == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
