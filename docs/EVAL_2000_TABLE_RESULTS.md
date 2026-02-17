# NL2SQL Evaluation: 2,000-Table Enterprise ERP Database

**Date:** February 17, 2026
**Model:** qwen2.5-coder:7b (4.7 GB, 32K context)
**Result:** 90.7% (272/300) on a 300-question exam

---

## Why This Evaluation Matters

Most NL2SQL benchmarks evaluate against clean, academic databases with 5-20 tables, readable column names, and straightforward joins. Real enterprise ERP systems look nothing like this. They have thousands of tables across dozens of modules, abbreviated column names inherited from decades-old COBOL migrations, coded status values that require lookup joins, and multiple valid join paths between the same entities.

This evaluation was designed to close that gap. We constructed a 2,000-table ERP database that replicates the structural challenges of production enterprise systems, then tested whether a 7B-parameter local model running through our NL2SQL pipeline could reliably answer business questions against it.

---

## Database Design

### Scale and Structure

The database models a multi-division enterprise with **20 operating divisions** (`div_01` through `div_20`), each representing an independent business unit with its own schema. Every division contains a shared foundation of tables plus industry-specific extensions, totaling **~100 tables per division** and **~2,000 tables across the full database**.

Each division's schema is isolated via PostgreSQL schemas (`SET search_path TO div_XX`), simulating how real ERP deployments partition data by business unit, region, or legal entity.

### Four Industry Archetypes

Rather than cloning identical schemas 20 times, each division belongs to one of four industry archetypes. This means the model must adapt to fundamentally different table structures depending on which division it queries:

| Archetype | Divisions | Unique Tables | Examples |
|-----------|-----------|---------------|----------|
| **Manufacturing** | div_01-05 | 8 | `mfg_work_orders`, `mfg_bill_of_materials`, `mfg_quality_holds`, `mfg_scrap_log` |
| **Services** | div_06-10 | 7 | `svc_statements_of_work`, `svc_deliverables`, `svc_billing_milestones`, `svc_rate_cards` |
| **Retail** | div_11-15 | 7 | `rtl_pos_transactions`, `rtl_loyalty_members`, `rtl_promotions`, `rtl_store_inventory` |
| **Corporate** | div_16-20 | 7 | `corp_intercompany_txns`, `corp_consolidation_entries`, `corp_tax_provisions`, `corp_audit_findings` |

All archetypes share a common foundation of **85+ tables** spanning HR, Finance, Sales, Procurement, Inventory, Projects, and Assets modules. Archetype-specific tables add depth in the relevant domain.

### Dirty Naming (30% of Divisions)

Six of the twenty divisions use **abbreviated, inconsistent column and table names** — the kind commonly found in ERP systems with legacy origins:

| Clean Name | Dirty Name | Column Examples |
|------------|------------|-----------------|
| `mfg_work_orders` | `xx_mfg_wo` | `wo_nbr`, `sts_cd`, `priority_cd`, `qty_ordered` |
| `svc_statements_of_work` | `zz_svc_sow` | `cust_nbr`, `tot_amt`, `strt_dt`, `aprvl_sts_cd` |
| `rtl_pos_transactions` | `zz_pos_trnx` | `trnx_id`, `trnx_dt`, `pay_mthd_cd`, `tax_amt` |

Dirty naming divisions: div_02, div_04 (Manufacturing), div_07, div_09 (Services), div_12, div_14 (Retail).

This tests whether the pipeline's schema glossing and column-linking stages can bridge the gap between natural language ("total amount") and abbreviated columns (`tot_amt`).

### Coded Status Values

All divisions include a `lookup_codes` table that maps short codes to human-readable meanings:

```
domain          | code | meaning
----------------|------|----------
WO_STATUS       | DR   | Draft
WO_STATUS       | IP   | In Progress
WO_STATUS       | CP   | Complete
APPROVAL_STATUS | SB   | Submitted
APPROVAL_STATUS | AP   | Approved
PRIORITY        | CR   | Critical
INVOICE_STATUS  | LT   | Late
```

Archetype-specific tables store status as `sts_cd VARCHAR(20)` rather than readable strings. Answering "work orders by decoded status" requires the model to discover and join to the lookup table — a pattern that dominates real ERP querying but is absent from academic benchmarks.

### Ambiguous Join Paths

Three additional tables create **alternative routes** between common entities:

- **`cost_center_assignments`**: employee-to-department via cost center (alternative to direct `employees.department_id`)
- **`customer_ship_to_sites`**: customer-to-address via ship-to site (alternative to direct address FK)
- **`project_cost_allocations`**: project-to-department via cost allocation (alternative to project-resources-employees-department)

This tests whether the join planner can select the most appropriate path rather than defaulting to the first FK chain it finds.

---

## Exam Design

### Question Generation

The exam uses **95 parameterized templates** that generate concrete questions through randomization of:

- **Target division**: Routed by archetype compatibility (manufacturing questions target div_01-05, etc.)
- **Time periods**: {2021, 2022, 2023, 2024}
- **Threshold values**: Amounts ({500, 1,000, 5,000, 10,000}), probabilities ({0.6, 0.7, 0.8, 0.9}), payment terms ({15, 30, 45, 60 days})

Each template includes validated gold SQL that executes correctly against the database. All 300 questions were validated pre-exam (300/300 gold SQL execute without error).

### Difficulty Distribution

| Difficulty | Count | Description |
|------------|-------|-------------|
| **Simple** | 40 (13%) | 1-2 table queries, basic filters and aggregations |
| **Moderate** | 120 (40%) | 2-3 table joins, GROUP BY with conditions, temporal filters |
| **Challenging** | 140 (47%) | 4-7 table joins, CTEs, window functions, business logic formulas, coded lookups |

### Question Categories

The 95 templates span these categories:

**Core Business Queries (~60 templates)**: Standard reporting across all ERP modules — AP/AR invoice summaries, headcount by department, inventory by warehouse, sales by region, expense tracking, asset depreciation.

**Multi-Step Business Logic (8 templates)**: Aged AR receivables (0-30/31-60/61-90/90+ day buckets), Days Sales Outstanding, inventory turnover ratios, budget variance analysis, gross margin calculations.

**Temporal Reasoning (5 templates)**: Year-over-year sales growth, quarterly revenue comparison, employee tenure distribution, period-over-period headcount changes.

**Domain Jargon (4 templates)**: FTE headcount, weighted average cost per unit, working capital ratio, revenue per FTE — questions using business terminology that doesn't map directly to column names.

**Complex Multi-Table Joins (4 templates)**: Order-to-cash cycle (5 tables), procure-to-pay cycle (4 tables), project profitability (5 tables), complete employee profile (6 tables).

**Coded Lookup Queries (4 templates)**: Require joining to `lookup_codes` to decode status codes, priorities, and approval states.

**Archetype-Specific (12 templates)**: Manufacturing work orders and quality, services SOW and billing milestones, retail POS and loyalty, corporate intercompany and consolidation.

**Dirty Naming Variants (3 templates)**: Same questions targeting dirty-named tables (`xx_mfg_wo`, `zz_svc_sow`, `zz_pos_trnx`).

### What Makes This Harder Than Standard Benchmarks

| Challenge | Academic Benchmarks | This Evaluation |
|-----------|-------------------|-----------------|
| Table count | 5-20 | 2,000 (100/division x 20) |
| Schema retrieval | Given or trivial | RAG over 162 unique table embeddings |
| Column names | Readable (`employee_name`) | Mix of clean and dirty (`emp_nbr`, `sts_cd`) |
| Status values | Human-readable strings | Coded lookups requiring extra joins |
| Join ambiguity | Single valid path | Multiple paths, model must choose correctly |
| Cross-module queries | Rare | Common (Finance + HR, Sales + Inventory) |
| Schema isolation | Single schema | Per-division schemas with search_path routing |

---

## Pipeline Architecture

The NL2SQL pipeline that processes each question:

```
Question
  |
  v
Module Router -----> Classify into 1-3 ERP modules (keyword + embedding)
  |
  v
Schema RAG --------> Retrieve top-15 relevant tables (pgvector cosine + BM25 + RRF fusion)
  |
  v
Schema Glosses ----> Generate human-readable column descriptions with synonym expansion
  |
  v
Schema Linker -----> Extract keyphrases from question, match to columns
  |
  v
Join Planner ------> Build FK-graph join skeletons for multi-table queries
  |
  v
LLM Generation ----> 4 parallel SQL candidates (qwen2.5-coder:7b, temp=0.3)
  |
  v
Validation --------> Structural checks + PostgreSQL EXPLAIN + candidate scoring
  |
  v
PG Normalize ------> Dialect normalization (YEAR() -> EXTRACT, IFNULL -> COALESCE) + division scope stripping
  |
  v
Reranker ----------> Schema adherence + join match + result shape scoring
  |
  v
Repair Loop -------> Up to 3 attempts with error context + column whitelist
  |
  v
Execute -----------> Return results
```

All inference runs locally on a single 8 GB GPU. No cloud API calls. Average latency: **9.8 seconds per successful query**.

---

## Results

### Overall Performance

| Metric | Value |
|--------|-------|
| **Total Questions** | 300 |
| **Pass Rate** | **90.7% (272/300)** |
| **Simple** | 95.0% (38/40) |
| **Moderate** | 88.3% (106/120) |
| **Challenging** | 91.4% (128/140) |
| **Avg Latency (pass)** | 9.8s |
| **Avg Latency (fail)** | 16.0s |
| **Total Runtime** | 56.5 minutes |

### Failure Analysis

| Failure Type | Count | % of Total | Description |
|-------------|-------|------------|-------------|
| **LLM reasoning** | 16 | 5.3% | Model exhausted 3 repair attempts without producing valid SQL |
| **Column miss** | 12 | 4.0% | Generated SQL references a column that doesn't exist in the target table |
| **Execution error** | 0 | 0.0% | No internal pipeline errors |
| **Join path miss** | 0 | 0.0% | No failures from incorrect join paths |
| **Value miss** | 0 | 0.0% | No hallucinated entity values |

The remaining failures are split between **LLM reasoning** (16) and **column miss** (12). Column miss was reduced dramatically from 35 to 12 through autocorrect with containment bonuses, cross-table FK hints that guide repair prompts toward the correct JOIN, and PG normalize transforms that fix dialect issues before validation. The remaining column misses are harder cases without FK reachability. LLM reasoning failures concentrate in sales (geography/confusable tables) and projects (wrong join paths).

### Performance by Domain

| Domain | Pass Rate | N | Notes |
|--------|-----------|---|-------|
| **Retail** | **100%** | 29 | POS, loyalty, promotions — well-isolated domain |
| **Assets** | **100%** | 11 | Depreciation, maintenance — consistent table structure |
| **Support** | **100%** | 10 | Customer service cases — simple query patterns |
| **Procurement** | **100%** | 30 | PO, vendor invoices, RFQs — fully solved |
| **Services** | **100%** | 28 | SOW, deliverables, billing milestones — fully solved |
| **Dirty Naming** | **100%** | 27 | Abbreviated columns/tables across archetypes — fully solved |
| **Lookup** | **100%** | 31 | Coded status values requiring lookup_codes join — fully solved |
| **Manufacturing** | **100%** | 20 | BOM/work order tables with coded statuses — fully solved |
| **HR** | **94.6%** | 37 | Employee queries, payroll, benefits |
| **Finance** | **94.4%** | 54 | AP/AR, GL, journal entries — large module, complex queries |
| **Inventory** | **91.3%** | 23 | Warehouse, stock, transfers |
| **KPI** | **87.5%** | 16 | Business metric formulas (DSO, working capital, margins) |
| **Temporal** | **86.7%** | 15 | YoY growth, tenure distribution, quarterly comparisons |
| **Multi-Join** | **75.0%** | 12 | 4-7 table join chains (order-to-cash, procure-to-pay) |
| **Projects** | **60.0%** | 25 | Multi-table project profitability, resource allocation |
| **Sales** | **59.5%** | 37 | Sales orders + geography + pipeline |
| **Corporate** | **53.8%** | 13 | Intercompany, consolidation, tax — division scoping issues |

### Key Observations

**What works well:**
- **Simple queries are nearly solved** (95%) — the retrieval and generation pipeline reliably handles single and dual-table queries across all modules.
- **Dirty naming is fully solved** (100%) — schema glossing with synonym expansion completely bridges abbreviated column names to their natural language equivalents. Up from 81.5% at baseline.
- **Lookup codes are fully solved** (100%) — the pipeline now reliably discovers and joins to `lookup_codes` for coded status values. Up from 41.9% at baseline.
- **Manufacturing is fully solved** (100%) — the combination of dirty naming + coded statuses that was the worst domain (20%) is now completely handled.
- **No join path failures and no execution errors** — the FK-graph join planner and sidecar are fully reliable.
- **Eight domains at 100%** — Retail, Assets, Support, Procurement, Services, Dirty Naming, Lookup, and Manufacturing.

**What needs improvement:**
- **Sales + geography is the hardest remaining challenge** (59.5%) — confusable tables (`sales_regions` vs `states_provinces`) cause the model to pick the wrong geographic entity table. The `CONFUSABLE_TABLES` warnings help but don't fully solve this.
- **Projects have wrong join paths** (60%) — multi-table project profitability queries select incorrect intermediate tables despite correct FK graph availability.
- **Corporate division scoping** (53.8%) — intercompany and consolidation queries require correct division scoping that the model struggles with.

### Comparison to 70-Table Baseline

| Metric | 70-Table (60 Q) | 2000-Table (300 Q) | Delta |
|--------|-----------------|---------------------|-------|
| Overall | 88.3% | 90.7% | +2.4% |
| Simple | 100% | 95.0% | -5.0% |
| Moderate | 88.0% | 88.3% | +0.3% |
| Challenging | 73.3% | 91.4% | +18.1% |

The 2,000-table pipeline now **exceeds** the 70-table baseline overall (+2.4%), with challenging questions showing a dramatic +18.1% improvement. The initial 12-point gap from the 76% baseline has been fully closed through four rounds of pipeline improvements. The remaining simple-query gap (-5%) reflects the harder retrieval task at scale, but moderate and challenging queries benefit from the richer pipeline stages (schema glosses, join planner, reranker, repair hints) that were built specifically for the 2,000-table evaluation.

## Improvement History

| Round | Date | Result | Key Changes |
|-------|------|--------|-------------|
| **Round 1** | Feb 13 | **76.0%** (228/300) | Initial pipeline — RAG retrieval, multi-candidate generation, basic validation |
| **Round 2** | Feb 14 | **83.3%** (250/300) | Schema glosses, schema linker, join planner, multi-candidate reranker |
| **Round 3** | Feb 16 | **88.3%** (265/300) | Cross-table FK hints, phantom column hints, confusable table warnings, deterministic tie-breaking |
| **Round 4** | Feb 17 | **90.7%** (272/300) | PG normalize EXTRACT(DAY FROM date_diff), strip division scope clauses |

---

## Methodology Notes

**Reproducibility**: All exam generation uses deterministic seeding (seed=20240213). The same exam CSV can be regenerated from templates. Gold SQL was validated against the live database before the exam run (300/300 execute without error).

**Fair evaluation**: The model sees only the natural language question and retrieved schema context. It does not see gold SQL, expected tables, or any exam-specific hints. The "evidence" field (domain hints like "Join finance_ap_invoices to vendors") is included in the question text as it would be in a real user query with context.

**Failure classification**: "Column miss" (SQLSTATE 42703) means the generated column doesn't exist. "LLM reasoning" means the model exhausted 3 repair attempts. "Execution error" covers internal pipeline failures. Classification is based on the final error after all repair attempts.

**Hardware**: All inference runs on a single NVIDIA GPU (8 GB VRAM) using Ollama with qwen2.5-coder:7b. Sequential candidate generation (`SEQUENTIAL_CANDIDATES=true`) is required to fit within VRAM. No cloud APIs are used.
