#!/usr/bin/env python3
"""
NL2SQL MCP Server Test Suite
Runs directly against the MCP server via Python sidecar, bypassing LibreChat.
Generates a PDF report on completion.
"""

import json
import time
import requests
import psycopg2
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional
import traceback

# Configuration
SIDECAR_URL = "http://localhost:8001"
DB_CONNECTION = "postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp"

@dataclass
class TestResult:
    question: str
    category: str
    expected_tables: list
    sql_generated: Optional[str] = None
    execution_time_ms: float = 0
    row_count: int = 0
    confidence: float = 0
    tables_retrieved: list = field(default_factory=list)
    passed: bool = False
    error: Optional[str] = None
    notes: str = ""

# Test cases organized by category
TEST_CASES = [
    # HR Module
    {"question": "Which employees have pending leave requests?", "category": "HR", "expected_tables": ["employees", "leave_requests"]},
    {"question": "List all departments and their managers", "category": "HR", "expected_tables": ["departments", "employees"]},
    {"question": "Show employee attendance for January 2025", "category": "HR", "expected_tables": ["attendance", "employees"]},
    {"question": "What is the total payroll amount by department?", "category": "HR", "expected_tables": ["payroll", "employees", "departments"]},
    {"question": "Find employees who joined in the last 6 months", "category": "HR", "expected_tables": ["employees"]},
    {"question": "List all job positions and their salary ranges", "category": "HR", "expected_tables": ["job_positions"]},
    {"question": "Show employee skills and certifications", "category": "HR", "expected_tables": ["employee_skills", "employees"]},
    {"question": "What leave types are available?", "category": "HR", "expected_tables": ["leave_types"]},

    # Sales Module
    {"question": "Show total sales by product category for 2025", "category": "Sales", "expected_tables": ["sales_orders", "products", "product_categories"]},
    {"question": "List top 10 customers by order value", "category": "Sales", "expected_tables": ["customers", "sales_orders"]},
    {"question": "What is the average order value by region?", "category": "Sales", "expected_tables": ["sales_orders", "customers"]},
    {"question": "Show all pending sales orders", "category": "Sales", "expected_tables": ["sales_orders"]},
    {"question": "List products with low stock levels", "category": "Sales", "expected_tables": ["products", "inventory_levels"]},
    {"question": "What are the best selling products this quarter?", "category": "Sales", "expected_tables": ["products", "order_lines", "sales_orders"]},
    {"question": "Show customer order history for the last year", "category": "Sales", "expected_tables": ["customers", "sales_orders"]},
    {"question": "List all active price lists", "category": "Sales", "expected_tables": ["price_lists"]},

    # Finance Module
    {"question": "Show all journal entries for this month", "category": "Finance", "expected_tables": ["journal_entries"]},
    {"question": "What is the current balance for each account?", "category": "Finance", "expected_tables": ["accounts"]},
    {"question": "List all unpaid invoices", "category": "Finance", "expected_tables": ["invoices"]},
    {"question": "Show budget vs actual spending by department", "category": "Finance", "expected_tables": ["budgets", "departments"]},
    {"question": "What payments are due this week?", "category": "Finance", "expected_tables": ["payments"]},
    {"question": "List all expense reports pending approval", "category": "Finance", "expected_tables": ["expense_reports"]},
    {"question": "Show tax transactions for Q1 2025", "category": "Finance", "expected_tables": ["tax_transactions"]},
    {"question": "What is the accounts receivable aging?", "category": "Finance", "expected_tables": ["invoices", "customers"]},

    # Procurement Module
    {"question": "List all vendors with outstanding purchase orders", "category": "Procurement", "expected_tables": ["vendors", "purchase_orders"]},
    {"question": "Show purchase orders pending approval", "category": "Procurement", "expected_tables": ["purchase_orders"]},
    {"question": "What items need to be reordered?", "category": "Procurement", "expected_tables": ["products", "inventory_levels"]},
    {"question": "List vendor performance ratings", "category": "Procurement", "expected_tables": ["vendors"]},
    {"question": "Show all RFQs sent this month", "category": "Procurement", "expected_tables": ["rfqs"]},
    {"question": "What is the total spend by vendor?", "category": "Procurement", "expected_tables": ["vendors", "purchase_orders"]},

    # Inventory Module
    {"question": "Show current inventory levels by warehouse", "category": "Inventory", "expected_tables": ["inventory_levels", "warehouses"]},
    {"question": "List all stock movements for today", "category": "Inventory", "expected_tables": ["stock_movements"]},
    {"question": "What products are below minimum stock level?", "category": "Inventory", "expected_tables": ["products", "inventory_levels"]},
    {"question": "Show inventory valuation by category", "category": "Inventory", "expected_tables": ["products", "inventory_levels", "product_categories"]},
    {"question": "List all warehouse locations", "category": "Inventory", "expected_tables": ["warehouses"]},
    {"question": "What is the inventory turnover rate?", "category": "Inventory", "expected_tables": ["products", "stock_movements"]},

    # Projects Module
    {"question": "List all active projects and their status", "category": "Projects", "expected_tables": ["projects"]},
    {"question": "Show tasks assigned to each team member", "category": "Projects", "expected_tables": ["tasks", "task_assignments", "employees"]},
    {"question": "What projects are behind schedule?", "category": "Projects", "expected_tables": ["projects"]},
    {"question": "Show timesheet entries for this week", "category": "Projects", "expected_tables": ["timesheets", "employees"]},
    {"question": "List project milestones due this month", "category": "Projects", "expected_tables": ["milestones", "projects"]},
    {"question": "What is the budget utilization per project?", "category": "Projects", "expected_tables": ["projects"]},

    # Manufacturing Module
    {"question": "Show all active work orders", "category": "Manufacturing", "expected_tables": ["work_orders"]},
    {"question": "List bill of materials for product X", "category": "Manufacturing", "expected_tables": ["bill_of_materials", "products"]},
    {"question": "What is the production output this week?", "category": "Manufacturing", "expected_tables": ["production_runs"]},
    {"question": "Show machine maintenance schedule", "category": "Manufacturing", "expected_tables": ["machines", "maintenance_schedule"]},
    {"question": "List quality control issues this month", "category": "Manufacturing", "expected_tables": ["quality_checks"]},

    # Assets Module
    {"question": "List all fixed assets by category", "category": "Assets", "expected_tables": ["fixed_assets"]},
    {"question": "Show depreciation schedule for this year", "category": "Assets", "expected_tables": ["depreciation_schedules", "fixed_assets"]},
    {"question": "What assets need maintenance?", "category": "Assets", "expected_tables": ["fixed_assets", "asset_maintenance"]},
    {"question": "List assets due for disposal", "category": "Assets", "expected_tables": ["fixed_assets"]},

    # Cross-module queries
    {"question": "Show employees who worked on projects with budget overruns", "category": "Cross-Module", "expected_tables": ["employees", "projects", "task_assignments"]},
    {"question": "List vendors who supply products with low inventory", "category": "Cross-Module", "expected_tables": ["vendors", "products", "inventory_levels"]},
    {"question": "What is the cost of goods sold by product category?", "category": "Cross-Module", "expected_tables": ["products", "product_categories", "order_lines"]},
    {"question": "Show customer invoices with payment status", "category": "Cross-Module", "expected_tables": ["customers", "invoices", "payments"]},
]

def embed_question(question: str) -> list:
    """Get embedding from sidecar"""
    response = requests.post(f"{SIDECAR_URL}/embed", json={"text": question}, timeout=30)
    response.raise_for_status()
    return response.json()["embedding"]

def retrieve_schema_context(conn, embedding: list, top_k: int = 15, threshold: float = 0.25):
    """Query pgvector for similar tables and join with metadata"""
    with conn.cursor() as cur:
        # Get similar tables with metadata from schema_tables
        cur.execute("""
            SELECT DISTINCT ON (e.table_name)
                e.table_schema,
                e.table_name,
                COALESCE(st.module, 'Unknown') as module,
                COALESCE(st.table_gloss, e.embed_text) as gloss,
                e.embed_text as m_schema,
                1 - (e.embedding <=> %s::vector) as similarity,
                COALESCE(st.is_hub, false) as is_hub
            FROM rag.schema_embeddings e
            LEFT JOIN rag.schema_tables st ON e.table_name = st.table_name AND e.table_schema = st.table_schema
            WHERE e.entity_type = 'table'
              AND 1 - (e.embedding <=> %s::vector) > %s
            ORDER BY e.table_name, similarity DESC
        """, (embedding, embedding, threshold))

        # Re-sort by similarity after distinct
        rows = sorted(cur.fetchall(), key=lambda x: x[5], reverse=True)[:top_k]

        tables = []
        for row in rows:
            tables.append({
                "table_schema": row[0],
                "table_name": row[1],
                "module": row[2],
                "gloss": row[3],
                "m_schema": row[4],
                "similarity": float(row[5]),
                "is_hub": row[6],
                "source": "retrieval"
            })

        # Get FK edges for retrieved tables
        if tables:
            table_names = [t["table_name"] for t in tables]
            placeholders = ",".join(["%s"] * len(table_names))
            cur.execute(f"""
                SELECT table_name, column_name, ref_table_name, ref_column_name
                FROM rag.schema_fks
                WHERE table_name IN ({placeholders}) OR ref_table_name IN ({placeholders})
            """, table_names + table_names)

            fk_edges = []
            for row in cur.fetchall():
                fk_edges.append({
                    "from_table": row[0],
                    "from_column": row[1],
                    "to_table": row[2],
                    "to_column": row[3]
                })
        else:
            fk_edges = []

        return tables, fk_edges

def generate_sql(question: str, schema_context: dict, database_id: str = "enterprise_erp") -> dict:
    """Call sidecar to generate SQL"""
    payload = {
        "question": question,
        "database_id": database_id,
        "schema_context": schema_context,
        "max_rows": 100
    }
    response = requests.post(f"{SIDECAR_URL}/generate_sql", json=payload, timeout=60)
    response.raise_for_status()
    return response.json()

def execute_sql(conn, sql: str) -> tuple:
    """Execute SQL and return row count"""
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
            return len(rows), None
    except Exception as e:
        return 0, str(e)

def run_test(conn, test_case: dict) -> TestResult:
    """Run a single test case"""
    result = TestResult(
        question=test_case["question"],
        category=test_case["category"],
        expected_tables=test_case["expected_tables"]
    )

    start_time = time.time()

    try:
        # Step 1: Embed question
        embedding = embed_question(test_case["question"])

        # Step 2: Retrieve schema context
        tables, fk_edges = retrieve_schema_context(conn, embedding)
        result.tables_retrieved = [t["table_name"] for t in tables]

        # Build schema context packet
        schema_context = {
            "query_id": f"test_{int(time.time() * 1000)}",
            "database_id": "enterprise_erp",
            "question": test_case["question"],
            "tables": tables[:10],  # Limit to 10 tables
            "fk_edges": fk_edges,
            "modules": list(set(t["module"] for t in tables[:10]))
        }

        # Step 3: Generate SQL
        sql_result = generate_sql(test_case["question"], schema_context)
        result.sql_generated = sql_result.get("sql_generated", "")
        result.confidence = sql_result.get("confidence_score", 0)

        # Step 4: Execute SQL
        if result.sql_generated:
            # Add LIMIT if missing
            sql = result.sql_generated.strip()
            if "limit" not in sql.lower():
                sql = sql.rstrip(";") + " LIMIT 100;"

            row_count, exec_error = execute_sql(conn, sql)
            result.row_count = row_count
            if exec_error:
                result.error = f"Execution error: {exec_error}"

        # Check if expected tables were retrieved
        retrieved_set = set(result.tables_retrieved)
        expected_set = set(test_case["expected_tables"])
        tables_found = expected_set.intersection(retrieved_set)

        if len(tables_found) >= 1:  # At least one expected table found
            if result.sql_generated and not result.error:
                result.passed = True
                result.notes = f"Found {len(tables_found)}/{len(expected_set)} expected tables"
            elif result.sql_generated and result.error:
                result.notes = f"SQL execution failed: {result.error[:50]}"
            else:
                result.notes = "SQL generation failed"
        else:
            result.notes = f"Retrieved: {', '.join(result.tables_retrieved[:5])}"

    except Exception as e:
        result.error = str(e)
        result.notes = traceback.format_exc()[-200:]

    result.execution_time_ms = (time.time() - start_time) * 1000
    return result

def generate_pdf_report(results: list, output_path: str):
    """Generate PDF report using reportlab"""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
    from reportlab.lib.enums import TA_CENTER

    doc = SimpleDocTemplate(output_path, pagesize=letter, topMargin=0.5*inch, bottomMargin=0.5*inch)
    styles = getSampleStyleSheet()
    elements = []

    # Title
    title_style = ParagraphStyle('Title', parent=styles['Heading1'], alignment=TA_CENTER, fontSize=18)
    elements.append(Paragraph("NL2SQL MCP Server Test Report", title_style))
    elements.append(Paragraph(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                              ParagraphStyle('Subtitle', parent=styles['Normal'], alignment=TA_CENTER)))
    elements.append(Paragraph("Database: enterprise_erp (86 tables)",
                              ParagraphStyle('Subtitle', parent=styles['Normal'], alignment=TA_CENTER)))
    elements.append(Spacer(1, 0.3*inch))

    # Summary statistics
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    failed = total - passed
    avg_time = sum(r.execution_time_ms for r in results) / total if total > 0 else 0
    avg_confidence = sum(r.confidence for r in results) / total if total > 0 else 0

    summary_data = [
        ["Metric", "Value"],
        ["Total Tests", str(total)],
        ["Passed", f"{passed} ({100*passed/total:.1f}%)"],
        ["Failed", f"{failed} ({100*failed/total:.1f}%)"],
        ["Avg Execution Time", f"{avg_time:.0f}ms"],
        ["Avg Confidence", f"{avg_confidence:.2f}"],
    ]

    summary_table = Table(summary_data, colWidths=[2*inch, 2*inch])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2c3e50')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
        ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#ecf0f1')),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#bdc3c7')),
        ('FONTSIZE', (0, 1), (-1, -1), 10),
        ('TOPPADDING', (0, 1), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 0.3*inch))

    # Results by category
    categories = {}
    for r in results:
        if r.category not in categories:
            categories[r.category] = {"passed": 0, "failed": 0, "total": 0, "avg_time": 0}
        categories[r.category]["total"] += 1
        categories[r.category]["avg_time"] += r.execution_time_ms
        if r.passed:
            categories[r.category]["passed"] += 1
        else:
            categories[r.category]["failed"] += 1

    cat_data = [["Category", "Passed", "Failed", "Pass Rate", "Avg Time"]]
    for cat, stats in sorted(categories.items()):
        rate = 100 * stats["passed"] / stats["total"] if stats["total"] > 0 else 0
        avg = stats["avg_time"] / stats["total"] if stats["total"] > 0 else 0
        cat_data.append([cat, str(stats["passed"]), str(stats["failed"]), f"{rate:.0f}%", f"{avg:.0f}ms"])

    cat_table = Table(cat_data, colWidths=[1.8*inch, 0.8*inch, 0.8*inch, 0.9*inch, 0.9*inch])
    cat_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#3498db')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#bdc3c7')),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('TOPPADDING', (0, 1), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 5),
    ]))
    elements.append(Paragraph("Results by Category", styles['Heading2']))
    elements.append(cat_table)
    elements.append(Spacer(1, 0.3*inch))

    # Detailed results
    elements.append(PageBreak())
    elements.append(Paragraph("Detailed Test Results", styles['Heading2']))
    elements.append(Spacer(1, 0.2*inch))

    # Create a smaller style for details
    small_style = ParagraphStyle('Small', parent=styles['Normal'], fontSize=8, leading=10)
    code_style = ParagraphStyle('Code', parent=styles['Code'], fontSize=7, leading=9, wordWrap='CJK')

    for i, r in enumerate(results):
        # Test header
        status_color = colors.HexColor('#27ae60') if r.passed else colors.HexColor('#e74c3c')
        status_text = "PASS" if r.passed else "FAIL"

        header_data = [[
            Paragraph(f"<b>Test {i+1}:</b> {r.question[:70]}{'...' if len(r.question) > 70 else ''}", small_style),
            Paragraph(f"<b>{status_text}</b>", ParagraphStyle('Status', textColor=status_color, fontSize=9))
        ]]
        header_table = Table(header_data, colWidths=[5.5*inch, 1*inch])
        header_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8f9fa')),
            ('ALIGN', (-1, 0), (-1, -1), 'RIGHT'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (0, -1), 6),
            ('RIGHTPADDING', (-1, 0), (-1, -1), 6),
        ]))
        elements.append(header_table)

        # Details
        details = f"<b>Category:</b> {r.category} | <b>Time:</b> {r.execution_time_ms:.0f}ms | <b>Rows:</b> {r.row_count} | <b>Confidence:</b> {r.confidence:.2f}"
        elements.append(Paragraph(details, small_style))

        if r.tables_retrieved:
            tables_text = f"<b>Tables Retrieved:</b> {', '.join(r.tables_retrieved[:6])}{'...' if len(r.tables_retrieved) > 6 else ''}"
            elements.append(Paragraph(tables_text, small_style))

        if r.sql_generated:
            sql_display = r.sql_generated.replace('\n', ' ')[:180] + "..." if len(r.sql_generated) > 180 else r.sql_generated.replace('\n', ' ')
            elements.append(Paragraph(f"<b>SQL:</b> <font face='Courier' size='7'>{sql_display}</font>", small_style))

        if r.error:
            error_display = r.error[:120] + "..." if len(r.error) > 120 else r.error
            elements.append(Paragraph(f"<font color='red'><b>Error:</b> {error_display}</font>", small_style))

        if r.notes and not r.passed:
            elements.append(Paragraph(f"<b>Notes:</b> {r.notes[:80]}", small_style))

        elements.append(Spacer(1, 0.12*inch))

    # Build PDF
    doc.build(elements)
    print(f"PDF report generated: {output_path}")

def main():
    print("=" * 60)
    print("NL2SQL MCP Server Test Suite")
    print("=" * 60)
    print(f"Tests: {len(TEST_CASES)}")
    print(f"Sidecar: {SIDECAR_URL}")
    print(f"Database: enterprise_erp")
    print("=" * 60)

    # Check sidecar health
    try:
        health = requests.get(f"{SIDECAR_URL}/health", timeout=5)
        print(f"Sidecar status: {health.json()['status']}")
    except Exception as e:
        print(f"ERROR: Sidecar not reachable: {e}")
        return

    # Connect to database
    try:
        conn = psycopg2.connect(DB_CONNECTION)
        conn.autocommit = True
        print("Database connection: OK")
    except Exception as e:
        print(f"ERROR: Database connection failed: {e}")
        return

    print("=" * 60)
    print("Running tests...")
    print("-" * 60)

    results = []
    for i, test_case in enumerate(TEST_CASES):
        q_display = test_case['question'][:45] + "..." if len(test_case['question']) > 45 else test_case['question']
        print(f"[{i+1:2}/{len(TEST_CASES)}] {q_display:<48}", end=" ", flush=True)
        result = run_test(conn, test_case)
        results.append(result)
        status = "\033[92mPASS\033[0m" if result.passed else "\033[91mFAIL\033[0m"
        print(f"{status} ({result.execution_time_ms:5.0f}ms)")

    print("-" * 60)

    # Summary
    passed = sum(1 for r in results if r.passed)
    print(f"\nResults: {passed}/{len(results)} passed ({100*passed/len(results):.1f}%)")

    # Generate PDF
    output_path = "/home/noahc/Desktop/nl2sql_test_report.pdf"
    try:
        generate_pdf_report(results, output_path)
    except ImportError:
        print("\nInstalling reportlab for PDF generation...")
        import subprocess
        subprocess.run(["pip", "install", "reportlab"], check=True)
        generate_pdf_report(results, output_path)

    conn.close()
    print("\nDone!")

if __name__ == "__main__":
    main()
