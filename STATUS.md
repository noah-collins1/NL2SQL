# NL2SQL Project Status

**Last Updated:** 2026-02-13
**Phase:** Production — Unified Config, Pipeline Upgrades (Phases 1-3)

## Current Performance

### 86-Table DB (enterprise_erp, 60 questions)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Easy (20) | 20 | 0 | **100%** |
| Medium (25) | 22 | 3 | 88% |
| Hard (15) | 11 | 4 | 73.3% |
| **Total** | **53** | **7** | **88.3%** |

Model: `qwen2.5-coder:7b`, glosses ON, PG normalize ON, schema linker ON, join planner ON, BM25 ON, module router ON, reranker ON

### 2,377-Table DB (enterprise_erp_2000, 300 questions)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Simple (40) | 38 | 2 | 95.0% |
| Moderate (120) | 89 | 31 | 74.2% |
| Challenging (140) | 101 | 39 | 72.1% |
| **Total** | **228** | **72** | **76.0%** |

Top failure modes: column_miss 35 (11.7%), llm_reasoning 30 (10.0%), execution_error 7 (2.3%)

See [docs/EVAL_2000_TABLE_RESULTS.md](docs/EVAL_2000_TABLE_RESULTS.md) for full breakdown.

## Performance History

| Date | 86-Table | 2,377-Table | Key Change |
|------|----------|-------------|------------|
| 2026-01-31 | 53.3% | — | V1 Schema RAG baseline |
| 2026-02-02 | 75.0% | — | Parallel multi-candidate |
| 2026-02-11 | 85.0% | — | Pipeline upgrades Phase 1 (glosses, PG normalize) |
| 2026-02-12 | 88.3% | — | Targeted fixes + Phase 1 retrieval (BM25, module router) |
| **2026-02-13** | **88.3%** | **76.0%** | 2,377-table DB + Phase 2/3 (join planner, reranker) |
