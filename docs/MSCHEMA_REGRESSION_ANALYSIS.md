# M-Schema V2 Regression Analysis

**Date**: 2026-01-29
**Original Baseline**: 58.3% (35/60)
**Current Result**: 56.7% (34/60)
**Net Regression**: -1.6% (-1 question)

---

## Executive Summary

The M-Schema V2 improvements (type tags, micro-glosses, compact format, join hints) resulted in a net regression of 1 question. While some failure categories improved, others worsened, and the changes introduced variance that caused different questions to fail.

---

## Failure Category Comparison

| Category | Baseline | After Changes | Delta | Target |
|----------|----------|---------------|-------|--------|
| **column_miss** | 13-14 | 11 | -2 to -3 | ≤8 |
| **llm_reasoning** | 5 | 8 | +3 | ≤3 |
| **join_path_miss** | 2 | 3 | +1 | 0-1 |
| **execution_error** | 5 | 4 | -1 | - |
| **success** | 35 | 34 | -1 | - |

### Key Observations

1. **column_miss improved slightly** (14→11): Type tags may be helping LLM select correct columns
2. **llm_reasoning worsened significantly** (5→8): More validation failures / max repair attempts exceeded
3. **join_path_miss worsened** (2→3): Join hints may not be helping or may be confusing the LLM

---

## Question-Level Analysis

### New Regressions (6 questions that started failing)

| ID | Question | Tables Missing | Issue |
|----|----------|----------------|-------|
| 2 | "How many employees were hired in 2024?" | employees | Basic table not retrieved despite exact keyword match |
| 12 | "List all fixed assets with their purchase cost" | fixed_assets | Generated SQL joins purchase_orders incorrectly |
| 27 | "List top 10 customers by total order value" | customers, sales_orders | Validation loop exhausted |
| 36 | "Show approval rate for purchase requisitions" | purchase_requisitions | Column mismatch in repair loop |
| 48 | "Employees who haven't completed mandatory training" | employees, employee_training, training_courses | Column mismatch |
| 55 | "Generate trial balance for current period" | chart_of_accounts, journal_lines, etc. | Join path complexity |

### New Successes (6 questions that started passing)

| ID | Question | Previously Missing |
|----|----------|--------------------|
| 19 | "What fiscal years exist?" | fiscal_years |
| 29 | "Conversion rate from quotes to orders" | sales_quotes, sales_orders |
| 42 | "Project resources and allocation percentages" | projects, project_resources, employees |
| 45 | "Documents attached to each entity type" | document_attachments |
| 57 | "Project profitability budget vs actual" | projects, project_budgets, project_expenses |
| 58 | "Resource allocation by employee across projects" | employees, project_resources, projects |

---

## Root Cause Analysis

### 1. Embedding Quality Variance

The compact M-Schema format changed the `embed_text` used for vector embeddings. This caused:
- Some tables to become MORE retrievable (Projects module improved: 33% → 83%)
- Some tables to become LESS retrievable (HR module degraded: 71% → 57%)

The net effect is essentially random variance - different questions fail/pass with no consistent improvement.

### 2. LLM Reasoning Degradation

The increase in `llm_reasoning` failures (5→8) suggests:
- Compact format may be TOO terse for LLM to understand relationships
- Join hints format may be adding confusion rather than clarity
- Type tags may be interpreted incorrectly by the LLM

### 3. Join Path Issues

Join hints were added but `join_path_miss` increased (2→3). Possible causes:
- Join hints format not being utilized effectively
- LLM ignoring or misinterpreting the hints
- Hints may be incomplete for complex multi-table queries

---

## Module-Level Impact

| Module | Before | After | Delta |
|--------|--------|-------|-------|
| HR | 71.4% (10/14) | 57.1% (8/14) | **-14.3%** |
| Projects | 33.3% (2/6) | 83.3% (5/6) | **+50%** |
| Assets | 100% (5/5) | 80% (4/5) | -20% |
| Common | 50% (1/2) | 100% (2/2) | +50% |
| Procurement | 40% (2/5) | 20% (1/5) | -20% |

The variance is high across modules, suggesting the changes aren't consistently helpful.

---

## What Needs to Be Fixed

### Priority 1: Revert to Baseline or Hybrid Approach

The current changes are net negative. Options:
1. **Revert completely** to original embed_text format
2. **Hybrid approach**: Keep rich embed_text for retrieval, use compact M-Schema only in LLM prompt

### Priority 2: Fix LLM Reasoning Failures

The 5→8 increase in validation failures needs investigation:
- Examine the 3 new validation failures to understand root cause
- Consider adding SQL lint validator (Task #3) to catch common LLM mistakes
- Improve repair prompt to handle edge cases

### Priority 3: Improve Join Hints Effectiveness

Current join hints aren't helping. Consider:
- Simplifying the format
- Only including join hints for the specific tables in context
- Adding example SQL fragments showing correct joins

### Priority 4: Stabilize Embeddings

The embedding variance is problematic:
- Consider using a separate, stable embed_text for vectors
- Use m_schema_compact only for LLM prompts
- Don't tie embedding quality to prompt formatting

---

## Recommended Next Steps

1. **Immediate**: Revert embed_text changes, keep m_schema_compact for prompts only
2. **Short-term**: Implement SQL lint validator (Task #3) to catch syntax errors
3. **Medium-term**: A/B test join hint formats to find effective representation
4. **Ongoing**: Track per-question variance across runs to identify stable patterns

---

## Files Changed

- `mcp-server-nl2sql/src/schema_embedder.ts` - Type tags, compact format
- `mcp-server-nl2sql/src/schema_types.ts` - JoinHint, JoinPath interfaces
- `mcp-server-nl2sql/src/schema_retriever_v2.ts` - Join hint computation
- `python-sidecar/config.py` - Prompt templates with join hints

---

## Appendix: Exam Logs

- Baseline: `exam_logs/exam_results_full_2026-01-27.json`
- After changes: `exam_logs/exam_results_full_2026-01-29.json`
