# NL2SQL Evaluation: 2,000-Table Enterprise ERP Database

**Date:** February 13, 2026
**Model:** qwen2.5-coder:7b (4.7 GB, 32K context)
**Result:** 76.0% (228/300) on a 300-question exam

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
PG Normalize ------> Dialect normalization (YEAR() -> EXTRACT, IFNULL -> COALESCE)
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
| **Pass Rate** | **76.0% (228/300)** |
| **Simple** | 95.0% (38/40) |
| **Moderate** | 74.2% (89/120) |
| **Challenging** | 72.1% (101/140) |
| **Avg Latency (pass)** | 9.8s |
| **Avg Latency (fail)** | 16.0s |
| **Total Runtime** | 56.5 minutes |

### Failure Analysis

| Failure Type | Count | % of Total | Description |
|-------------|-------|------------|-------------|
| **Column miss** | 35 | 11.7% | Generated SQL references a column that doesn't exist in the target table |
| **LLM reasoning** | 30 | 10.0% | Model exhausted 3 repair attempts without producing valid SQL |
| **Execution error** | 7 | 2.3% | Internal pipeline errors (sidecar issues) |
| **Join path miss** | 0 | 0.0% | No failures from incorrect join paths |
| **Value miss** | 0 | 0.0% | No hallucinated entity values |

The dominant failure mode is **column miss** — the model generates SQL referencing columns that don't exist on the target table. This is particularly acute with dirty-named tables where the model must infer that `tot_amt` means "total amount" or `sts_cd` means "status code."

### Performance by Domain

| Domain | Pass Rate | N | Notes |
|--------|-----------|---|-------|
| **Retail** | **100%** | 29 | POS, loyalty, promotions — well-isolated domain |
| **Assets** | **100%** | 11 | Depreciation, maintenance — consistent table structure |
| **Support** | **100%** | 10 | Customer service cases — simple query patterns |
| **Inventory** | **91.3%** | 23 | Warehouse, stock, transfers |
| **Temporal** | **86.7%** | 15 | YoY growth, tenure distribution, quarterly comparisons |
| **HR** | **86.5%** | 37 | Employee queries, payroll, benefits |
| **Services** | **85.7%** | 28 | SOW, deliverables, billing milestones |
| **Procurement** | **83.3%** | 30 | PO, vendor invoices, RFQs |
| **Dirty Naming** | **81.5%** | 27 | Abbreviated columns/tables across archetypes |
| **Finance** | **70.4%** | 54 | AP/AR, GL, journal entries — large module, complex queries |
| **Projects** | **64.0%** | 25 | Multi-table project profitability, resource allocation |
| **KPI** | **50.0%** | 16 | Business metric formulas (DSO, working capital, margins) |
| **Multi-Join** | **50.0%** | 12 | 4-7 table join chains (order-to-cash, procure-to-pay) |
| **Sales** | **51.4%** | 37 | Sales orders + geography + pipeline |
| **Lookup** | **41.9%** | 31 | Coded status values requiring lookup_codes join |
| **Manufacturing** | **20.0%** | 20 | Dirty-named BOM/work order tables with coded statuses |

### Key Observations

**What works well:**
- **Simple queries are nearly solved** (95%) — the retrieval and generation pipeline reliably handles single and dual-table queries across all modules.
- **Dirty naming is manageable** (81.5%) — the schema glossing stage successfully bridges most abbreviated column names to their natural language equivalents.
- **No join path failures** — the FK-graph join planner correctly identifies join paths in every case where the required tables are retrieved.
- **Retail and isolated domains excel** (100%) — when the table universe is clearly delineated and naming is consistent, the model performs perfectly.

**What needs improvement:**
- **Lookup/coded values are the hardest challenge** (41.9%) — the model struggles to discover that it needs to join to `lookup_codes` to decode `sts_cd` values. This is a prompt engineering and retrieval problem: the lookup table must be surfaced even when the question doesn't explicitly mention codes.
- **Manufacturing + dirty naming is the worst combination** (20%) — when abbreviated table names (`xx_mfg_wo`) combine with coded status columns (`sts_cd`), the model frequently hallucinates column names that don't exist.
- **Complex KPIs and multi-table joins plateau at ~50%** — formulas like Days Sales Outstanding or order-to-cash cycles require both correct table identification and business logic reasoning, which exceeds the 7B model's reliable capabilities.

### Comparison to 70-Table Baseline

| Metric | 70-Table (60 Q) | 2000-Table (300 Q) | Delta |
|--------|-----------------|---------------------|-------|
| Overall | 88.3% | 76.0% | -12.3% |
| Simple | 100% | 95.0% | -5.0% |
| Moderate | 88.0% | 74.2% | -13.8% |
| Challenging | 73.3% | 72.1% | -1.2% |

The 12-point drop from 70 to 2,000 tables is driven primarily by **retrieval difficulty** (finding the right 15 tables out of 162 unique tables) and **naming complexity** (dirty columns, coded values). Notably, challenging questions show almost no regression (-1.2%), suggesting the pipeline's join planning and multi-candidate generation handle complex queries well regardless of scale.

---

## Methodology Notes

**Reproducibility**: All exam generation uses deterministic seeding (seed=20240213). The same exam CSV can be regenerated from templates. Gold SQL was validated against the live database before the exam run (300/300 execute without error).

**Fair evaluation**: The model sees only the natural language question and retrieved schema context. It does not see gold SQL, expected tables, or any exam-specific hints. The "evidence" field (domain hints like "Join finance_ap_invoices to vendors") is included in the question text as it would be in a real user query with context.

**Failure classification**: "Column miss" (SQLSTATE 42703) means the generated column doesn't exist. "LLM reasoning" means the model exhausted 3 repair attempts. "Execution error" covers internal pipeline failures. Classification is based on the final error after all repair attempts.

**Hardware**: All inference runs on a single NVIDIA GPU (8 GB VRAM) using Ollama with qwen2.5-coder:7b. Sequential candidate generation (`SEQUENTIAL_CANDIDATES=true`) is required to fit within VRAM. No cloud APIs are used.
