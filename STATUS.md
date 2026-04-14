# NL2SQL Project Status

**Last Updated:** 2026-04-14
**Phase:** Production — Rounds 1-7 complete (V2 exam), Industry-Erp integration

## Current Performance

### 86-Table DB (enterprise_erp, 60 questions)

| Difficulty | Pass | Fail | Rate |
|------------|------|------|------|
| Easy (20) | 20 | 0 | **100%** |
| Medium (25) | 22 | 3 | 88% |
| Hard (15) | 11 | 4 | 73.3% |
| **Total** | **53** | **7** | **88.3%** |

Model: `qwen2.5-coder:7b`, all pipeline stages ON

### 2,377-Table DB — V2 Exam (500 questions, no evidence, ambiguity grading)

| Category | Pass | Fail | Rate |
|----------|------|------|------|
| SQL (answerable only, 465q) | 428 | 37 | **92.0%** |
| Overall (incl. 35 ambiguous) | 433 | 67 | **86.6%** |

Top failure modes: column_miss 20, llm_reasoning 15, exec_error 2, ambiguous false-pos 30

Weakest categories: except (40%), cross_division (33%), cte (68%), anti_join (70%), yoy (67%)

See [docs/EVAL_2000_TABLE_RESULTS.md](docs/EVAL_2000_TABLE_RESULTS.md) for full domain breakdown.

### Industry-Erp (real ERP, 79 questions)

| Result | Value |
|--------|-------|
| **Pass** | 72/79 |
| **Rate** | **91.1%** |

Real SQL Server ERP (wholesale distribution, 883 tables) migrated to PostgreSQL.

## Performance History

### 2,377-Table DB

| Date | Result | Exam | Key Change |
|------|--------|------|------------|
| 2026-02-13 | 76.0% (228/300) | V1 300q | Initial pipeline — RAG, multi-candidate, basic validation |
| 2026-02-14 | 83.3% (250/300) | V1 300q | Schema glosses, linker, join planner, reranker |
| 2026-02-16 | 88.3% (265/300) | V1 300q | Cross-table FK hints, phantom column hints, confusable warnings |
| 2026-02-17 | 90.7% (272/300) | V1 300q | PG normalize EXTRACT(DAY), division-scope stripping |
| 2026-02-26 | 84.3% (421/500) | V2 500q | V2 baseline — 500q, no evidence, ambiguity grading |
| 2026-02-27 | 88.8% (444/500) | V2 500q | Stop token fix, null module fix, CONFUSABLE_TABLES, SQLSTATE |
| 2026-03-03 | 91.2% (456/500) | V2 500q | Re-embed missing tables, +6 CONFUSABLE entries, PATTERN_HINTS |
| **2026-03-04** | **92.0% SQL / 86.6% overall** | V2 500q | Schema-concrete PATTERN_HINTS, Pre-SQL fix + enabled |

### Industry-Erp

| Date | Result | Key Change |
|------|--------|------------|
| 2026-02-24 | 1.3% | Initial attempt — HNSW index returning 0 table results |
| 2026-02-25 | 64.6% | Fixed HNSW partial index, re-embedded hub tables |
| 2026-02-25 | 86.1% | CTE fixes, Industry-Erp quoting, identifier repair |
| **2026-02-26** | **91.1%** | Re-embedded WH tables, CTE max_tokens fix |

### 86-Table DB

| Date | Result | Key Change |
|------|--------|------------|
| 2026-01-31 | 53.3% | V1 Schema RAG baseline |
| 2026-02-02 | 75.0% | Parallel multi-candidate |
| 2026-02-11 | 85.0% | Pipeline Phase 1 (glosses, PG normalize) |
| **2026-02-12** | **88.3%** | Targeted fixes + BM25 + module router |
