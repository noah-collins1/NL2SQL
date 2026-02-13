# Deprecated Files

These files are no longer part of the active codebase and are kept here for reference only.

| File | Reason |
|------|--------|
| `schema_retriever_v2.ts` | V2 dual-retrieval caused errors; V1 is the production retriever |
| `schema-rag-v2.md` | Design doc for the unused V2 retriever |
| `schema-rag-v2-integration.md` | Integration guide for the unused V2 retriever |
| `MSCHEMA_REGRESSION_ANALYSIS.md` | Analysis doc from early M-Schema experiments |

Do **not** re-enable `USE_SCHEMA_RAG_V2`. V1 with BM25+RRF+module routing is the production path.
