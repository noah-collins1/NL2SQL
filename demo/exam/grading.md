# Grading Guide (BIRD-style)

## Metrics
- Exact Match (EX): SQL string matches gold_sql exactly after normalization
- Strict EX: EX + same selected columns ordering
- Execution Accuracy: results match on a reference DB
- Latency: end-to-end time (retrieval + generation + execution)
- Retrieval Recall@K: expected_tables present in top-K retrieved tables
- Schema Miss Taxonomy: missing table, missing join path, wrong filter column, wrong value grounding

## Recommended Evaluation
1. Retrieval: measure recall@K for expected_tables and expected_columns.
2. SQL generation: compute EX, Strict EX, and execution accuracy.
3. Error attribution: categorize failures using schema-miss taxonomy.
4. Speed: report P50/P95 latency for end-to-end pipeline.

## Normalization Tips
- Lowercase keywords
- Remove extra whitespace
- Normalize aliases
- Canonicalize order of SELECT columns for EX (optional)

## Suggested Thresholds
- Retrieval Recall@10 >= 0.90 for expected_tables
- Execution Accuracy >= 0.70 for challenging questions
- Latency P95 <= 5s for full pipeline
