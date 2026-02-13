# Model Guide

## Tested Models

| Model | Size | Context | 86-Table | 2,377-Table | Notes |
|-------|------|---------|----------|-------------|-------|
| `qwen2.5-coder:7b` | 4.7 GB | 32K | **88.3%** | **76.0%** | Best overall. Needs `sequential: true` on 8GB GPU |
| `llama3.1:8b` | 4.9 GB | 128K | 81.7% | — | Good context length, lower accuracy |
| `HridaAI/hrida-t2sql:latest` | 2.3 GB | 4K | 74.4% | — | Baseline. Has baked-in system prompt |

## Switching the LLM

### Option 1: YAML config

```yaml
# config/config.local.yaml
model:
  llm: "llama3.1:8b"
```

### Option 2: Environment variable

```bash
OLLAMA_MODEL=llama3.1:8b ./scripts/start-sidecar.sh
```

After changing the model, restart the sidecar:

```bash
./scripts/start-sidecar.sh --stop
./scripts/start-sidecar.sh --bg
```

## Switching the Embedding Model

The default embedding model is `nomic-embed-text` (768 dimensions). To change it:

1. Update `config/config.local.yaml`:
   ```yaml
   model:
     embedding: "your-model-name"
   ```
2. **Re-generate all embeddings** (required — dimension mismatch will cause errors):
   ```bash
   cd mcp-server-nl2sql
   npx tsx scripts/populate_embeddings.ts
   ```

## Model-Specific Quirks

### qwen2.5-coder:7b (recommended)

- Wraps SQL in markdown fences — automatically stripped by `_strip_markdown_fences()`
- 32K context handles schema linker + join planner fine
- **Must use `sequential: true`** on 8GB GPU (two parallel 7B inferences exceed VRAM)
- Best with `temperature: 0.3` — 0.0 kills multi-candidate diversity

### llama3.1:8b

- 128K context window — handles very large schemas
- Same VRAM constraints as qwen (needs sequential on 8GB)
- Lower accuracy — tends to hallucinate column names more often

### HridaAI/hrida-t2sql

- Has a baked-in system prompt via its Modelfile — do NOT send additional system prompt
- Tiny 4K context — can't use schema linker or join planner
- 2.3 GB — runs parallel candidates on 8GB GPU without issues
- Does **not** wrap SQL in markdown fences

### Qwen3 Thinking Models

**Incompatible.** Qwen3's thinking models use `<think>` blocks that conflict with Ollama's `/api/generate` stop tokens. Do not use them.

## GPU Memory Guide

| GPU VRAM | Recommended Config |
|----------|-------------------|
| 4 GB | Hrida (2.3 GB), parallel OK |
| 8 GB | qwen2.5-coder:7b, `sequential: true`, `k_default: 2-4` |
| 16 GB | qwen2.5-coder:7b, parallel OK, `k_default: 6` |
| 24 GB+ | Any 13-14B model, parallel OK |
