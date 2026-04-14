# B1: Pre-SQL Backward Recall Implementation Plan

## Goal
Restore `pre_sql.ts` and integrate it into the pipeline so that a sketch SQL is generated first, missing tables are identified, re-retrieved via pgvector, and merged into the schema context before final SQL generation. This targets the 30 `column_miss` failures (10%).

## Changes

### 1. Restore `pre_sql.ts` (from git history, with import fixes)

**File**: `mcp-server-nl2sql/src/pre_sql.ts`

- Recover from `git show 39928ae~1:mcp-server-nl2sql/src/pre_sql.ts`
- Fix import: `SchemaGlosses` moved from `./schema_glosses.js` → `./schema_grounding.js` during consolidation
- Mark re-retrieved tables with `source: "pre_sql"` instead of `"retrieval"` for traceability
- Everything else (feature flag, types, `runPreSQL`, `reRetrieveTables`, etc.) stays as-is

### 2. Re-export feature flag from `config.ts`

**File**: `mcp-server-nl2sql/src/config.ts`

- Add: `export { PRE_SQL_ENABLED } from "./pre_sql.js"`

### 3. Integrate into `nl_query_tool.ts` pipeline

**File**: `mcp-server-nl2sql/src/nl_query_tool.ts`

**Where**: After schema linker (line ~319), before join planning (line ~321). This placement ensures:
- Glosses are available for `buildMinimalSchemaText`
- Schema linker results can be re-computed after expansion
- Join planner operates on the expanded table set

**What**:
1. Import `runPreSQL`, `PreSQLResult`, `PRE_SQL_ENABLED` from `./pre_sql.js`
2. Add pre-SQL stage between linker and join planner:
   - Call `runPreSQL(question, schemaContext, glosses, pythonClient, pool, difficulty)`
   - If additional tables retrieved: re-run glosses, re-run schema linker, update `allowedTables`
   - Log diagnostics, record exam entry
3. The `difficulty` classification needs to happen before the repair loop. Currently `classifyDifficulty` is called at line ~365 inside the repair loop. We need to call it earlier (or duplicate the call for pre-SQL gating).

**Pipeline order after change**:
```
Retrieval → Glosses → Linker → PRE-SQL → [re-Glosses] → [re-Linker] → Join Planner → Generate → Validate → Rerank
```

### 4. Build & smoke test

- `npm run build` in `mcp-server-nl2sql/`
- Quick 10-question exam: `PRE_SQL_ENABLED=true ./demo/run-exam.sh --db=2000 --max=10`
- Full 300-question exam: `PRE_SQL_ENABLED=true ./demo/run-exam.sh --db=2000`

## Risk Assessment

- **Latency**: +2s per medium/hard question (sketch generation + re-retrieval). Easy questions are skipped.
- **Over-retrieval**: Re-retrieved tables may add noise. Mitigated by `similarity > 0.20` threshold and reranker downweighting.
- **Default OFF**: Feature flag `PRE_SQL_ENABLED` defaults to `false` in config.yaml. Must explicitly enable.
- **No regression when OFF**: When `PRE_SQL_ENABLED=false`, zero code path changes — same as current 84.3%.
