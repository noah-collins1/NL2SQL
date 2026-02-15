# NL2SQL Improvement Strategy — BIRD/Spider Research Applied

## Current State (2026-02-14)

- **78.0%** (234/300) on 2,377-table enterprise ERP exam with qwen2.5-coder:7b
- Failure breakdown: column_miss 32 (10.7%), llm_reasoning 34 (11.3%)
- Architecture: Module Router → Schema RAG → Schema Linker → Join Planner → LLM → PG Normalize → Validate → Rerank → EXPLAIN → Repair

## Research Sources

Based on deep research into BIRD/Spider benchmark leaderboard techniques:
RSL-SQL, CHESS, Agentar, Contextual-SQL, DIN-SQL, DAIL-SQL, TA-SQL, RESDSQL, PICARD, OmniSQL.

Key finding: **Schema grounding is the #1 bottleneck for 7B models**, not reasoning.
"Gold linker" (oracle schema linking) boosts 7B models substantially — meaning our
retrieval/linking pipeline is the highest-leverage improvement area.

---

## Phase A: Free Wins (immediate, no architecture changes)

Target: 78% → ~83%

| # | Fix | Expected Gain | Status |
|---|-----|---------------|--------|
| A1 | Fix validator false-negatives on work order queries (11 questions with correct SQL rejected) | +5-11 | Investigating |
| A2 | Fix DATE_PART regression (`DATE_PART('day', date-date)` → `(date-date)`) | +3 | Implementing |
| A3 | Enable `PRE_SQL_ENABLED` (already built — RSL-SQL technique #1) | +3-8 | Toggle flag |

## Phase B: Schema Grounding Upgrades (inference-only, 1-2 days each)

Target: ~83% → ~88%

These directly attack column_miss (32 failures), the largest remaining category.

| # | Technique | Source | What to Build | Targets |
|---|-----------|--------|---------------|---------|
| B1 | **Backward recall from pre-SQL** | RSL-SQL | Parse pre-SQL output for referenced tables/columns, union with RAG retrieval, re-retrieve any missing tables. Currently pre_sql.ts extracts tables but doesn't feed back into retrieval for a second pass. | column_miss |
| B2 | **Value retrieval / entity linking** | CHESS | Build per-column value index (unique categoricals + sampled strings). On query, extract candidate values via fuzzy/LSH match, inject into prompt as evidence. Helps dirty values and WHERE clause accuracy. | column_miss, llm_reasoning |
| B3 | **Join-aware table reranking** | JAR/CORE-T | After initial top-K retrieval, rerank to favor connected (FK-joinable) table sets. Penalize disconnected tables, reward FK-compatible combinations. Current join_planner.ts does BFS but doesn't rerank the initial retrieval set. | llm_reasoning (wrong joins) |
| B4 | **Hedged schema selection** | RSL-SQL | For 7B models, noise from extra columns hurts. Implement binary mode: full schema for simple queries (high retrieval confidence), pruned schema for complex queries. Use query classifier to choose. | column_miss regressions from noise |

## Phase C: Candidate Selection Upgrades (1-2 days)

Target: ~88% → ~90%

These attack llm_reasoning (34 failures) by generating better and selecting smarter.

| # | Technique | Source | What to Build | Targets |
|---|-----------|--------|---------------|---------|
| C1 | **Execution-based candidate selection** | Agentar, Contextual-SQL | Expand K on hard queries. Score candidates by: (a) executes without error, (b) returns non-empty results, (c) result column count matches question entity count, (d) join skeleton matches FK graph. | llm_reasoning |
| C2 | **Reward model for SQL selection** | Contextual-SQL | Open-source reward model at `ContextualAI/ctx-bird-reward-250121` on HuggingFace. Could run locally to score candidates. Requires evaluation of model size vs GPU budget. | llm_reasoning |
| C3 | **Similar-task retrieval (few-shot)** | TA-SQL, DAIL-SQL | Build index over solved exam questions (SQL skeletons). On new query, retrieve top-3 similar patterns as few-shot exemplars. Reduces hallucination by showing the model proven patterns. | column_miss, llm_reasoning |

## Phase D: Model-Level Improvements (higher effort)

Target: ~90% → 93%+

| # | Technique | Source | What to Build | Targets |
|---|-----------|--------|---------------|---------|
| D1 | **OmniSQL 7B drop-in** | OmniSQL | Purpose-trained text-to-SQL 7B. Pull from HuggingFace/Ollama, test as drop-in replacement for qwen2.5-coder. No architecture changes needed. | all |
| D2 | **Skeleton-first prompting** | RESDSQL | Two-stage output: (1) generate SQL skeleton with placeholders, (2) fill in column/table names from schema. Reduces structural drift. | column_miss, llm_reasoning |
| D3 | **Constrained decoding** | PICARD | Token-level SQL parser constraints during generation. Prevents syntactically invalid SQL. Requires custom Ollama integration or vLLM. High effort. | execution_error, column_miss |

## Priority Ranking (effort vs impact)

```
Impact
  ^
  |  A1,A2,A3          B1
  |     (free)      (high ROI)
  |
  |        B4    C1    B2
  |      B3        C3
  |
  |           D1
  |        C2    D2
  |                 D3
  +-------------------------> Effort
```

## Key Principles from Research

1. **Don't rely on the generator to discover schema** — make schema discovery a measured, logged step (CHESS)
2. **Higher recall adds noise for 7B models** — use hedged/adaptive schema (RSL-SQL)
3. **Test-time scaling > single-shot** — generate many, select well (Agentar, Contextual-SQL)
4. **Prompt verbosity hurts small models** — keep prompts tight, use skeleton similarity for few-shot (DAIL-SQL)
5. **Correction should be targeted, not presumptive** — "gentle" vs "generic" repair (DIN-SQL)

## Open-Source References

- CHESS: https://github.com/ShayanTalaei/CHESS
- RSL-SQL: https://github.com/Laqcce-cao/RSL-SQL
- Agentar: https://github.com/antgroup/Agentar-Scale-SQL
- Contextual-SQL: https://github.com/ContextualAI/bird-sql
- Contextual reward model: https://huggingface.co/ContextualAI/ctx-bird-reward-250121
- OmniSQL: https://github.com/RUCKBReasoning/OmniSQL
- BIRD leaderboard: https://bird-bench.github.io/
- Spider leaderboard: https://yale-lily.github.io/spider
