# Exams

The exam system measures end-to-end accuracy: question in, correct SQL result out.

## Available Exams

| Exam | DB | Questions | Difficulty Mix | Location |
|------|----|-----------|----------------|----------|
| 86-table regression | enterprise_erp (86 tables) | 60 | 20 easy, 25 medium, 15 hard | `demo/enterprise-erp/003_test_questions.json` |
| 300-question full | enterprise_erp_2000 (2,377 tables) | 300 | 40 simple, 120 moderate, 140 challenging | `demo/exam/exam_full_300.csv` |

## Running Exams

> **Requires Linux/Bash.** All scripts use Bash and have been tested on Linux. macOS may work; Windows requires WSL.

```bash
# 86-table, full 60 questions
./demo/run-exam.sh

# 86-table, 3 runs for statistical mean
./demo/run-exam.sh --runs=3

# 2,377-table, full 300 questions
./demo/run-exam.sh --db=2000

# 2,377-table, first 10 questions (quick smoke test)
./demo/run-exam.sh --db=2000 --max=10
```

### Prerequisites

- Sidecar running (auto-started by `run-exam.sh` if not)
- Database populated with schema, data, and embeddings

### Environment

The exam script sets `EXAM_MODE=true` automatically. For the 2,377-table exam, it also sets `SEQUENTIAL_CANDIDATES=true` and `OLLAMA_MODEL=qwen2.5-coder:7b` if not already set.

## Interpreting Results

### Output Files

Results are saved to `mcp-server-nl2sql/exam_logs/`:
- `exam_results_full_YYYY-MM-DD.json` (86-table)
- `exam_2000_YYYY-MM-DDTHH-MM-SS.json` (2,377-table)

### Key Metrics

```json
{
  "total": 60,
  "passed": 53,
  "failed": 7,
  "success_rate": "88.3%",
  "by_difficulty": {
    "easy": { "passed": 20, "total": 20 },
    "medium": { "passed": 22, "total": 25 },
    "hard": { "passed": 11, "total": 15 }
  }
}
```

### Failure Categories

| Category | Meaning | Typical Fix |
|----------|---------|-------------|
| `column_miss` | LLM referenced a non-existent column | Improve glosses, add linker |
| `llm_reasoning` | SQL logic wrong after all repair attempts | Increase repair budget, better model |
| `execution_error` | Sidecar or connection error | Check sidecar, restart |
| `join_path_miss` | Wrong table relationships | Enable join planner |
| `table_miss` | Important table not retrieved | Tune retrieval threshold |

### Per-Tag Breakdown (2,377-table)

The 2,377-table exam includes domain tags (hr, finance, sales, etc.) and feature tags (dirty_naming, lookup, etc.). Review per-tag scores to find weak areas.

## Creating Custom Exams

### 86-Table Format (JSON)

```json
[
  {
    "id": 1,
    "question": "How many employees are there?",
    "expected_sql": "SELECT COUNT(*) FROM employees",
    "difficulty": "easy",
    "category": "hr"
  }
]
```

### 2,377-Table Format (CSV)

```csv
id,question,expected_sql,difficulty,division,tags
1,"How many employees in div_01?","SELECT COUNT(*) FROM div_01.employees",simple,div_01,"hr"
```

The expected SQL is executed to get the "gold" result. The generated SQL's result is compared to the gold result. An exact match (or equivalent result set) counts as a pass.

## Exam Tips

- Run at least 3x for the 86-table exam to get a stable mean (variance is ~1.6%)
- The 2,377-table exam is single-run (too slow for multi-run)
- Use `--max=10` for quick iteration during development
- Always check the sidecar log (`/tmp/nl2sql-sidecar.log`) if you see unexpected failures
