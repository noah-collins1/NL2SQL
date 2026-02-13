#!/bin/bash
# Load generated CSV data into database
set -e

DB_NAME="${1:-enterprise_erp_2000}"
DB_HOST="${2:-localhost}"
DB_PORT="${3:-5432}"
DIVISIONS="${ERP_DIVISIONS:-20}"
PARALLEL="${ERP_PARALLEL:-5}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/data_gen/output"

echo "=== Phase 7: Generate CSV data ==="
python3 "$ROOT_DIR/data_gen/generate_data.py" --divisions "$DIVISIONS" --output "$OUT_DIR"

# Shared dims (must run first, single session)
echo "=== Phase 8: Load shared dimensions ==="
psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" <<EOF
\copy dim_date (date_key, year, quarter, month, day, week_of_year, is_weekend) FROM '$OUT_DIR/shared/dim_date.csv' CSV HEADER
\copy dim_currency (currency_code, name, symbol, iso_numeric, is_active) FROM '$OUT_DIR/shared/dim_currency.csv' CSV HEADER
\copy dim_org_unit (org_unit_id, org_unit_code, name, parent_org_unit_id, org_type, effective_start, effective_end, is_active) FROM '$OUT_DIR/shared/dim_org_unit.csv' CSV HEADER
\copy dim_location (location_id, location_code, name, country_code, region, city, address_line1, address_line2, postal_code) FROM '$OUT_DIR/shared/dim_location.csv' CSV HEADER
\copy dim_employee (employee_dim_id, employee_number, full_name, email, org_unit_id, location_id, effective_start, effective_end, is_current) FROM '$OUT_DIR/shared/dim_employee.csv' CSV HEADER
\copy dim_customer (customer_dim_id, customer_code, name, industry, region, is_active) FROM '$OUT_DIR/shared/dim_customer.csv' CSV HEADER
\copy dim_vendor (vendor_dim_id, vendor_code, name, category, is_preferred) FROM '$OUT_DIR/shared/dim_vendor.csv' CSV HEADER
\copy dim_product (product_dim_id, sku, name, category, uom, is_active) FROM '$OUT_DIR/shared/dim_product.csv' CSV HEADER
EOF

# Per-division tables (parallel)
echo "=== Phase 9: Load division data ($PARALLEL parallel) ==="

load_division() {
  local SCHEMA="$1"
  local num="${SCHEMA#div_}"
  num=$((10#$num))

  # Determine archetype
  local ARCHETYPE
  if [ "$num" -le 5 ]; then ARCHETYPE="manufacturing"
  elif [ "$num" -le 10 ]; then ARCHETYPE="services"
  elif [ "$num" -le 15 ]; then ARCHETYPE="retail"
  else ARCHETYPE="corporate"
  fi

  # Determine dirty naming
  local DIRTY=false
  case "$SCHEMA" in
    div_02|div_04|div_07|div_09|div_12|div_14) DIRTY=true ;;
  esac

  # Write a temp SQL file for this division (psql \copy needs file mode, not pipe)
  local TMPFILE
  TMPFILE=$(mktemp /tmp/load_${SCHEMA}_XXXXXX.sql)
  trap "rm -f $TMPFILE" RETURN

  cat > "$TMPFILE" <<EOSQL
SET search_path TO ${SCHEMA};

-- Shared deepening tables
\copy hr_onboarding_tasks (task_id, employee_id, task_name, due_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/hr_onboarding_tasks.csv' CSV HEADER
\copy payroll_run_hdr (run_id, pay_period_start, pay_period_end, run_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/payroll_run_hdr.csv' CSV HEADER
\copy payroll_run_line (line_id, run_id, employee_id, gross_pay, tax_withheld, net_pay, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/payroll_run_line.csv' CSV HEADER
\copy hr_benefit_elections (election_id, employee_id, benefit_type_id, coverage_level, election_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/hr_benefit_elections.csv' CSV HEADER
\copy hr_time_clock_entries (entry_id, employee_id, clock_in, clock_out, work_date, source, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/hr_time_clock_entries.csv' CSV HEADER
\copy finance_ap_invoices (ap_invoice_id, vendor_id, invoice_number, invoice_date, due_date, amount, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/finance_ap_invoices.csv' CSV HEADER
\copy finance_ar_invoices (ar_invoice_id, customer_id, invoice_number, invoice_date, due_date, amount, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/finance_ar_invoices.csv' CSV HEADER
\copy finance_ar_payments (payment_id, ar_invoice_id, payment_date, amount, payment_method, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/finance_ar_payments.csv' CSV HEADER
\copy procurement_rfqs (rfq_id, requested_by, rfq_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/procurement_rfqs.csv' CSV HEADER
\copy procurement_rfq_responses (response_id, rfq_id, vendor_id, response_date, quoted_amount, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/procurement_rfq_responses.csv' CSV HEADER
\copy procurement_po_approvals (approval_id, po_id, approved_by, approval_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/procurement_po_approvals.csv' CSV HEADER
\copy inventory_lots (lot_id, product_id, warehouse_id, lot_number, received_date, expiration_date, quantity, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/inventory_lots.csv' CSV HEADER
\copy inventory_qc_inspections (qc_id, lot_id, inspector_id, inspection_date, result, defect_count, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/inventory_qc_inspections.csv' CSV HEADER
\copy cust_srv_case (case_id, cust_id, opened_by, opened_at, status, priority, subject, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/cust_srv_case.csv' CSV HEADER
\copy support_ticket_comments (comment_id, case_id, commenter_id, comment_ts, comment_text, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/support_ticket_comments.csv' CSV HEADER
\copy wf_approval_request (request_id, entity_type, entity_id, requested_by, status, requested_at, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/wf_approval_request.csv' CSV HEADER
\copy wf_approval_step (step_id, request_id, step_number, approver_id, status, due_date, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/wf_approval_step.csv' CSV HEADER
\copy wf_approval_action (action_id, step_id, actor_id, action, action_ts, comments, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/wf_approval_action.csv' CSV HEADER
\copy finance_gl_batch (batch_id, batch_number, batch_date, status, created_by, posted_by, created_at, created_by_user, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end, approval_request_id) FROM '$OUT_DIR/${SCHEMA}/finance_gl_batch.csv' CSV HEADER
\copy finance_posting_period (posting_period_id, fiscal_period_id, period_name, start_date, end_date, status, created_at, created_by, updated_at, updated_by, is_deleted, source_system, effective_start, effective_end) FROM '$OUT_DIR/${SCHEMA}/finance_posting_period.csv' CSV HEADER
\copy finance_period_status (period_status_id, posting_period_id, module, status, updated_at, updated_by) FROM '$OUT_DIR/${SCHEMA}/finance_period_status.csv' CSV HEADER

-- Lookup codes
\copy lookup_codes (lookup_id, domain, code, meaning, display_order, is_active) FROM '$OUT_DIR/${SCHEMA}/lookup_codes.csv' CSV HEADER

-- Ambiguous join tables
\copy cost_center_assignments (assignment_id, employee_id, cost_center_id, department_id, allocation_pct, effective_start, effective_end, is_primary, created_at) FROM '$OUT_DIR/${SCHEMA}/cost_center_assignments.csv' CSV HEADER
\copy customer_ship_to_sites (site_id, customer_id, site_name, address_id, is_default, is_active, created_at) FROM '$OUT_DIR/${SCHEMA}/customer_ship_to_sites.csv' CSV HEADER
\copy project_cost_allocations (allocation_id, project_id, department_id, cost_center_id, allocation_pct, fiscal_year, amount, created_at) FROM '$OUT_DIR/${SCHEMA}/project_cost_allocations.csv' CSV HEADER
EOSQL

  # Append archetype-specific tables
  if [ "$ARCHETYPE" = "manufacturing" ]; then
    if [ "$DIRTY" = "true" ]; then
      cat >> "$TMPFILE" <<EOSQL
\copy xx_mfg_bom (bom_id, prod_nbr, parent_bom_id, comp_prod_nbr, qty_per, uom_cd, eff_strt_dt, eff_end_dt, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_bom.csv' CSV HEADER
\copy xx_mfg_bom_rev (rev_id, bom_id, rev_nbr, rev_dt, chg_desc_txt, aprvl_sts_cd, approved_by, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_bom_rev.csv' CSV HEADER
\copy xx_mfg_wo (wo_id, wo_nbr, prod_nbr, qty_ordered, qty_completed, strt_dt, end_dt, sts_cd, priority_cd, wh_id, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_wo.csv' CSV HEADER
\copy xx_mfg_wo_ops (op_id, wo_id, op_seq, wc_id, op_desc_txt, setup_hrs, run_hrs, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_wo_ops.csv' CSV HEADER
\copy xx_mfg_wc (wc_id, wc_cd, wc_desc_txt, dept_nbr, cap_per_hr, cost_per_hr, is_active) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_wc.csv' CSV HEADER
\copy xx_mfg_qhold (hold_id, wo_id, hold_rsn_txt, hold_dt, rlse_dt, held_by, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_qhold.csv' CSV HEADER
\copy xx_mfg_scrap (scrap_id, wo_id, prod_nbr, scrap_qty, rsn_cd, scrap_dt, rpt_by, created_at) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_scrap.csv' CSV HEADER
\copy xx_mfg_routing (routing_id, prod_nbr, routing_cd, rev_nbr, eff_strt_dt, eff_end_dt, is_active) FROM '$OUT_DIR/${SCHEMA}/xx_mfg_routing.csv' CSV HEADER
EOSQL
    else
      cat >> "$TMPFILE" <<EOSQL
\copy mfg_bill_of_materials (bom_id, product_id, parent_bom_id, component_product_id, quantity_per, unit_of_measure, effective_start_date, effective_end_date, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_bill_of_materials.csv' CSV HEADER
\copy mfg_bom_revisions (revision_id, bom_id, revision_number, revision_date, change_description, approval_status_code, approved_by, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_bom_revisions.csv' CSV HEADER
\copy mfg_work_orders (work_order_id, work_order_number, product_id, quantity_ordered, quantity_completed, start_date, end_date, status_code, priority_code, warehouse_id, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_work_orders.csv' CSV HEADER
\copy mfg_wo_operations (operation_id, work_order_id, operation_sequence, work_center_id, operation_description, setup_hours, run_hours, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_wo_operations.csv' CSV HEADER
\copy mfg_work_centers (work_center_id, work_center_code, description, department_id, capacity_per_hour, cost_per_hour, is_active) FROM '$OUT_DIR/${SCHEMA}/mfg_work_centers.csv' CSV HEADER
\copy mfg_quality_holds (hold_id, work_order_id, hold_reason, hold_date, release_date, held_by, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_quality_holds.csv' CSV HEADER
\copy mfg_scrap_log (scrap_id, work_order_id, product_id, scrap_quantity, reason_code, scrap_date, reported_by, created_at) FROM '$OUT_DIR/${SCHEMA}/mfg_scrap_log.csv' CSV HEADER
\copy mfg_routing_master (routing_id, product_id, routing_code, revision_number, effective_start_date, effective_end_date, is_active) FROM '$OUT_DIR/${SCHEMA}/mfg_routing_master.csv' CSV HEADER
EOSQL
    fi
  fi

  if [ "$ARCHETYPE" = "services" ]; then
    if [ "$DIRTY" = "true" ]; then
      cat >> "$TMPFILE" <<EOSQL
\copy zz_svc_sow (sow_id, proj_nbr, cust_nbr, sow_nbr, desc_txt, tot_amt, strt_dt, end_dt, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_svc_sow.csv' CSV HEADER
\copy zz_svc_dlvr (dlvr_id, sow_id, dlvr_nbr, desc_txt, due_dt, sts_cd, aprvl_sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_svc_dlvr.csv' CSV HEADER
\copy zz_svc_rsrc_plan (plan_id, sow_id, emp_nbr, role_txt, alloc_pct, strt_dt, end_dt, rate_amt, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_svc_rsrc_plan.csv' CSV HEADER
\copy zz_svc_bill_ms (milestone_id, sow_id, ms_nbr, desc_txt, amt, due_dt, inv_dt, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_svc_bill_ms.csv' CSV HEADER
\copy zz_svc_skill (skill_id, emp_nbr, skill_nm, lvl_cd, cert_dt, exp_dt, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_svc_skill.csv' CSV HEADER
\copy zz_svc_engage_log (log_id, sow_id, log_dt, log_type_cd, desc_txt, logged_by) FROM '$OUT_DIR/${SCHEMA}/zz_svc_engage_log.csv' CSV HEADER
\copy zz_svc_rate_cd (rate_id, role_txt, lvl_cd, rate_amt, currency_cd, eff_strt_dt, eff_end_dt, is_active) FROM '$OUT_DIR/${SCHEMA}/zz_svc_rate_cd.csv' CSV HEADER
EOSQL
    else
      cat >> "$TMPFILE" <<EOSQL
\copy svc_statements_of_work (sow_id, project_id, customer_id, sow_number, description, total_amount, start_date, end_date, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/svc_statements_of_work.csv' CSV HEADER
\copy svc_deliverables (deliverable_id, sow_id, deliverable_number, description, due_date, status_code, approval_status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/svc_deliverables.csv' CSV HEADER
\copy svc_resource_plan (plan_id, sow_id, employee_id, role_name, allocation_percent, start_date, end_date, rate_amount, created_at) FROM '$OUT_DIR/${SCHEMA}/svc_resource_plan.csv' CSV HEADER
\copy svc_billing_milestones (milestone_id, sow_id, milestone_number, description, amount, due_date, invoice_date, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/svc_billing_milestones.csv' CSV HEADER
\copy svc_skill_matrix (skill_id, employee_id, skill_name, proficiency_level, certification_date, expiration_date, created_at) FROM '$OUT_DIR/${SCHEMA}/svc_skill_matrix.csv' CSV HEADER
\copy svc_engagement_log (log_id, sow_id, log_date, log_type, description, logged_by) FROM '$OUT_DIR/${SCHEMA}/svc_engagement_log.csv' CSV HEADER
\copy svc_rate_cards (rate_id, role_name, proficiency_level, rate_amount, currency_code, effective_start_date, effective_end_date, is_active) FROM '$OUT_DIR/${SCHEMA}/svc_rate_cards.csv' CSV HEADER
EOSQL
    fi
  fi

  if [ "$ARCHETYPE" = "retail" ]; then
    if [ "$DIRTY" = "true" ]; then
      cat >> "$TMPFILE" <<EOSQL
\copy zz_pos_trnx (trnx_id, store_nbr, register_nbr, cust_nbr, emp_nbr, trnx_dt, tot_amt, tax_amt, pay_mthd_cd, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_pos_trnx.csv' CSV HEADER
\copy zz_pos_ln (ln_id, trnx_id, prod_nbr, qty, unit_prc, disc_amt, ln_tot, promo_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_pos_ln.csv' CSV HEADER
\copy zz_loy_mbr (mbr_id, cust_nbr, mbr_nbr, enroll_dt, tier_cd, pts_bal, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_loy_mbr.csv' CSV HEADER
\copy zz_loy_txn (txn_id, mbr_id, trnx_id, pts_earned, pts_redeemed, txn_dt, txn_type_cd) FROM '$OUT_DIR/${SCHEMA}/zz_loy_txn.csv' CSV HEADER
\copy zz_rtl_promo (promo_id, promo_cd, promo_nm, desc_txt, strt_dt, end_dt, disc_type_cd, disc_val, sts_cd, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_rtl_promo.csv' CSV HEADER
\copy zz_rtl_promo_prod (promo_prod_id, promo_id, prod_nbr, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_rtl_promo_prod.csv' CSV HEADER
\copy zz_rtl_store_inv (store_inv_id, store_nbr, prod_nbr, qty_on_hand, qty_reserved, last_count_dt, reorder_pt, created_at) FROM '$OUT_DIR/${SCHEMA}/zz_rtl_store_inv.csv' CSV HEADER
EOSQL
    else
      cat >> "$TMPFILE" <<EOSQL
\copy rtl_pos_transactions (transaction_id, store_number, register_number, customer_id, employee_id, transaction_date, total_amount, tax_amount, payment_method_code, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_pos_transactions.csv' CSV HEADER
\copy rtl_pos_line_items (line_id, transaction_id, product_id, quantity, unit_price, discount_amount, line_total, promotion_code, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_pos_line_items.csv' CSV HEADER
\copy rtl_loyalty_members (member_id, customer_id, member_number, enrollment_date, tier_code, points_balance, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_loyalty_members.csv' CSV HEADER
\copy rtl_loyalty_txns (txn_id, member_id, transaction_id, points_earned, points_redeemed, txn_date, txn_type_code) FROM '$OUT_DIR/${SCHEMA}/rtl_loyalty_txns.csv' CSV HEADER
\copy rtl_promotions (promotion_id, promotion_code, promotion_name, description, start_date, end_date, discount_type_code, discount_value, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_promotions.csv' CSV HEADER
\copy rtl_promo_products (promo_product_id, promotion_id, product_id, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_promo_products.csv' CSV HEADER
\copy rtl_store_inventory (store_inv_id, store_number, product_id, quantity_on_hand, quantity_reserved, last_count_date, reorder_point, created_at) FROM '$OUT_DIR/${SCHEMA}/rtl_store_inventory.csv' CSV HEADER
EOSQL
    fi
  fi

  if [ "$ARCHETYPE" = "corporate" ]; then
    cat >> "$TMPFILE" <<EOSQL
\copy corp_intercompany_txns (ic_txn_id, from_division, to_division, transaction_date, amount, currency_code, description, status_code, account_id, created_by, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_intercompany_txns.csv' CSV HEADER
\copy corp_consolidation_entries (consolidation_id, fiscal_period_id, source_division, account_id, original_amount, translated_amount, currency_code, exchange_rate, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_consolidation_entries.csv' CSV HEADER
\copy corp_elimination_entries (elimination_id, consolidation_id, debit_account_id, credit_account_id, amount, elimination_type, description, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_elimination_entries.csv' CSV HEADER
\copy corp_statutory_reports (report_id, report_name, report_type, fiscal_period_id, jurisdiction, due_date, filed_date, status_code, prepared_by, approved_by, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_statutory_reports.csv' CSV HEADER
\copy corp_tax_provisions (provision_id, fiscal_period_id, jurisdiction, tax_type, current_provision, deferred_provision, effective_rate, statutory_rate, status_code, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_tax_provisions.csv' CSV HEADER
\copy corp_audit_findings (finding_id, audit_type, finding_date, severity, department_id, description, remediation_plan, due_date, status_code, assigned_to, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_audit_findings.csv' CSV HEADER
\copy corp_compliance_checklists (checklist_id, regulation_name, requirement, department_id, responsible_employee_id, review_date, next_review_date, status_code, evidence_reference, created_at) FROM '$OUT_DIR/${SCHEMA}/corp_compliance_checklists.csv' CSV HEADER
EOSQL
  fi

  psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -f "$TMPFILE"
  rm -f "$TMPFILE"
}
export -f load_division
export DB_HOST DB_PORT DB_NAME OUT_DIR

running=0
for i in $(seq -f "%02g" 1 "$DIVISIONS"); do
  SCHEMA="div_${i}"
  load_division "$SCHEMA" > /dev/null 2>&1 &
  running=$((running + 1))
  if [ "$running" -ge "$PARALLEL" ]; then
    wait -n
    running=$((running - 1))
  fi
  echo "  Queued deepened data for ${SCHEMA}"
done
wait
echo "  All division data loaded"

# Cross-schema linking updates (run after all data is loaded)
echo "=== Phase 10: Cross-schema linking ==="
for i in $(seq -f "%02g" 1 "$DIVISIONS"); do
  SCHEMA="div_${i}"
  psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" <<EOF > /dev/null 2>&1
SET search_path TO ${SCHEMA};

UPDATE journal_entries
SET batch_id = (entry_id % 100) + 1
WHERE batch_id IS NULL;

UPDATE purchase_orders po
SET approval_request_id = r.request_id
FROM wf_approval_request r
WHERE r.entity_type = 'purchase_order' AND r.entity_id = po.po_id;

UPDATE vendor_invoices vi
SET approval_request_id = r.request_id
FROM wf_approval_request r
WHERE r.entity_type = 'vendor_invoice' AND r.entity_id = vi.invoice_id;

UPDATE finance_gl_batch gb
SET approval_request_id = r.request_id
FROM wf_approval_request r
WHERE r.entity_type = 'gl_batch' AND r.entity_id = gb.batch_id;
EOF
done
echo "  Cross-schema linking complete"
