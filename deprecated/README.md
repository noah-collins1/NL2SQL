# Deprecated Files

These files are no longer part of the active codebase and are kept here for reference only.

| File | Reason |
|------|--------|
| `schema_retriever_v2.ts` | V2 dual-retrieval caused errors; V1 is the production retriever |
| `schema-rag-v2.md` | Design doc for the unused V2 retriever |
| `schema-rag-v2-integration.md` | Integration guide for the unused V2 retriever |
| `MSCHEMA_REGRESSION_ANALYSIS.md` | Analysis doc from early M-Schema experiments |
| `NL2SQL_PROCESS_FLOW.md` | Original architecture flow — superseded by `docs/PIPELINE.md` |
| `roadmap.md` | Initial design roadmap (Jan 2026) — all items implemented |
| `deep-research-report.md` | BIRD leaderboard research notes — informed Phases 1-3 |
| `VALIDATION_AND_RAG_PROCESS.md` | Early validation docs (56.7% era) — superseded by `docs/PIPELINE.md` |
| `schema-rag-architecture.md` | Early RAG overview — superseded by `docs/PIPELINE.md` |
| `SCALE_TO_2000_TABLES_PLAN.md` | 2000-table scaling plan — implemented, see `ARCHITECTURE.md` |
| `PRODUCTIZATION_PLAN.md` | Packaging plan — implemented (config, scripts, docs) |

Do **not** re-enable `USE_SCHEMA_RAG_V2`. V1 with BM25+RRF+module routing is the production path.
