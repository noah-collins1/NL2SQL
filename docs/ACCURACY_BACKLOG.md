# Accuracy Improvement Backlog

Items not implemented in the current sprint due to effort/complexity. Documented here for future planning.

---

## #6 — Ambiguity Abstention (~30 V2 failures)

**Status:** Not implemented
**Estimated effort:** 2-3 days
**Expected gain:** ~30 V2 questions (all ambiguous, currently produce SQL instead of refusing)

### Problem

The system has no abstention mechanism. 30 of 35 ambiguous V2 questions produce SQL output instead of a `CANNOT_GENERATE` response. The exam grades ambiguous questions on a binary: abstain correctly = pass, generate SQL = fail (regardless of SQL correctness).

### Root Cause

All 30 failures map to 4 template families:
- `a1` — single-column ambiguity (which "status" field?)
- `a2` — date range ambiguity (fiscal year vs calendar year)
- `a3` — multi-table ambiguity (which table has the concept?)
- `a4` — aggregation ambiguity (count distinct vs count all)

The model has no instruction to output `CANNOT_GENERATE` when the question is under-specified.

### Fix Options

1. **Pre-generation classifier** (recommended): Train or prompt a lightweight binary classifier on the question text. If classified as ambiguous → return `CANNOT_GENERATE` without calling Ollama. Can be implemented as a few-shot prompt to the same LLM (cheaper) or a fine-tuned BERT/sentence-transformer model (faster, more accurate).

2. **Few-shot examples in system prompt**: Inject 2-3 examples of ambiguous questions with `CANNOT_GENERATE` output into the generation prompt. Simple to implement but may cause false abstentions on real questions.

3. **Post-generation validator**: After generating SQL, check if it references ambiguous schema elements (columns from multiple candidate tables) and flag for abstention. Requires careful threshold tuning.

### Implementation Notes

- `CANNOT_GENERATE` must propagate through the sidecar response to the TypeScript layer and be recognized as a special non-SQL response
- The exam runner needs to check for `CANNOT_GENERATE` and score it correctly
- Consider fine-tuning on labeled abstention examples if option 1 is pursued

---

## #7 — UNION / Multi-Module Timeout (~7-11 failures)

**Status:** Not implemented
**Estimated effort:** 1 day
**Expected gain:** ~7-11 V2 questions

### Problem

UNION 3-way queries across modules always timeout at 30 seconds. Affected templates:
- `v2_union_all_documents` (4 questions) — UNION across invoices, POs, receipts
- `v2_union_all_financial_txns` (3 questions) — UNION across GL, AR, AP transactions

### Root Cause

Multi-candidate generation (4 candidates × 3 repair attempts) × verbose cross-module schema context exhausts the 30s budget. Each candidate takes ~5-7s; 4 parallel + 3 sequential repairs = 25-35s total.

### Fix Options (in priority order)

**Option A — Skip multi-candidate for UNION templates** (cheapest, try first):
Detect UNION-heavy template signatures in the question text (keywords: "all documents", "all transactions", "combine", "across all types"). If matched, set `multi_candidate_k=1` to preserve time budget for repairs. Implementation: add a keyword check in `nl_query_tool.ts` before calling the sidecar.

**Option B — Increase timeout for UNION queries** (simple):
Detect UNION pattern in generated SQL and increase repair timeout to 45s. Risk: blocks the worker for 45s per question.

**Option C — Pre-scaffold UNION structure via join planner** (complex):
Extend the join planner to detect multi-module UNION patterns and inject a partial SQL skeleton. Most effective but requires significant join planner changes.

### Implementation Notes

- Option A detection keyword list: `["all documents", "all transactions", "all financial", "combine", "across all", "union"]`
- In `nl_query_tool.ts`, check question before `multiCandidateK` is passed to sidecar request body
- Fallback: if question matches UNION keywords, pass `multi_candidate_k: 1` in the sidecar request

---

## #8 — EXCEPT / Working Capital Pattern Coaching (~11 failures)

**Status:** Not implemented
**Estimated effort:** 1-2 days
**Expected gain:** ~11 V2 questions

### Problem

SQL patterns involving EXCEPT and dual-scalar-subquery (working capital) are almost never generated correctly. Affected templates:
- `v2_except_products_not_in_year` (4 questions)
- `v2_except_vendors_lost` (4 questions)
- `v2_cte_working_capital` (3 questions)

Success rate: EXCEPT ~10%, working capital CTEs ~0%.

### Root Cause

The 7B model never recovers across 3 repair attempts — it regenerates the same wrong approach each time:
- For EXCEPT: model generates `NOT IN (subquery)` or `LEFT JOIN ... WHERE IS NULL` instead of `EXCEPT`
- For working capital: model generates inline ratio instead of dual scalar subquery pattern

### Fix Options

**Option A — Few-shot pattern injection** (recommended):
Detect template type from question keywords and inject 1-2 concrete SQL examples into the prompt. Example: if question contains "not in [year]" or "lost" with a vendor context, inject an EXCEPT skeleton.

Implementation: Add a `PATTERN_EXAMPLES` map in `schema_grounding.ts` (similar to `CONFUSABLE_TABLES`) that maps trigger keywords → SQL pattern template. Inject into the schema contract prompt as a `### SQL Pattern Example` section.

**Option B — Template detection system**:
Build a question → template classifier that detects which V2 template family a question belongs to and retrieves the corresponding gold SQL pattern. More accurate but requires labeled training data.

**Option C — Separate repair prompt for EXCEPT**:
When repair is triggered and the previous SQL uses NOT IN / LEFT JOIN for what looks like an exclusion query, override the repair delta with an EXCEPT-specific prompt. Requires detecting the "exclusion" intent from the question.

### Implementation Notes

- Trigger keywords for EXCEPT: `["not purchased", "no orders", "not in", "never bought", "lost vendor", "stopped ordering"]`
- EXCEPT SQL pattern template:
  ```sql
  SELECT col FROM table_a
  EXCEPT
  SELECT col FROM table_b WHERE condition;
  ```
- Trigger keywords for working capital: `["working capital", "current ratio", "liquidity"]`
- Working capital CTE pattern:
  ```sql
  WITH current_assets AS (SELECT SUM(amount) FROM ...),
       current_liabilities AS (SELECT SUM(amount) FROM ...)
  SELECT (SELECT * FROM current_assets) / NULLIF((SELECT * FROM current_liabilities), 0);
  ```
- Both patterns are stable SQL idioms — injecting them as examples should be highly effective for a model that already knows SQL

---

*Last updated: 2026-03-02*
