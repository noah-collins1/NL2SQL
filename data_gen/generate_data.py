#!/usr/bin/env python3
"""Generate data for shared dims + deepened tables per division.
Outputs CSV files under data_gen/output/.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from seed import (
    DIVISION_COUNT, BASE_SEED, DIVISION_SIZE,
    ARCHETYPE_FOR_DIVISION, DIRTY_NAMING_DIVISIONS,
)

# ============================================
# Lookup code domains
# ============================================

LOOKUP_CODES = {
    "ORDER_STATUS": [
        ("OP", "Open", 1),
        ("AP", "Approved", 2),
        ("SH", "Shipped", 3),
        ("CL", "Closed", 4),
        ("CN", "Cancelled", 5),
    ],
    "PRIORITY": [
        ("LO", "Low", 1),
        ("MD", "Medium", 2),
        ("HI", "High", 3),
        ("CR", "Critical", 4),
    ],
    "APPROVAL_STATUS": [
        ("SB", "Submitted", 1),
        ("AP", "Approved", 2),
        ("RJ", "Rejected", 3),
        ("RV", "Under Review", 4),
    ],
    "INVOICE_STATUS": [
        ("OP", "Open", 1),
        ("PD", "Paid", 2),
        ("LT", "Late", 3),
        ("VD", "Voided", 4),
    ],
    "WO_STATUS": [
        ("DR", "Draft", 1),
        ("RL", "Released", 2),
        ("IP", "In Progress", 3),
        ("CP", "Completed", 4),
        ("CN", "Cancelled", 5),
    ],
    "QC_RESULT": [
        ("PS", "Pass", 1),
        ("FL", "Fail", 2),
        ("PN", "Pending", 3),
    ],
    "PROJECT_STATUS": [
        ("PL", "Planned", 1),
        ("AC", "Active", 2),
        ("OH", "On Hold", 3),
        ("CP", "Completed", 4),
        ("CN", "Cancelled", 5),
    ],
}


def daterange(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def rand_date(start: date, end: date) -> date:
    delta = (end - start).days
    return start + timedelta(days=random.randint(0, delta))


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def write_csv(path: Path, headers: list[str], rows: list[list]):
    ensure_dir(path.parent)
    with path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)


def generate_shared_dims(out_dir: Path):
    # dim_date
    start = date(2020, 1, 1)
    end = date(2025, 12, 31)
    rows = []
    for d in daterange(start, end):
        rows.append([
            d.isoformat(),
            d.year,
            (d.month - 1) // 3 + 1,
            d.month,
            d.day,
            int(d.strftime("%U")),
            d.weekday() >= 5,
        ])
    write_csv(out_dir / "shared" / "dim_date.csv", [
        "date_key", "year", "quarter", "month", "day", "week_of_year", "is_weekend"
    ], rows)

    # dim_currency
    currency_rows = [
        ["USD", "US Dollar", "$", 840, True],
        ["EUR", "Euro", "€", 978, True],
        ["GBP", "Pound Sterling", "£", 826, True],
        ["JPY", "Yen", "¥", 392, True],
        ["CAD", "Canadian Dollar", "$", 124, True],
    ]
    write_csv(out_dir / "shared" / "dim_currency.csv", [
        "currency_code", "name", "symbol", "iso_numeric", "is_active"
    ], currency_rows)

    # dim_org_unit
    org_rows = []
    for i in range(1, 101):
        org_rows.append([
            str(uuid4()),
            f"OU{i:03d}",
            f"Org Unit {i:03d}",
            None,
            "division" if i <= 20 else "department",
            date(2019, 1, 1).isoformat(),
            None,
            True,
        ])
    write_csv(out_dir / "shared" / "dim_org_unit.csv", [
        "org_unit_id", "org_unit_code", "name", "parent_org_unit_id",
        "org_type", "effective_start", "effective_end", "is_active"
    ], org_rows)

    # dim_location
    loc_rows = []
    for i in range(1, 121):
        loc_rows.append([
            str(uuid4()),
            f"LOC{i:03d}",
            f"Location {i:03d}",
            "US",
            random.choice(["Northeast", "Midwest", "South", "West", "EMEA", "APAC"]),
            random.choice(["New York", "Chicago", "Atlanta", "Dallas", "Seattle", "London", "Tokyo"]),
            f"{100+i} Main St",
            None,
            f"{10000+i}",
        ])
    write_csv(out_dir / "shared" / "dim_location.csv", [
        "location_id", "location_code", "name", "country_code", "region",
        "city", "address_line1", "address_line2", "postal_code"
    ], loc_rows)

    # dim_employee
    emp_rows = []
    for i in range(1, 2001):
        emp_rows.append([
            str(uuid4()),
            f"E{i:06d}",
            f"Employee {i:06d}",
            f"employee{i}@example.com",
            None,
            None,
            date(2020, 1, 1).isoformat(),
            None,
            True,
        ])
    write_csv(out_dir / "shared" / "dim_employee.csv", [
        "employee_dim_id", "employee_number", "full_name", "email",
        "org_unit_id", "location_id", "effective_start", "effective_end", "is_current"
    ], emp_rows)

    # dim_customer/vendor/product
    cust_rows = [[str(uuid4()), f"CUST{i:05d}", f"Customer {i:05d}", "Manufacturing", "NA", True] for i in range(1, 2001)]
    vend_rows = [[str(uuid4()), f"VEND{i:05d}", f"Vendor {i:05d}", "Supplier", (i % 10 == 0)] for i in range(1, 801)]
    prod_rows = [[str(uuid4()), f"SKU{i:06d}", f"Product {i:06d}", "Category A", "EA", True] for i in range(1, 5001)]

    write_csv(out_dir / "shared" / "dim_customer.csv", [
        "customer_dim_id", "customer_code", "name", "industry", "region", "is_active"
    ], cust_rows)
    write_csv(out_dir / "shared" / "dim_vendor.csv", [
        "vendor_dim_id", "vendor_code", "name", "category", "is_preferred"
    ], vend_rows)
    write_csv(out_dir / "shared" / "dim_product.csv", [
        "product_dim_id", "sku", "name", "category", "uom", "is_active"
    ], prod_rows)


# ============================================
# Shared division table data generators
# ============================================

def generate_shared_tables(base: Path, i: int, n_rows, start: date, end: date):
    """Generate data for the shared deepening tables (same across all archetypes)."""

    # hr_onboarding_tasks
    rows = []
    for r in range(1, n_rows(200) + 1):
        rows.append([
            r,
            random.randint(1, 500),
            f"Onboarding Task {r}",
            rand_date(start, end).isoformat(),
            random.choice(["open", "in_progress", "done"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "hr_system",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "hr_onboarding_tasks.csv", [
        "task_id", "employee_id", "task_name", "due_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # payroll_run_hdr
    rows = []
    for r in range(1, n_rows(24) + 1):
        start_date = rand_date(start, end)
        rows.append([
            r,
            start_date.isoformat(),
            (start_date + timedelta(days=14)).isoformat(),
            (start_date + timedelta(days=16)).isoformat(),
            random.choice(["draft", "approved", "posted"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "payroll",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "payroll_run_hdr.csv", [
        "run_id", "pay_period_start", "pay_period_end", "run_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # payroll_run_line
    rows = []
    for r in range(1, n_rows(1200) + 1):
        gross = round(random.uniform(800, 4000), 2)
        tax = round(gross * random.uniform(0.1, 0.25), 2)
        rows.append([
            r, random.randint(1, n_rows(24)), random.randint(1, 500),
            gross, tax, round(gross - tax, 2),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "payroll",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "payroll_run_line.csv", [
        "line_id", "run_id", "employee_id", "gross_pay", "tax_withheld", "net_pay",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # hr_benefit_elections
    rows = []
    for r in range(1, n_rows(300) + 1):
        rows.append([
            r, random.randint(1, 500), random.randint(1, 10),
            random.choice(["employee_only", "employee_spouse", "family"]),
            rand_date(start, end).isoformat(),
            random.choice(["active", "waived", "terminated"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "benefits",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "hr_benefit_elections.csv", [
        "election_id", "employee_id", "benefit_type_id", "coverage_level", "election_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # hr_time_clock_entries
    rows = []
    for r in range(1, n_rows(5000) + 1):
        work_date = rand_date(start, end)
        clock_in = datetime.combine(work_date, datetime.min.time()) + timedelta(hours=8)
        clock_out = clock_in + timedelta(hours=8)
        rows.append([
            r, random.randint(1, 500),
            clock_in.isoformat(), clock_out.isoformat(),
            work_date.isoformat(),
            random.choice(["badge", "mobile", "web"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "timeclock",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "hr_time_clock_entries.csv", [
        "entry_id", "employee_id", "clock_in", "clock_out", "work_date", "source",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # finance_ap_invoices
    rows = []
    for r in range(1, n_rows(400) + 1):
        inv_date = rand_date(start, end)
        rows.append([
            r, random.randint(1, 200), f"AP-{i:02d}-{r:05d}",
            inv_date.isoformat(),
            (inv_date + timedelta(days=30)).isoformat(),
            round(random.uniform(200, 12000), 2),
            random.choice(["open", "approved", "paid"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "ap",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "finance_ap_invoices.csv", [
        "ap_invoice_id", "vendor_id", "invoice_number", "invoice_date", "due_date", "amount", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # finance_ar_invoices
    rows = []
    for r in range(1, n_rows(600) + 1):
        inv_date = rand_date(start, end)
        rows.append([
            r, random.randint(1, 1000), f"AR-{i:02d}-{r:05d}",
            inv_date.isoformat(),
            (inv_date + timedelta(days=30)).isoformat(),
            round(random.uniform(150, 15000), 2),
            random.choice(["open", "paid", "late"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "ar",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "finance_ar_invoices.csv", [
        "ar_invoice_id", "customer_id", "invoice_number", "invoice_date", "due_date", "amount", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # finance_ar_payments
    rows = []
    for r in range(1, n_rows(500) + 1):
        rows.append([
            r, random.randint(1, n_rows(600)),
            rand_date(start, end).isoformat(),
            round(random.uniform(50, 15000), 2),
            random.choice(["ach", "wire", "check"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "ar",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "finance_ar_payments.csv", [
        "payment_id", "ar_invoice_id", "payment_date", "amount", "payment_method",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # procurement_rfqs
    rows = []
    for r in range(1, n_rows(200) + 1):
        rows.append([
            r, random.randint(1, 500),
            rand_date(start, end).isoformat(),
            random.choice(["open", "closed", "awarded"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "procurement",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "procurement_rfqs.csv", [
        "rfq_id", "requested_by", "rfq_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # procurement_rfq_responses
    rows = []
    for r in range(1, n_rows(400) + 1):
        rows.append([
            r, random.randint(1, n_rows(200)), random.randint(1, 200),
            rand_date(start, end).isoformat(),
            round(random.uniform(500, 25000), 2),
            random.choice(["submitted", "accepted", "rejected"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "procurement",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "procurement_rfq_responses.csv", [
        "response_id", "rfq_id", "vendor_id", "response_date", "quoted_amount", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # procurement_po_approvals
    rows = []
    for r in range(1, n_rows(300) + 1):
        rows.append([
            r, random.randint(1, 2000), random.randint(1, 500),
            rand_date(start, end).isoformat(),
            random.choice(["approved", "rejected"]),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "procurement",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "procurement_po_approvals.csv", [
        "approval_id", "po_id", "approved_by", "approval_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # inventory_lots
    rows = []
    for r in range(1, n_rows(500) + 1):
        recv = rand_date(start, end)
        rows.append([
            r, random.randint(1, 2000), random.randint(1, 5),
            f"LOT-{i:02d}-{r:05d}",
            recv.isoformat(),
            (recv + timedelta(days=365)).isoformat(),
            round(random.uniform(1, 200), 2),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "inventory",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "inventory_lots.csv", [
        "lot_id", "product_id", "warehouse_id", "lot_number", "received_date", "expiration_date", "quantity",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # inventory_qc_inspections
    rows = []
    for r in range(1, n_rows(300) + 1):
        rows.append([
            r, random.randint(1, n_rows(500)), random.randint(1, 500),
            rand_date(start, end).isoformat(),
            random.choice(["pass", "fail"]),
            random.randint(0, 5),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "inventory",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "inventory_qc_inspections.csv", [
        "qc_id", "lot_id", "inspector_id", "inspection_date", "result", "defect_count",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # cust_srv_case
    rows = []
    for r in range(1, n_rows(400) + 1):
        opened_at = datetime.utcnow() - timedelta(days=random.randint(0, 1200))
        rows.append([
            r, random.randint(1, 1000), random.randint(1, 500),
            opened_at.isoformat(),
            random.choice(["open", "pending", "closed"]),
            random.choice(["low", "medium", "high"]),
            f"Issue {r}",
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "support",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "cust_srv_case.csv", [
        "case_id", "cust_id", "opened_by", "opened_at", "status", "priority", "subject",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # support_ticket_comments
    rows = []
    for r in range(1, n_rows(800) + 1):
        rows.append([
            r, random.randint(1, n_rows(400)), random.randint(1, 500),
            (datetime.utcnow() - timedelta(days=random.randint(0, 1200))).isoformat(),
            f"Comment {r}",
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "support",
            date(2021, 1, 1).isoformat(), None,
        ])
    write_csv(base / "support_ticket_comments.csv", [
        "comment_id", "case_id", "commenter_id", "comment_ts", "comment_text",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    # Workflow tables
    generate_workflow_tables(base, i, n_rows, start, end)

    # Finance GL tables
    generate_finance_gl_tables(base, i, n_rows, start, end)


def generate_workflow_tables(base: Path, i: int, n_rows, start: date, end: date):
    """Generate wf_approval_request, wf_approval_step, wf_approval_action."""
    rows = []
    request_id = 1
    for entity_type, max_id, count in [
        ("purchase_order", 2000, n_rows(300)),
        ("vendor_invoice", 1000, n_rows(200)),
        ("gl_batch", n_rows(120), n_rows(120)),
    ]:
        for _ in range(count):
            rows.append([
                request_id, entity_type, random.randint(1, max_id),
                random.randint(1, 500),
                random.choice(["submitted", "approved", "rejected"]),
                datetime.utcnow().isoformat(),
                datetime.utcnow().isoformat(),
                random.randint(1, 500),
                None, None, False, "workflow",
                date(2021, 1, 1).isoformat(), None,
            ])
            request_id += 1
    write_csv(base / "wf_approval_request.csv", [
        "request_id", "entity_type", "entity_id", "requested_by", "status", "requested_at",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    rows = []
    step_id = 1
    for req_id in range(1, request_id):
        step_count = random.choice([1, 2, 3])
        for s in range(1, step_count + 1):
            rows.append([
                step_id, req_id, s, random.randint(1, 500),
                random.choice(["pending", "approved", "rejected"]),
                rand_date(start, end).isoformat(),
                datetime.utcnow().isoformat(),
                random.randint(1, 500),
                None, None, False, "workflow",
                date(2021, 1, 1).isoformat(), None,
            ])
            step_id += 1
    write_csv(base / "wf_approval_step.csv", [
        "step_id", "request_id", "step_number", "approver_id", "status", "due_date",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    rows = []
    action_id = 1
    for sid in range(1, step_id):
        if random.random() < 0.7:
            rows.append([
                action_id, sid, random.randint(1, 500),
                random.choice(["approve", "reject", "comment"]),
                datetime.utcnow().isoformat(),
                "auto-generated",
                datetime.utcnow().isoformat(),
                random.randint(1, 500),
                None, None, False, "workflow",
                date(2021, 1, 1).isoformat(), None,
            ])
            action_id += 1
    write_csv(base / "wf_approval_action.csv", [
        "action_id", "step_id", "actor_id", "action", "action_ts", "comments",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)


def generate_finance_gl_tables(base: Path, i: int, n_rows, start: date, end: date):
    """Generate finance_gl_batch, finance_posting_period, finance_period_status."""
    rows = []
    for r in range(1, n_rows(120) + 1):
        bdate = rand_date(start, end)
        rows.append([
            r, f"BATCH-{i:02d}-{r:05d}", bdate.isoformat(),
            random.choice(["open", "posted", "reversed"]),
            random.randint(1, 500), random.randint(1, 500),
            datetime.utcnow().isoformat(),
            random.randint(1, 500),
            None, None, False, "gl",
            date(2021, 1, 1).isoformat(), None, None,
        ])
    write_csv(base / "finance_gl_batch.csv", [
        "batch_id", "batch_number", "batch_date", "status", "created_by", "posted_by",
        "created_at", "created_by_user", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end", "approval_request_id"
    ], rows)

    rows = []
    period_id = 1
    for year in range(2021, 2026):
        for month in range(1, 13):
            start_date = date(year, month, 1)
            end_date = date(year, month, 28) + timedelta(days=4)
            end_date = end_date - timedelta(days=end_date.day)
            rows.append([
                period_id, random.randint(1, 48),
                f"{year}-P{month:02d}",
                start_date.isoformat(), end_date.isoformat(),
                random.choice(["open", "closed"]),
                datetime.utcnow().isoformat(),
                random.randint(1, 500),
                None, None, False, "gl",
                date(2021, 1, 1).isoformat(), None,
            ])
            period_id += 1
    write_csv(base / "finance_posting_period.csv", [
        "posting_period_id", "fiscal_period_id", "period_name", "start_date", "end_date", "status",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted",
        "source_system", "effective_start", "effective_end"
    ], rows)

    rows = []
    status_id = 1
    modules = ["ap", "ar", "gl", "procurement", "inventory"]
    for pp in range(1, period_id):
        for mod in modules:
            rows.append([
                status_id, pp, mod,
                random.choice(["open", "closed"]),
                datetime.utcnow().isoformat(),
                random.randint(1, 500),
            ])
            status_id += 1
    write_csv(base / "finance_period_status.csv", [
        "period_status_id", "posting_period_id", "module", "status", "updated_at", "updated_by"
    ], rows)


# ============================================
# Lookup codes data
# ============================================

def generate_lookup_codes(base: Path):
    """Generate lookup_codes.csv for a division."""
    rows = []
    lookup_id = 1
    for domain, codes in LOOKUP_CODES.items():
        for code, meaning, display_order in codes:
            rows.append([lookup_id, domain, code, meaning, display_order, True])
            lookup_id += 1
    write_csv(base / "lookup_codes.csv", [
        "lookup_id", "domain", "code", "meaning", "display_order", "is_active"
    ], rows)


# ============================================
# Ambiguous join tables data
# ============================================

def generate_ambiguous_joins(base: Path, n_rows, start: date, end: date):
    """Generate data for cost_center_assignments, customer_ship_to_sites, project_cost_allocations."""

    # cost_center_assignments
    rows = []
    for r in range(1, n_rows(300) + 1):
        eff_start = rand_date(start, end)
        rows.append([
            r, random.randint(1, 500), random.randint(1, 20),
            random.randint(1, 20),
            round(random.uniform(50, 100), 2),
            eff_start.isoformat(), None,
            r <= n_rows(300) // 2,  # ~50% are primary
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "cost_center_assignments.csv", [
        "assignment_id", "employee_id", "cost_center_id", "department_id",
        "allocation_pct", "effective_start", "effective_end", "is_primary", "created_at"
    ], rows)

    # customer_ship_to_sites
    rows = []
    for r in range(1, n_rows(200) + 1):
        rows.append([
            r, random.randint(1, 1000),
            f"Site {r}", random.randint(1, 500),
            r % 5 == 0,  # every 5th is default
            True,
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "customer_ship_to_sites.csv", [
        "site_id", "customer_id", "site_name", "address_id",
        "is_default", "is_active", "created_at"
    ], rows)

    # project_cost_allocations
    rows = []
    for r in range(1, n_rows(150) + 1):
        rows.append([
            r, random.randint(1, 100), random.randint(1, 20),
            random.randint(1, 20),
            round(random.uniform(10, 100), 2),
            random.choice([2021, 2022, 2023, 2024, 2025]),
            round(random.uniform(5000, 100000), 2),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "project_cost_allocations.csv", [
        "allocation_id", "project_id", "department_id", "cost_center_id",
        "allocation_pct", "fiscal_year", "amount", "created_at"
    ], rows)


# ============================================
# Manufacturing archetype data
# ============================================

def generate_manufacturing_data(base: Path, i: int, n_rows, start: date, end: date, dirty: bool):
    """Generate manufacturing-specific table data."""
    wo_statuses = ["DR", "RL", "IP", "CP", "CN"]
    priorities = ["LO", "MD", "HI", "CR"]
    approval_statuses = ["SB", "AP", "RJ", "RV"]

    # BOM
    rows = []
    for r in range(1, n_rows(200) + 1):
        rows.append([
            r, random.randint(1, 2000), None, random.randint(1, 2000),
            round(random.uniform(0.5, 10), 4),
            random.choice(["EA", "KG", "LB", "M"]),
            rand_date(start, end).isoformat(), None,
            random.choice(["AC", "OB"]),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_bom.csv", [
            "bom_id", "prod_nbr", "parent_bom_id", "comp_prod_nbr",
            "qty_per", "uom_cd", "eff_strt_dt", "eff_end_dt", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_bill_of_materials.csv", [
            "bom_id", "product_id", "parent_bom_id", "component_product_id",
            "quantity_per", "unit_of_measure", "effective_start_date", "effective_end_date",
            "status_code", "created_at"
        ], rows)

    # BOM revisions
    rows = []
    for r in range(1, n_rows(100) + 1):
        rows.append([
            r, random.randint(1, n_rows(200)),
            f"REV-{r:03d}", rand_date(start, end).isoformat(),
            f"Change {r}",
            random.choice(approval_statuses),
            random.randint(1, 500),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_bom_rev.csv", [
            "rev_id", "bom_id", "rev_nbr", "rev_dt", "chg_desc_txt",
            "aprvl_sts_cd", "approved_by", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_bom_revisions.csv", [
            "revision_id", "bom_id", "revision_number", "revision_date",
            "change_description", "approval_status_code", "approved_by", "created_at"
        ], rows)

    # Work orders
    rows = []
    for r in range(1, n_rows(300) + 1):
        wo_start = rand_date(start, end)
        rows.append([
            r, f"WO-{i:02d}-{r:05d}", random.randint(1, 2000),
            round(random.uniform(10, 500), 2),
            round(random.uniform(0, 400), 2),
            wo_start.isoformat(),
            (wo_start + timedelta(days=random.randint(7, 60))).isoformat(),
            random.choice(wo_statuses),
            random.choice(priorities),
            random.randint(1, 5),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_wo.csv", [
            "wo_id", "wo_nbr", "prod_nbr", "qty_ordered", "qty_completed",
            "strt_dt", "end_dt", "sts_cd", "priority_cd", "wh_id", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_work_orders.csv", [
            "work_order_id", "work_order_number", "product_id", "quantity_ordered",
            "quantity_completed", "start_date", "end_date", "status_code",
            "priority_code", "warehouse_id", "created_at"
        ], rows)

    # WO operations
    rows = []
    for r in range(1, n_rows(600) + 1):
        rows.append([
            r, random.randint(1, n_rows(300)),
            random.randint(1, 10), random.randint(1, 20),
            f"Operation {r}",
            round(random.uniform(0.5, 4), 2),
            round(random.uniform(1, 16), 2),
            random.choice(wo_statuses),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_wo_ops.csv", [
            "op_id", "wo_id", "op_seq", "wc_id", "op_desc_txt",
            "setup_hrs", "run_hrs", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_wo_operations.csv", [
            "operation_id", "work_order_id", "operation_sequence", "work_center_id",
            "operation_description", "setup_hours", "run_hours", "status_code", "created_at"
        ], rows)

    # Work centers
    rows = []
    for r in range(1, 21):
        rows.append([
            r, f"WC-{r:03d}", f"Work Center {r}",
            random.randint(1, 20),
            round(random.uniform(5, 50), 2),
            round(random.uniform(20, 200), 2),
            True,
        ])
    if dirty:
        write_csv(base / "xx_mfg_wc.csv", [
            "wc_id", "wc_cd", "wc_desc_txt", "dept_nbr",
            "cap_per_hr", "cost_per_hr", "is_active"
        ], rows)
    else:
        write_csv(base / "mfg_work_centers.csv", [
            "work_center_id", "work_center_code", "description", "department_id",
            "capacity_per_hour", "cost_per_hour", "is_active"
        ], rows)

    # Quality holds
    rows = []
    for r in range(1, n_rows(80) + 1):
        hold_dt = rand_date(start, end)
        rows.append([
            r, random.randint(1, n_rows(300)),
            f"Quality issue {r}",
            datetime.combine(hold_dt, datetime.min.time()).isoformat(),
            (datetime.combine(hold_dt, datetime.min.time()) + timedelta(days=random.randint(1, 14))).isoformat() if random.random() < 0.6 else None,
            random.randint(1, 500),
            random.choice(["AC", "RL"]),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_qhold.csv", [
            "hold_id", "wo_id", "hold_rsn_txt", "hold_dt", "rlse_dt",
            "held_by", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_quality_holds.csv", [
            "hold_id", "work_order_id", "hold_reason", "hold_date", "release_date",
            "held_by", "status_code", "created_at"
        ], rows)

    # Scrap log
    rows = []
    for r in range(1, n_rows(150) + 1):
        rows.append([
            r, random.randint(1, n_rows(300)), random.randint(1, 2000),
            round(random.uniform(1, 50), 2),
            random.choice(["DM", "OP", "EQ", "MT"]),
            rand_date(start, end).isoformat(),
            random.randint(1, 500),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "xx_mfg_scrap.csv", [
            "scrap_id", "wo_id", "prod_nbr", "scrap_qty",
            "rsn_cd", "scrap_dt", "rpt_by", "created_at"
        ], rows)
    else:
        write_csv(base / "mfg_scrap_log.csv", [
            "scrap_id", "work_order_id", "product_id", "scrap_quantity",
            "reason_code", "scrap_date", "reported_by", "created_at"
        ], rows)

    # Routing master
    rows = []
    for r in range(1, n_rows(100) + 1):
        rows.append([
            r, random.randint(1, 2000),
            f"RT-{r:03d}", f"R{random.randint(1, 5)}",
            rand_date(start, end).isoformat(), None, True,
        ])
    if dirty:
        write_csv(base / "xx_mfg_routing.csv", [
            "routing_id", "prod_nbr", "routing_cd", "rev_nbr",
            "eff_strt_dt", "eff_end_dt", "is_active"
        ], rows)
    else:
        write_csv(base / "mfg_routing_master.csv", [
            "routing_id", "product_id", "routing_code", "revision_number",
            "effective_start_date", "effective_end_date", "is_active"
        ], rows)


# ============================================
# Services archetype data
# ============================================

def generate_services_data(base: Path, i: int, n_rows, start: date, end: date, dirty: bool):
    """Generate services-specific table data."""
    proj_statuses = ["DR", "PL", "AC", "OH", "CP", "CN"]

    # SOW
    rows = []
    for r in range(1, n_rows(100) + 1):
        sow_start = rand_date(start, end)
        rows.append([
            r, random.randint(1, 100), random.randint(1, 1000),
            f"SOW-{i:02d}-{r:04d}", f"Statement of Work {r}",
            round(random.uniform(10000, 500000), 2),
            sow_start.isoformat(),
            (sow_start + timedelta(days=random.randint(30, 365))).isoformat(),
            random.choice(proj_statuses),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_svc_sow.csv", [
            "sow_id", "proj_nbr", "cust_nbr", "sow_nbr", "desc_txt",
            "tot_amt", "strt_dt", "end_dt", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "svc_statements_of_work.csv", [
            "sow_id", "project_id", "customer_id", "sow_number", "description",
            "total_amount", "start_date", "end_date", "status_code", "created_at"
        ], rows)

    # Deliverables
    rows = []
    for r in range(1, n_rows(300) + 1):
        rows.append([
            r, random.randint(1, n_rows(100)),
            random.randint(1, 10), f"Deliverable {r}",
            rand_date(start, end).isoformat(),
            random.choice(proj_statuses),
            random.choice(["SB", "AP", "RJ", None]),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_svc_dlvr.csv", [
            "dlvr_id", "sow_id", "dlvr_nbr", "desc_txt",
            "due_dt", "sts_cd", "aprvl_sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "svc_deliverables.csv", [
            "deliverable_id", "sow_id", "deliverable_number", "description",
            "due_date", "status_code", "approval_status_code", "created_at"
        ], rows)

    # Resource plan
    rows = []
    roles = ["Consultant", "Architect", "Developer", "Analyst", "PM"]
    for r in range(1, n_rows(200) + 1):
        rp_start = rand_date(start, end)
        rows.append([
            r, random.randint(1, n_rows(100)), random.randint(1, 500),
            random.choice(roles),
            round(random.uniform(10, 100), 2),
            rp_start.isoformat(),
            (rp_start + timedelta(days=random.randint(30, 180))).isoformat(),
            round(random.uniform(50, 300), 2),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_svc_rsrc_plan.csv", [
            "plan_id", "sow_id", "emp_nbr", "role_txt",
            "alloc_pct", "strt_dt", "end_dt", "rate_amt", "created_at"
        ], rows)
    else:
        write_csv(base / "svc_resource_plan.csv", [
            "plan_id", "sow_id", "employee_id", "role_name",
            "allocation_percent", "start_date", "end_date", "rate_amount", "created_at"
        ], rows)

    # Billing milestones
    rows = []
    for r in range(1, n_rows(150) + 1):
        rows.append([
            r, random.randint(1, n_rows(100)),
            random.randint(1, 5), f"Milestone {r}",
            round(random.uniform(5000, 100000), 2),
            rand_date(start, end).isoformat(),
            rand_date(start, end).isoformat() if random.random() < 0.4 else None,
            random.choice(proj_statuses),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_svc_bill_ms.csv", [
            "milestone_id", "sow_id", "ms_nbr", "desc_txt",
            "amt", "due_dt", "inv_dt", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "svc_billing_milestones.csv", [
            "milestone_id", "sow_id", "milestone_number", "description",
            "amount", "due_date", "invoice_date", "status_code", "created_at"
        ], rows)

    # Skill matrix
    skills = ["Python", "Java", "SQL", "Cloud Architecture", "Data Analytics",
              "Project Management", "Business Analysis", "Machine Learning"]
    levels = ["BG", "IN", "AD", "EX"]
    rows = []
    for r in range(1, n_rows(250) + 1):
        cert_date = rand_date(start, end)
        rows.append([
            r, random.randint(1, 500),
            random.choice(skills), random.choice(levels),
            cert_date.isoformat(),
            (cert_date + timedelta(days=730)).isoformat() if random.random() < 0.5 else None,
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_svc_skill.csv", [
            "skill_id", "emp_nbr", "skill_nm", "lvl_cd",
            "cert_dt", "exp_dt", "created_at"
        ], rows)
    else:
        write_csv(base / "svc_skill_matrix.csv", [
            "skill_id", "employee_id", "skill_name", "proficiency_level",
            "certification_date", "expiration_date", "created_at"
        ], rows)

    # Engagement log
    log_types = ["NOTE", "RISK", "ISSUE", "STATUS", "CHANGE"]
    rows = []
    for r in range(1, n_rows(400) + 1):
        rows.append([
            r, random.randint(1, n_rows(100)),
            (datetime.utcnow() - timedelta(days=random.randint(0, 800))).isoformat(),
            random.choice(log_types),
            f"Log entry {r}",
            random.randint(1, 500),
        ])
    if dirty:
        write_csv(base / "zz_svc_engage_log.csv", [
            "log_id", "sow_id", "log_dt", "log_type_cd", "desc_txt", "logged_by"
        ], rows)
    else:
        write_csv(base / "svc_engagement_log.csv", [
            "log_id", "sow_id", "log_date", "log_type", "description", "logged_by"
        ], rows)

    # Rate cards
    rows = []
    for r in range(1, 26):
        rows.append([
            r, random.choice(roles), random.choice(levels),
            round(random.uniform(75, 350), 2),
            "USD",
            date(2021, 1, 1).isoformat(), None, True,
        ])
    if dirty:
        write_csv(base / "zz_svc_rate_cd.csv", [
            "rate_id", "role_txt", "lvl_cd", "rate_amt",
            "currency_cd", "eff_strt_dt", "eff_end_dt", "is_active"
        ], rows)
    else:
        write_csv(base / "svc_rate_cards.csv", [
            "rate_id", "role_name", "proficiency_level", "rate_amount",
            "currency_code", "effective_start_date", "effective_end_date", "is_active"
        ], rows)


# ============================================
# Retail archetype data
# ============================================

def generate_retail_data(base: Path, i: int, n_rows, start: date, end: date, dirty: bool):
    """Generate retail-specific table data."""
    pay_methods = ["CASH", "CC", "DC", "GC", "MW"]
    tiers = ["BZ", "SV", "GD", "PT"]

    # POS transactions
    rows = []
    for r in range(1, n_rows(500) + 1):
        total = round(random.uniform(5, 500), 2)
        tax = round(total * 0.08, 2)
        rows.append([
            r, random.randint(1, 50), random.randint(1, 10),
            random.randint(1, 1000), random.randint(1, 500),
            (datetime.combine(rand_date(start, end), datetime.min.time()) +
             timedelta(hours=random.randint(8, 21))).isoformat(),
            total, tax,
            random.choice(pay_methods),
            "CP",
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_pos_trnx.csv", [
            "trnx_id", "store_nbr", "register_nbr", "cust_nbr", "emp_nbr",
            "trnx_dt", "tot_amt", "tax_amt", "pay_mthd_cd", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_pos_transactions.csv", [
            "transaction_id", "store_number", "register_number", "customer_id",
            "employee_id", "transaction_date", "total_amount", "tax_amount",
            "payment_method_code", "status_code", "created_at"
        ], rows)

    # POS line items
    rows = []
    for r in range(1, n_rows(1500) + 1):
        qty = random.randint(1, 5)
        unit_price = round(random.uniform(2, 200), 2)
        disc = round(unit_price * random.uniform(0, 0.3), 2) if random.random() < 0.3 else 0
        line_total = round(qty * unit_price - disc, 2)
        rows.append([
            r, random.randint(1, n_rows(500)), random.randint(1, 2000),
            qty, unit_price, disc, line_total,
            f"PROMO-{random.randint(1, 20):03d}" if random.random() < 0.2 else None,
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_pos_ln.csv", [
            "ln_id", "trnx_id", "prod_nbr", "qty", "unit_prc",
            "disc_amt", "ln_tot", "promo_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_pos_line_items.csv", [
            "line_id", "transaction_id", "product_id", "quantity", "unit_price",
            "discount_amount", "line_total", "promotion_code", "created_at"
        ], rows)

    # Loyalty members
    rows = []
    for r in range(1, n_rows(200) + 1):
        rows.append([
            r, random.randint(1, 1000),
            f"LM-{i:02d}-{r:05d}",
            rand_date(start, end).isoformat(),
            random.choice(tiers),
            random.randint(0, 10000),
            random.choice(["AC", "IN", "SU"]),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_loy_mbr.csv", [
            "mbr_id", "cust_nbr", "mbr_nbr", "enroll_dt",
            "tier_cd", "pts_bal", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_loyalty_members.csv", [
            "member_id", "customer_id", "member_number", "enrollment_date",
            "tier_code", "points_balance", "status_code", "created_at"
        ], rows)

    # Loyalty transactions
    rows = []
    for r in range(1, n_rows(400) + 1):
        rows.append([
            r, random.randint(1, n_rows(200)), random.randint(1, n_rows(500)),
            random.randint(10, 500) if random.random() < 0.7 else 0,
            random.randint(0, 200) if random.random() < 0.2 else 0,
            (datetime.utcnow() - timedelta(days=random.randint(0, 800))).isoformat(),
            random.choice(["EARN", "REDEEM", "ADJUST", "EXPIRE"]),
        ])
    if dirty:
        write_csv(base / "zz_loy_txn.csv", [
            "txn_id", "mbr_id", "trnx_id", "pts_earned",
            "pts_redeemed", "txn_dt", "txn_type_cd"
        ], rows)
    else:
        write_csv(base / "rtl_loyalty_txns.csv", [
            "txn_id", "member_id", "transaction_id", "points_earned",
            "points_redeemed", "txn_date", "txn_type_code"
        ], rows)

    # Promotions
    rows = []
    for r in range(1, n_rows(30) + 1):
        promo_start = rand_date(start, end)
        rows.append([
            r, f"PROMO-{r:03d}", f"Promotion {r}",
            f"Promotion description {r}",
            promo_start.isoformat(),
            (promo_start + timedelta(days=random.randint(7, 90))).isoformat(),
            random.choice(["PCT", "AMT", "BOGO"]),
            round(random.uniform(5, 50), 2),
            random.choice(["AC", "IN", "EX"]),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_rtl_promo.csv", [
            "promo_id", "promo_cd", "promo_nm", "desc_txt",
            "strt_dt", "end_dt", "disc_type_cd", "disc_val", "sts_cd", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_promotions.csv", [
            "promotion_id", "promotion_code", "promotion_name", "description",
            "start_date", "end_date", "discount_type_code", "discount_value",
            "status_code", "created_at"
        ], rows)

    # Promo products
    rows = []
    for r in range(1, n_rows(100) + 1):
        rows.append([
            r, random.randint(1, n_rows(30)), random.randint(1, 2000),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_rtl_promo_prod.csv", [
            "promo_prod_id", "promo_id", "prod_nbr", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_promo_products.csv", [
            "promo_product_id", "promotion_id", "product_id", "created_at"
        ], rows)

    # Store inventory
    rows = []
    for r in range(1, n_rows(300) + 1):
        rows.append([
            r, random.randint(1, 50), random.randint(1, 2000),
            round(random.uniform(0, 500), 2),
            round(random.uniform(0, 50), 2),
            rand_date(start, end).isoformat() if random.random() < 0.7 else None,
            round(random.uniform(10, 100), 2),
            datetime.utcnow().isoformat(),
        ])
    if dirty:
        write_csv(base / "zz_rtl_store_inv.csv", [
            "store_inv_id", "store_nbr", "prod_nbr", "qty_on_hand",
            "qty_reserved", "last_count_dt", "reorder_pt", "created_at"
        ], rows)
    else:
        write_csv(base / "rtl_store_inventory.csv", [
            "store_inv_id", "store_number", "product_id", "quantity_on_hand",
            "quantity_reserved", "last_count_date", "reorder_point", "created_at"
        ], rows)


# ============================================
# Corporate archetype data
# ============================================

def generate_corporate_data(base: Path, i: int, n_rows, start: date, end: date):
    """Generate corporate-specific table data."""
    divisions = [f"div_{d:02d}" for d in range(1, 21)]

    # Intercompany transactions
    rows = []
    for r in range(1, n_rows(200) + 1):
        from_div = random.choice(divisions)
        to_div = random.choice([d for d in divisions if d != from_div])
        rows.append([
            r, from_div, to_div,
            rand_date(start, end).isoformat(),
            round(random.uniform(1000, 500000), 2),
            random.choice(["USD", "EUR", "GBP"]),
            f"IC transfer {r}",
            random.choice(["PD", "AP", "CN"]),
            random.randint(1, 33),
            random.randint(1, 500),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_intercompany_txns.csv", [
        "ic_txn_id", "from_division", "to_division", "transaction_date",
        "amount", "currency_code", "description", "status_code",
        "account_id", "created_by", "created_at"
    ], rows)

    # Consolidation entries
    rows = []
    for r in range(1, n_rows(300) + 1):
        orig_amt = round(random.uniform(10000, 1000000), 2)
        fx_rate = round(random.uniform(0.8, 1.5), 6)
        rows.append([
            r, random.randint(1, 48),
            random.choice(divisions),
            random.randint(1, 33),
            orig_amt,
            round(orig_amt * fx_rate, 2),
            random.choice(["USD", "EUR", "GBP"]),
            fx_rate,
            random.choice(["DR", "RV", "PS"]),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_consolidation_entries.csv", [
        "consolidation_id", "fiscal_period_id", "source_division",
        "account_id", "original_amount", "translated_amount",
        "currency_code", "exchange_rate", "status_code", "created_at"
    ], rows)

    # Elimination entries
    rows = []
    for r in range(1, n_rows(150) + 1):
        rows.append([
            r, random.randint(1, n_rows(300)),
            random.randint(1, 33), random.randint(1, 33),
            round(random.uniform(1000, 200000), 2),
            random.choice(["IC_REVENUE", "IC_PAYABLE", "IC_RECEIVABLE", "IC_EQUITY"]),
            f"Elimination {r}",
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_elimination_entries.csv", [
        "elimination_id", "consolidation_id", "debit_account_id", "credit_account_id",
        "amount", "elimination_type", "description", "created_at"
    ], rows)

    # Statutory reports
    report_types = ["10-K", "10-Q", "8-K", "Annual", "Quarterly", "Tax"]
    jurisdictions = ["US-Federal", "US-CA", "US-NY", "UK", "EU", "JP"]
    rows = []
    for r in range(1, n_rows(50) + 1):
        due = rand_date(start, end)
        rows.append([
            r, f"Report {r}", random.choice(report_types),
            random.randint(1, 48),
            random.choice(jurisdictions),
            due.isoformat(),
            (due - timedelta(days=random.randint(0, 10))).isoformat() if random.random() < 0.7 else None,
            random.choice(["DR", "RV", "FL", "AC"]),
            random.randint(1, 500), random.randint(1, 500),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_statutory_reports.csv", [
        "report_id", "report_name", "report_type", "fiscal_period_id",
        "jurisdiction", "due_date", "filed_date", "status_code",
        "prepared_by", "approved_by", "created_at"
    ], rows)

    # Tax provisions
    tax_types = ["Income", "Sales", "Property", "Payroll", "VAT"]
    rows = []
    for r in range(1, n_rows(100) + 1):
        rows.append([
            r, random.randint(1, 48),
            random.choice(jurisdictions),
            random.choice(tax_types),
            round(random.uniform(10000, 500000), 2),
            round(random.uniform(-50000, 200000), 2),
            round(random.uniform(0.15, 0.35), 4),
            round(random.uniform(0.20, 0.30), 4),
            random.choice(["DR", "RV", "FN"]),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_tax_provisions.csv", [
        "provision_id", "fiscal_period_id", "jurisdiction", "tax_type",
        "current_provision", "deferred_provision", "effective_rate",
        "statutory_rate", "status_code", "created_at"
    ], rows)

    # Audit findings
    audit_types = ["Internal", "External", "SOX", "Compliance"]
    severities = ["Low", "Medium", "High", "Critical"]
    rows = []
    for r in range(1, n_rows(60) + 1):
        rows.append([
            r, random.choice(audit_types),
            rand_date(start, end).isoformat(),
            random.choice(severities),
            random.randint(1, 20),
            f"Finding {r}: description",
            f"Remediation plan for finding {r}" if random.random() < 0.6 else None,
            rand_date(start, end).isoformat(),
            random.choice(["OP", "IP", "CL", "OD"]),
            random.randint(1, 500),
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_audit_findings.csv", [
        "finding_id", "audit_type", "finding_date", "severity",
        "department_id", "description", "remediation_plan", "due_date",
        "status_code", "assigned_to", "created_at"
    ], rows)

    # Compliance checklists
    regulations = ["SOX", "GDPR", "HIPAA", "PCI-DSS", "SOC2", "ISO27001"]
    rows = []
    for r in range(1, n_rows(40) + 1):
        review_dt = rand_date(start, end)
        rows.append([
            r, random.choice(regulations),
            f"Requirement {r}",
            random.randint(1, 20), random.randint(1, 500),
            review_dt.isoformat(),
            (review_dt + timedelta(days=90)).isoformat(),
            random.choice(["PD", "IP", "CP", "OD"]),
            f"REF-{r:04d}" if random.random() < 0.5 else None,
            datetime.utcnow().isoformat(),
        ])
    write_csv(base / "corp_compliance_checklists.csv", [
        "checklist_id", "regulation_name", "requirement",
        "department_id", "responsible_employee_id", "review_date",
        "next_review_date", "status_code", "evidence_reference", "created_at"
    ], rows)


# ============================================
# Main division data generation
# ============================================

def generate_division_data(out_dir: Path, divisions: int):
    start = date(2021, 1, 1)
    end = date(2025, 12, 31)

    for i in range(1, divisions + 1):
        schema = f"div_{i:02d}"
        mult = DIVISION_SIZE.get(schema, 1.0)
        archetype = ARCHETYPE_FOR_DIVISION.get(schema, "manufacturing")
        dirty = schema in DIRTY_NAMING_DIVISIONS
        random.seed(BASE_SEED + i)

        base = out_dir / schema
        ensure_dir(base)

        def n_rows(base_count: int) -> int:
            return max(10, int(base_count * mult))

        # Shared tables (all divisions)
        generate_shared_tables(base, i, n_rows, start, end)

        # Lookup codes (all divisions)
        generate_lookup_codes(base)

        # Ambiguous join tables (all divisions)
        generate_ambiguous_joins(base, n_rows, start, end)

        # Archetype-specific tables
        if archetype == "manufacturing":
            generate_manufacturing_data(base, i, n_rows, start, end, dirty)
        elif archetype == "services":
            generate_services_data(base, i, n_rows, start, end, dirty)
        elif archetype == "retail":
            generate_retail_data(base, i, n_rows, start, end, dirty)
        elif archetype == "corporate":
            generate_corporate_data(base, i, n_rows, start, end)


def write_value_index(out_dir: Path):
    value_index = {
        "departments": ["Sales", "Finance", "Operations", "HR", "IT"],
        "regions": ["North", "South", "West", "East", "EMEA", "APAC"],
        "payment_methods": ["ach", "wire", "check"],
        "ticket_priorities": ["low", "medium", "high"],
        "po_status": ["approved", "rejected", "open"],
        "invoice_status": ["open", "paid", "late"],
        # Coded lookup domains
        "code_domains": list(LOOKUP_CODES.keys()),
        "lookup_codes": {
            domain: {code: meaning for code, meaning, _ in codes}
            for domain, codes in LOOKUP_CODES.items()
        },
        # Archetype mapping
        "archetypes": {
            "manufacturing": ["div_01", "div_02", "div_03", "div_04", "div_05"],
            "services": ["div_06", "div_07", "div_08", "div_09", "div_10"],
            "retail": ["div_11", "div_12", "div_13", "div_14", "div_15"],
            "corporate": ["div_16", "div_17", "div_18", "div_19", "div_20"],
        },
        "dirty_naming_divisions": sorted(DIRTY_NAMING_DIVISIONS),
    }
    (out_dir / "value_index.json").write_text(json.dumps(value_index, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--divisions", type=int, default=DIVISION_COUNT)
    parser.add_argument("--output", type=Path, default=Path("data_gen/output"))
    args = parser.parse_args()

    random.seed(BASE_SEED)
    generate_shared_dims(args.output)
    generate_division_data(args.output, args.divisions)
    write_value_index(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
