# Troubleshooting

## Sidecar Issues

### Sidecar not starting

```
[FAIL] Ollama not reachable at http://localhost:11434
```

**Fix:** Start Ollama first: `ollama serve`

### Sidecar code changes not applying

The Python sidecar caches modules. After editing Python files:

```bash
# Kill the old process
./scripts/start-sidecar.sh --stop
# Or manually:
pkill -f "python.*app.py"

# Restart
./scripts/start-sidecar.sh --bg
```

### Connection refused to sidecar

```
Error: connect ECONNREFUSED 127.0.0.1:8001
```

**Fix:** Ensure the sidecar is running:
```bash
curl http://localhost:8001/health
# If not running:
./scripts/start-sidecar.sh --bg
```

## Database Issues

### Connection error

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Fix:** Start PostgreSQL. On Linux: `sudo systemctl start postgresql`

### Missing embeddings

```
Error: relation "rag.table_embeddings" does not exist
```

**Fix:** Run the RAG setup:
```bash
./scripts/setup-db.sh
```

### search_path issues (2000-table DB)

The 2000-table DB uses per-division schemas (`div_01`, `div_02`, ...). The exam runner sets `search_path` per-question. If running queries manually, set it:

```sql
SET search_path TO div_01, public, rag;
```

## Model Issues

### Out of memory (OOM)

```
Error: CUDA out of memory
```

**Fix:** Use sequential generation:
```yaml
# config/config.local.yaml
generation:
  sequential: true
  candidates:
    k_default: 2
```

### Temperature 0.0 kills diversity

Multi-candidate generation requires `temperature > 0`. With 0.0, all candidates are identical.

**Fix:** Use temperature 0.3 (the default):
```yaml
generation:
  temperature: 0.3
```

### Ollama model not found

```
Error: model "xyz" not found
```

**Fix:** Pull the model:
```bash
ollama pull qwen2.5-coder:7b
```

## Exam Issues

### Very low scores (< 50%)

1. Check the sidecar log: `tail -50 /tmp/nl2sql-sidecar.log`
2. Verify embeddings exist: `psql -d enterprise_erp -c "SELECT COUNT(*) FROM rag.table_embeddings"`
3. Ensure the correct model is loaded: check `OLLAMA_MODEL` in config
4. Make sure `USE_SCHEMA_RAG_V2` is NOT set (V2 is deprecated)

### Inconsistent results across runs

Normal. With `temperature=0.3`, expect ~1.6% variance between runs on 60 questions. Run 3x and take the mean.

### Exam hangs on a question

Usually a sidecar timeout. Check:
1. Sidecar still running: `curl http://localhost:8001/health`
2. Ollama responding: `curl http://localhost:11434/api/tags`
3. GPU not stuck: `nvidia-smi`

## Known Bugs

1. **retrieved_tables reporting**: The exam log's `tables_retrieved` may not perfectly match what was actually sent to the LLM (some tables are added by FK expansion after the count is logged)

2. **Sidecar persistence**: Python module caching means code changes require a full restart (not just reload)

3. **BM25 at 70 tables**: BM25 search barely fires at 70 tables (only 3/60 questions get hits) because `plainto_tsquery` is too literal for natural language. Works better at 2000 tables.
