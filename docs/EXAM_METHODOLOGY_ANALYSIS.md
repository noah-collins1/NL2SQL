# NL2SQL Benchmark Realism Audit

**Date:** February 17, 2026
**Auditor:** Claude (Benchmark Realism Auditor)
**System:** qwen2.5-coder:7b, RAG-based NL2SQL pipeline
**Current Score:** 90.7% (272/300)

---

## 1. Database Realism Audit

### What's Genuinely Good

The schema has real enterprise DNA: self-referencing hierarchies (employees.manager_id, departments.parent_department_id, chart_of_accounts.parent_account_id), polymorphic associations (document_attachments, wf_approval_request with entity_type/entity_id), header/line document patterns (PO/PO lines, SO/order lines), logical FKs without constraints (created_by/updated_by across 30 tables), and audit trail columns present on "newer" tables but absent from "older" ones. These are patterns you'd find in a real Oracle EBS or SAP deployment.

The dirty naming is structurally interesting -- `xx_mfg_wo`, `zz_svc_sow`, `aprvl_sts_cd` -- and forces the schema linker to actually work. The lookup_codes table requiring JOIN-based status decoding is a genuinely hard pattern absent from academic benchmarks.

### The "2,377 Tables" Problem

**The table count is misleading.** The actual schema has ~162 unique table structures. The count reaches 2,377 through:

- 20x division replication (same 123 tables copied into div_01 through div_20)
- 1,915 "xmod" expansion tables that are cookie-cutter identical (100 modules x 19 tables, all with the same structure, just a prefix change)

The RAG retriever only sees ~162 unique embeddings. The xmod tables aren't queried by the exam. The division copies are selected via search_path before retrieval even begins. So the system is functionally operating against a **~162-table schema**, not 2,377. The scale challenge is retrieval discrimination among 162 candidates, not 2,377.

### Missing Enterprise Pathologies

| Missing Pattern | Real-World Prevalence | Impact |
|---|---|---|
| **Views / materialized views** | Hundreds in real ERPs | Zero views in this schema. Real systems have reporting views that are valid query targets and confuse table-vs-view resolution |
| **Composite primary keys** | Ubiquitous in SAP/Oracle EBS | Only 3 composite PKs, all in reporting tables. Real ERP operational tables use composite keys extensively (company_code + document_number + line_item) |
| **SCD Type 2 temporal versioning** | Common in HR/Finance | No effective_date/expiry_date versioning on master data. The deepening tables have effective_start/effective_end but they're unused by the exam |
| **Inconsistent dirty naming** | Universal | The dirty naming uses a fixed abbreviation dictionary applied systematically. Real drift has `status` vs `sts` vs `stat` vs `status_cd` vs `STATUS_FLAG` on the same entity across different tables |
| **Table inheritance / partitioned transactionals** | Growing pattern | Only one partitioned table (event_stream). No table inheritance |
| **Cross-schema references** | Common in multi-tenant ERPs | Zero cross-division FKs. Real systems have shared reference tables with cross-schema joins |
| **Stored procedures as query targets** | Common in reporting | None. Real systems often expose data through function-returning-setof or table-valued functions |
| **Denormalized wide tables** | Very common | Only 3 reporting tables. Real ERPs have 50-100+ column fact tables |

### Schema Detail Summary

| Property | Value |
|---|---|
| Unique table structures | ~162 |
| Self-referencing FKs | 6 (employees, departments, business_units, chart_of_accounts, product_categories, units_of_measure) |
| Polymorphic associations | 5 (document_attachments, wf_approval_request, inventory_transactions, event_stream, xmod_notes) |
| Logical FKs (no constraint) | 30+ tables with created_by/updated_by lacking FK constraints |
| Composite PKs | 3 (all reporting tables) |
| Views | 0 |
| JSONB columns | 3 (all in logging tables) |
| Generated/computed columns | 3 |
| Avg columns per table | ~9.7 (base), ~12 (deepening), ~6 (xmod) |
| Dirty naming divisions | 6/20 (30%) -- systematic abbreviation, not organic drift |

### DB Realism Score: 6.0 / 10

The core 162-table schema is a credible mid-complexity ERP with genuine structural patterns. But the "2,377 tables" framing overstates the challenge -- the actual retrieval universe is 162 tables, which is large but not enterprise-scale. The dirty naming is too systematic, views are completely absent, composite keys barely exist, and the xmod padding adds volume without diversity.

---

## 2. Question Set Realism Audit

### Structural Analysis

The 300 questions come from **92 templates** with parameter substitution (year, division, threshold):

| Metric | Value | Concern Level |
|---|---|---|
| Unique question patterns | 92 | Moderate -- but each pattern is tested across divisions |
| 1-2 table joins | 94.7% (284/300) | **High concern** -- real business queries frequently hit 3-5 tables |
| 3+ table joins | 5.3% (16/300) | Far below real-world distribution |
| Subqueries/CTEs | 6.3% (19/300) | Low -- BIRD has ~15-20% |
| GROUP BY + HAVING | 2.7% (8/300) | Very low -- Spider "extra hard" has 10%+ |
| Window functions | 2.0% (6/300) | Very low |
| CASE/conditional aggregation | 5.3% (16/300) | Moderate |
| Cross-domain joins | ~5% | Low -- most queries stay within one module |
| Temporal reasoning | 60.3% (181/300) | High -- but mostly simple EXTRACT(YEAR FROM ...) filters |
| Value grounding | 0% | **Critical gap** -- BIRD's signature difficulty is entirely absent |
| Set operations (UNION/EXCEPT) | 0% | Missing SQL pattern |
| Correlated subqueries | 0% | Missing SQL pattern |
| Negation/anti-join patterns | 0% | Missing SQL pattern |

### Difficulty Distribution

| Difficulty | Count | % | Avg Tables in Gold SQL |
|---|---|---|---|
| Simple | 40 | 13.3% | ~1.2 |
| Moderate | 120 | 40.0% | ~1.8 |
| Challenging | 140 | 46.7% | ~2.1 |

The exam is weighted toward harder questions (47% challenging), but the "challenging" label is based on question complexity, not SQL complexity. Most "challenging" questions still only require 2 table joins.

### Comparison to Academic Benchmarks

**vs. Spider:** Spider's "extra hard" category requires nested queries, set operations (UNION/INTERSECT/EXCEPT), and correlated subqueries. This exam has zero set operations, zero correlated subqueries, and very few nested queries. Spider's hardness distribution targets compositional SQL complexity; this exam targets schema discovery complexity. They test different things.

**vs. BIRD:** BIRD emphasizes value grounding (dirty string matching, implicit joins through business rules, ambiguous entity references). This exam has zero value-grounding questions. No question requires the model to know that "California" maps to state_code "CA", or that "Q1" means months 1-3. The evidence/hints field in the CSV often gives away the join path explicitly ("Join finance_ap_invoices to vendors"). BIRD never provides such hints.

### The Template Reuse Problem

**The 28 failures come from only 11 unique templates.** Six failures are literally the same question ("Sales order count by sales region for {year}") with different year parameters. If you deduplicate by template, the failure rate is 11/92 = 12.0%, and fixing the `sales_by_region` template alone would drop it to 5/92 = 5.4%.

This means the benchmark measures **template coverage**, not **question diversity**. A single mechanical fix (like the division scope stripping) can flip 5 identical-pattern questions at once. This inflates the apparent improvement rate.

### The Shallow Join Ceiling

| Metric | Passing Questions | Failing Questions |
|---|---|---|
| Average tables in gold SQL | 1.85 | 3.36 |
| Average JOINs in SQL | 0.84 | 2.32 |
| 3+ table joins | ~3% | **64.3%** |

The exam is easy in the zone where most questions live (1-2 tables) and hard in the zone that's barely tested (3+ tables). A harder exam would weight heavily toward 3-5 table joins, which is where real business reporting lives.

### 100%-Failure Templates

| Template | Instances | Tables Required | Root Cause |
|---|---|---|---|
| `sales_by_region` | 6/6 fail | 5 (deep geographic chain) | Confusable table -- LLM uses sales_regions instead of address chain |
| `budget_vs_actual` | 3/3 fail | 4 (cross-domain) | Wrong table selection (project_budgets vs budgets) |
| `project_profitability_full` | 3/3 fail | 5 (most complex) | Wrong join path through timesheets |
| `sales_order_discount` | 3/3 fail | 2 | Cross-table column (order_date on sales_orders, not order_lines) |
| `open_opportunities` | 2/2 fail | 1 | Phantom columns (status/is_won don't exist) |
| `project_resource_alloc` | 2/2 fail | 2 | Phantom column (created_at doesn't exist) |
| `inventory_turnover_ratio` | 2/2 fail | 4 | Complex multi-join ratio calculation |
| `yoy_sales_growth` | 2/2 fail | 2 | CTE-based YoY with wrong column (line_total vs quantity * unit_price) |
| `sales_top_customers` | 2/2 fail | 3 | Multi-table aggregation validation failure |

### Question Realism Score: 5.0 / 10

The questions are well-parameterized across divisions and test schema retrieval effectively. But the SQL complexity is substantially below both Spider "extra hard" and BIRD difficulty levels. The join depth is shallow, subqueries are rare, value grounding is absent, and template reuse inflates the question count without adding diversity. 92 unique patterns is reasonable for an initial exam but insufficient for claiming robustness.

---

## 3. Failure Distribution Audit

### Current Failure Profile

| Category | Count | % | Assessment |
|---|---|---|---|
| llm_reasoning | 16 | 5.3% | Reasonable -- irreducible error floor for 7B model |
| column_miss | 12 | 4.0% | Low for 162 tables -- reflects autocorrect effectiveness, not LLM accuracy |
| execution_error | 0 | 0.0% | **Suspiciously clean** -- no timeouts, locks, or resource issues |
| join_path_miss | 0 | 0.0% | **Misleadingly clean** -- 95% of questions need 1-2 tables |
| value_miss | 0 | 0.0% | No value grounding questions exist |

### Assessment

| Observation | Assessment |
|---|---|
| 0 execution errors | Real enterprise environments have connection timeouts, lock contention, permission issues, and resource limits. The exam runs against a clean dev database with no concurrent load. |
| 12 column_miss (4.0%) | This was 35 (11.7%) before the autocorrect/hint fixes. The current 12 reflects the system's mechanical repair capability, not the LLM's inherent accuracy. Without autocorrect, column hallucination would be ~12-15%. |
| 16 llm_reasoning (5.3%) | These are cases where the model picks the wrong approach entirely (wrong table, wrong join strategy, wrong aggregation). This is the irreducible error floor for a 7B model. |
| 0 join_path_miss | The join planner never fails because 95% of questions need 1-2 tables. With more 4-5 table join questions, this category would light up. |

### Is 90.7% Too High?

**Partially yes.** The combination of:

- 95% of questions needing only 1-2 table joins
- Evidence hints often revealing the join path
- Template reuse meaning fixes cascade across multiple questions
- Mechanical PG normalize catching dialect errors deterministically
- No value grounding challenges
- No ambiguous entity references

...means 90.7% on this exam does not predict 90.7% on arbitrary enterprise NL2SQL queries.

**Estimated performance on harder benchmarks:**

| Scenario | Estimated Accuracy |
|---|---|
| Same schema, BIRD-level questions (value grounding, cross-domain) | 70-75% |
| Production schema (views, inconsistent naming, composite keys) | 60-65% |
| Adversarial enterprise queries (correlated subqueries, negation, 5+ table joins) | 50-55% |

---

## 4. Stress Test Recommendations

### Schema Mutations

| Mutation | Subsystem Stressed | Expected Impact |
|---|---|---|
| **Add 50+ views** mixing tables from 2-3 modules (e.g., `v_employee_compensation` joining employees + payroll + benefits) | RAG retriever (view vs table disambiguation), schema linker (view columns map to underlying tables) | 5-10% regression |
| **Add inconsistent dirty naming** -- same concept abbreviated differently across modules (`status` in HR, `sts_cd` in Finance, `stat_flag` in Sales, `STATUS` in Inventory) | Schema linker, autocorrect fuzzy matching, gloss/synonym system | 3-5% regression |
| **Add composite PKs** to 20-30 operational tables (e.g., `(company_code, document_number, line_item)` instead of SERIAL) | Join planner (multi-column joins), LLM SQL generation | 3-5% regression |
| **Add SCD Type 2 versioning** to employee/vendor/customer master data with effective_date ranges | LLM reasoning (temporal filtering on master data), PG normalize | New failure category |
| **Add 200+ similar column names** across modules -- `amount`, `total_amount`, `net_amount`, `gross_amount`, `line_amount`, `ext_amount` on different tables | Autocorrect (ambiguous candidates), schema linker (multiple high-confidence matches), dominance gating | 3-5% regression |

### Question Mutations

| Mutation | Subsystem Stressed | Expected Impact |
|---|---|---|
| **Value grounding**: "Sales in California" (CA = state code), "Orders from last quarter" (date math from CURRENT_DATE) | LLM reasoning, value verification | 15-20% regression on these questions |
| **Cross-domain joins**: "Employees in procurement who approved POs for vendors with overdue invoices" (HR + Procurement + Finance, 5+ tables) | Join planner, RAG retrieval (must pull from 3 modules), LLM reasoning | Drop to 75-80% if 30% of questions are cross-domain |
| **Ambiguous entity references**: "Show me the top accounts" -- could mean chart_of_accounts, customer accounts, bank_accounts, or user accounts | Schema linker, module router | Would expose over-reliance on keyword routing |
| **Negation/anti-join**: "Customers who have never placed an order" (LEFT JOIN + IS NULL or NOT EXISTS) | LLM reasoning | 7B models struggle with negation; expect high failure rate |
| **Set operations**: "Products sold in 2023 but not in 2024" (EXCEPT or NOT IN subquery) | LLM reasoning | Zero UNION/INTERSECT/EXCEPT in current exam |
| **Correlated subqueries**: "Employees earning above their department average" | LLM reasoning, SQL generation | Spider "extra hard" staple; 7B models rarely generate correctly |
| **Hidden join paths**: Questions where the obvious FK path is wrong and an indirect bridge table path is needed | Join planner, schema linker | The `sales_by_region` template (100% failure) is already an example |

### Priority Escalation Plan

**Phase 1 -- Schema diversity (low risk):** Add views, inconsistent naming, and similar column names. Stresses retrieval and linking without changing question complexity. Expected cost: 5-8% regression.

**Phase 2 -- SQL complexity (medium risk):** Add cross-domain multi-hop joins, negation patterns, and set operations to the exam. Target 30% of questions at 3-5 table depth. Expected cost: 10-15% regression.

**Phase 3 -- Value grounding (high risk):** Add questions requiring implicit knowledge (state codes, date ranges, status value meanings without explicit evidence hints). This is where BIRD-level difficulty lives. Expected cost: 15-20% regression.

---

## 5. Final Judgment

| Dimension | Score | Rationale |
|---|---|---|
| **DB Realism** | **6.0 / 10** | Credible core schema with genuine ERP patterns, but the "2,377 tables" is inflated by cookie-cutter replication. Effective retrieval universe is ~162 tables. Missing views, composite keys, and truly inconsistent naming. |
| **Question Realism** | **5.0 / 10** | Good parameterization across divisions, but 95% of questions need only 1-2 table joins. No value grounding, no set operations, no correlated subqueries. Evidence hints reduce difficulty. 92 unique patterns is thin. |
| **Enterprise Representativeness** | **5.5 / 10** | The schema looks like a real ERP from a distance but lacks the accumulated cruft, inconsistency, and view/procedure layers of a production system. The questions resemble a junior analyst's query workload, not a reporting team's. |

### Does 90.7% Hold in Production?

**No.** The 90.7% reflects strong engineering on a constrained benchmark -- mechanical fixes (PG normalize, autocorrect, FK hints) that exploit the exam's structural regularity. In a real enterprise environment, expect:

| Scenario | Estimated Accuracy |
|---|---|
| Same schema, BIRD-level questions | 70-75% |
| Production schema with views, inconsistent naming, composite keys | 60-65% |
| Adversarial enterprise queries (correlated subqueries, negation, 5+ table joins) | 50-55% |

### What the System Does Well

The system's genuine strengths are real:

- **Mechanical repair loop** -- PG normalize, autocorrect, FK hints, and phantom column detection are well-engineered and effective
- **Multi-candidate scoring** -- Deterministic scoring with tie-breaking and reranking improves selection quality
- **Schema retrieval** -- Module routing + cosine + BM25 + RRF handles the 162-table retrieval task effectively
- **Progressive improvement methodology** -- The 76% to 90.7% progression demonstrates systematic, measurable engineering

### What the Benchmark Doesn't Test

- Value grounding (BIRD's core difficulty)
- Compositional SQL complexity (Spider's core difficulty)
- Schema ambiguity (views, similar column names, inconsistent naming)
- Production environment conditions (timeouts, concurrency, permissions)
- Deep multi-hop joins (3-5+ tables)
- Negation, set operations, correlated subqueries

### The Honest Summary

The 76% to 90.7% progression demonstrates genuine engineering impact on a well-constructed but favorably-scoped benchmark. The system handles the *mechanical* challenges of enterprise SQL well. But the benchmark measures the system in favorable conditions. The 59.5% on sales and 60% on projects -- where real complexity exists -- are more predictive of production performance than the headline 90.7%.

To claim production readiness, the exam needs deeper joins, value grounding, cross-domain ambiguity, and the schema needs views, inconsistent naming, and composite keys.
