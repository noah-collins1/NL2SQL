# Refactor Plan

Priority improvements for code quality and performance.

## Performance Hotspots

### 1. Retrieval Latency (~200-500ms per query)

The pgvector cosine similarity search is the single largest latency source. At 2000 tables, each retrieval involves a full vector scan.

**Improvement:** Use IVFFlat or HNSW index tuning. Current lists=10 is likely suboptimal for 2000+ rows. Profile with `EXPLAIN ANALYZE` on the similarity query.

### 2. EXPLAIN Blocking (~2s per candidate)

Each candidate runs `EXPLAIN` with a 2s timeout. With K=4 candidates, this is 2-8s of wall time (parallel but still significant).

**Improvement:** Run EXPLAIN only on the top-2 scored candidates (pre-filter by lint score first). The reranker already provides a proxy for query quality.

### 3. Embedding Generation (~30min for 2000 tables)

Initial setup requires generating embeddings for all tables. The sidecar processes them sequentially.

**Improvement:** Batch embedding calls, or use a separate bulk embedding script that calls the embedding model directly.

### 4. Multi-Candidate Overhead

At K=6 (hard questions), six parallel LLM calls compete for GPU. With `sequential=true`, this is 6x the single-query latency.

**Improvement:** Adaptive K based on retrieval confidence — if the top table has similarity > 0.8, reduce K to 2.

### 5. Repair Loop Latency

Each repair attempt is a full LLM call. Three attempts = 3x generation latency.

**Improvement:** Use the first repair attempt's error to prune candidates rather than regenerating. For 42703 errors, the surgical whitelist rewrite (when active mode is enabled) can fix without an LLM call.

## Code Clarity Improvements

### 1. Config Consolidation (DONE)

Previously: 30+ env vars scattered across 15 files. Now: unified YAML config with env-var overrides.

### 2. Error Type System

Current error handling uses string-based error types. Replace with a structured error hierarchy:

```typescript
class RetrievalError extends NL2SQLError { ... }
class GenerationError extends NL2SQLError { ... }
class ValidationError extends NL2SQLError { ... }
class RepairExhaustedError extends NL2SQLError { ... }
```

### 3. Prompt Centralization

Prompts are split between `python-sidecar/config.py` (8 templates) and scattered TypeScript files. Consider moving all prompt templates to a `prompts/` directory with YAML files.

### 4. Pipeline as Explicit Stages

`nl_query_tool.ts` is a 2400-line function. Refactor into explicit pipeline stages:

```typescript
const pipeline = [
  moduleRouting,
  schemaRetrieval,
  promptConstruction,
  sqlGeneration,
  candidateEvaluation,
  repairLoop,
  execution,
]
```

### 5. Telemetry/Observability

Current logging is ad-hoc console output. Add structured telemetry with:
- Per-stage latency tracking
- Retrieval recall metrics
- Repair success rates by error type

## Low-Risk Refactors

| Refactor | Files | Risk | Impact |
|----------|-------|------|--------|
| Remove dead V2 code | ~~schema_retriever_v2.ts~~ (DONE) | None | Cleaner imports |
| Consolidate prompt templates | config.py | Low | Easier prompt tuning |
| Extract exam instrumentation | nl_query_tool.ts | Low | Cleaner main function |
| Type-safe config | config/loadConfig.ts | Low | Better IDE support |
| Structured logging | all files | Medium | Better debugging |
