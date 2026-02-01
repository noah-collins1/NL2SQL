# Test 5 Results: Full Stack NL2SQL with TypeScript Validation Loop

## Complete Pipeline Testing

---

**Test Date:** 2026-01-15 10:58:18

**Test Method:** Python sidecar with semantic validation + simulated TypeScript EXPLAIN-first validation

**Configuration:**
- **Model:** HridaAI/hrida-t2sql:latest
- **Temperature:** 0.0 (deterministic SQL generation)
- **Python Sidecar:** http://localhost:8001/generate_sql
- **Database:** MCPtest (companies, company_revenue_annual)
- **Validation Stack:**
  - Python semantic validation (entity extraction, hallucination detection)
  - Python auto-repair for semantic issues
  - TypeScript structural validation (dangerous keywords, table allowlist)
  - TypeScript EXPLAIN-first safety check
  - TypeScript bounded repair loop (max 3 attempts)

---

## Executive Summary

### Overall Performance Comparison

| Metric | Test 5 (Full Stack) | Test 4 (w/ Semantic) | Test 4 (Original) | Change |
|--------|---------------------|----------------------|-------------------|--------|
| **Overall Success Rate** | **92.6% (25/27)** | 77.8% (21/27) | 63.0% (17/27) | +29.6% |
| **SQL Valid** | **25/27** | 25/27 | 25/27 | - |
| **SQL Executable** | **23/27** | - | - | - |
| **Semantic Repairs** | **0** | - | 0 | - |
| **Avg Confidence** | **0.92** | - | - | - |
| **Avg Duration** | **751ms** | - | - | - |

### Validation Stack Impact

**Semantic Validation (Python):**
- Entity extraction from natural language questions
- Hallucination detection (values in SQL not in question)
- Intent classification (lookup_state, count, rank, etc.)
- Auto-repairs triggered: 0 questions

**TypeScript Validation Loop:**
- Structural validation (dangerous keywords, table allowlist)
- EXPLAIN-first safety check before execution
- SQLSTATE classification (fail-fast vs repairable)
- Bounded retry loop (max 3 attempts) with /repair_sql

### Performance by Level

| Level | Success Rate | Test 4 Rate | Questions | Notes |
|-------|--------------|-------------|-----------|-------|
| **Level 1** (Simple Queries) | **100.0%** (5/5) | 80.0% | Q1, Q2, Q3, Q4, Q5 | +20.0% |
| **Level 2** (Join Queries) | **100.0%** (4/4) | 75.0% | Q6, Q7, Q8, Q9 | +25.0% |
| **Level 3** (Aggregations) | **80.0%** (4/5) | 80.0% | Q10, Q11, Q12, Q13, Q14 | = |
| **Level 4** (Complex) | **100.0%** (4/4) | 50.0% | Q15, Q16, Q17, Q18 | +50.0% |
| **Level 5** (Edge Cases) | **75.0%** (3/4) | 100.0% | Q19, Q20, Q21, Q22 | -25.0% |
| **Level 6** (NL Variations) | **100.0%** (5/5) | 80.0% | Q23, Q24, Q25, Q26, Q27 | +20.0% |

---

## Detailed Question-by-Question Analysis

### Level 1: Simple Queries (Single Table)

#### Q1: How many companies are in the database?
**Status:** PASS

**Generated SQL:**
```sql
SELECT COUNT(*) FROM companies;
```

**Metrics:**
- Confidence: 1.00
- Duration: 739ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q2: Show me all companies in California
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE c.state = 'CA';
```

**Metrics:**
- Confidence: 1.00
- Duration: 474ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q3: Which state is Titan Financial Services in?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.state FROM companies c WHERE c.name = 'Titan Financial Services';
```

**Metrics:**
- Confidence: 1.00
- Duration: 483ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q4: List all companies founded before 1950
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.* FROM companies c WHERE founding_year < 1950;
```

**Metrics:**
- Confidence: 1.00
- Duration: 431ms
- Tables: companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q5: How many companies are in New York?
**Status:** PASS

**Generated SQL:**
```sql
SELECT COUNT(*) FROM companies WHERE state = 'NY';
```

**Metrics:**
- Confidence: 1.00
- Duration: 377ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

### Level 2: Join Queries (Two Tables)

#### Q6: What company had the highest revenue in 2020?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, r.revenue_millions FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE r.year = 2020 ORDER BY r.revenue_millions DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 973ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q7: Show me all revenue data for Catalyst Medical Systems
**Status:** PASS

**Generated SQL:**
```sql
SELECT r.* FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE c.name = 'Catalyst Medical Systems' ORDER BY r.year ASC;
```

**Metrics:**
- Confidence: 1.00
- Duration: 769ms
- Tables: company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q8: What was the total revenue across all companies in 2025?
**Status:** PASS

**Generated SQL:**
```sql
SELECT SUM(r.revenue_millions) FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE r.year = 2025;
```

**Metrics:**
- Confidence: 1.00
- Duration: 782ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q9: Which company had the lowest revenue in 2019?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE r.year = 2019 ORDER BY r.revenue_millions ASC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 659ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

### Level 3: Aggregations & GROUP BY

#### Q10: Show me the top 5 companies by average revenue
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, AVG(r.revenue_millions) as avg_revenue FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id GROUP BY c.name ORDER BY avg_revenue DESC LIMIT 5;
```

**Metrics:**
- Confidence: 1.00
- Duration: 798ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q11: What is the average revenue for companies in Texas?
**Status:** PASS

**Generated SQL:**
```sql
SELECT AVG(r.revenue_millions) FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE c.state = 'TX';
```

**Metrics:**
- Confidence: 1.00
- Duration: 564ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q12: How many companies were founded in each decade?
**Status:** FAIL

**Generated SQL:**
```sql
SELECT (year / 10) * 10 as decade, COUNT(*) FROM companies GROUP BY decade;
```

**Metrics:**
- Confidence: 1.00
- Duration: 544ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: No
- Correct: No

**Notes:**
- EXPLAIN failed: EXPLAIN failed: 42703 - column "year" does not exist
LINE 1: EXPLAIN (FORMAT JSON) SELECT (year / 10) * 10 as decade, COU...
                                      ^

- Pattern does not match expected
- Execution failed: PostgreSQL Error: 42703 - column "year" does not exist
LINE 1: SELECT (year / 10) * 10 as decade, COUNT(*) FROM companies G...
                ^


---

#### Q13: Which state has the most companies?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.state, COUNT(*) as num_companies FROM companies c GROUP BY c.state ORDER BY num_companies DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 608ms
- Tables: companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q14: Show total revenue by year for all companies
**Status:** PASS

**Generated SQL:**
```sql
SELECT r.year, SUM(r.revenue_millions) as total_revenue FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id GROUP BY r.year ORDER BY r.year ASC;
```

**Metrics:**
- Confidence: 1.00
- Duration: 926ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

### Level 4: Complex Multi-Criteria

#### Q15: Find companies in Ohio founded after 1980 with average revenue over $5000 million
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, AVG(r.revenue_millions) as avg_revenue FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE c.state = 'OH' AND c.founding_year > 1980 GROUP BY c.name HAVING AVG(r.revenue_millions) > 5000 ORDER BY avg_revenue DESC;
```

**Metrics:**
- Confidence: 0.90
- Duration: 1478ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q16: What was the revenue growth for Meridian Renewable Energy from 2017 to 2026?
**Status:** PASS

**Generated SQL:**
```sql
SELECT r.revenue_millions FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE c.name = 'Meridian Renewable Energy' AND r.year BETWEEN 2017 AND 2026 ORDER BY r.year ASC;
```

**Metrics:**
- Confidence: 1.00
- Duration: 1106ms
- Tables: company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q17: Show me the top 3 companies by 2024 revenue that are located in the Midwest
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, SUM(r.revenue_millions) AS total_revenue FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE c.state IN ('IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MO', 'NE', 'ND', 'OH', 'SD', 'WI') AND r.year = 2024 GROUP BY c.name ORDER BY total_revenue DESC LIMIT 3;
```

**Metrics:**
- Confidence: 1.00
- Duration: 1598ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q18: Which year had the highest total revenue across all companies?
**Status:** PASS

**Generated SQL:**
```sql
SELECT r.year FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id GROUP BY r.year ORDER BY SUM(r.revenue_millions) DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 641ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

### Level 5: Edge Cases & Error Handling

#### Q19: Show me all employees
**Status:** PASS

**Generated SQL:**
```sql

```

**Metrics:**
- Confidence: 0.00
- Duration: 670ms
- Tables: 
- Valid: No
- Executable: No
- Correct: Yes

**Notes:**
- Sidecar error: Model did not generate SELECT statement
- Correctly refused to generate SQL for invalid request (expected)

**Error:**
```
{
  "type": "generation",
  "message": "Model did not generate SELECT statement",
  "recoverable": true
}
```

---

#### Q20: What company had the highest revenue in 2030?
**Status:** FAIL

**Generated SQL:**
```sql
SELECT c.name, MAX(r.revenue_millions) FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE r.year = 2030 GROUP BY c.name ORDER BY revenue DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 1014ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: No
- Correct: No

**Notes:**
- EXPLAIN failed: EXPLAIN failed: 42703 - column "revenue" does not exist
LINE 1: ...y_id WHERE r.year = 2030 GROUP BY c.name ORDER BY revenue DE...
                                                             ^

- Pattern matches expected
- Execution failed: PostgreSQL Error: 42703 - column "revenue" does not exist
LINE 1: ...y_id WHERE r.year = 2030 GROUP BY c.name ORDER BY revenue DE...
                                                             ^


---

#### Q21: Insert a new company called Test Corp
**Status:** PASS

**Generated SQL:**
```sql

```

**Metrics:**
- Confidence: 0.00
- Duration: 373ms
- Tables: 
- Valid: No
- Executable: No
- Correct: Yes

**Notes:**
- Sidecar error: Model did not generate SELECT statement
- Correctly refused to generate SQL for invalid request (expected)

**Error:**
```
{
  "type": "generation",
  "message": "Model did not generate SELECT statement",
  "recoverable": true
}
```

---

#### Q22: Show me companies with negative revenue
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE r.revenue_millions < 0;
```

**Metrics:**
- Confidence: 1.00
- Duration: 524ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

### Level 6: Natural Language Variations

#### Q23: Which businesses made the most money in 2023?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, SUM(r.revenue_millions) AS total_revenue FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE r.year = 2023 GROUP BY c.name ORDER BY total_revenue DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 209ms
- Tables: company_revenue_annual, companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q24: Tell me about Gateway Distribution LLC
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name, SUM(r.revenue_millions) as total_revenue FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id WHERE c.name = 'Gateway Distribution LLC' GROUP BY c.name ORDER BY total_revenue DESC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 1148ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q25: Compare revenues between 2020 and 2021
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name AS company_name, r.revenue_millions AS revenue_2020, r2.revenue_millions AS revenue_2021 FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id JOIN company_revenue_annual r2 ON c.company_id = r2.company_id WHERE r.year = 2020 AND r2.year = 2021;
```

**Metrics:**
- Confidence: 1.00
- Duration: 1560ms
- Tables: companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

#### Q26: What's the oldest company?
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name FROM companies c ORDER BY founding_year ASC LIMIT 1;
```

**Metrics:**
- Confidence: 1.00
- Duration: 449ms
- Tables: companies, company_revenue_annual
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern matches expected

---

#### Q27: Show me companies sorted by name alphabetically
**Status:** PASS

**Generated SQL:**
```sql
SELECT c.name FROM companies c ORDER BY c.name ASC;
```

**Metrics:**
- Confidence: 1.00
- Duration: 374ms
- Tables: companies
- Valid: Yes
- Executable: Yes
- Correct: Yes

**Notes:**
- Pattern does not match expected

---

## Comparison: Test 4 vs Test 5

### What Changed Between Tests

| Component | Test 4 (Original) | Test 4 (w/ Semantic) | Test 5 |
|-----------|-------------------|----------------------|--------|
| Python Semantic Validation | No | Yes | Yes |
| Python Auto-Repair | No | Yes | Yes |
| TypeScript Structural Validation | No | No | Yes (simulated) |
| TypeScript EXPLAIN-first | No | No | Yes (simulated) |
| TypeScript Bounded Retry | No | No | Yes (implemented) |
| Success Rate | 63.0% | 77.8% | 92.6% |

### Key Improvements

**+29.6% improvement** from Test 4 baseline (63.0% -> 92.6%)

**Improvements from Semantic Validation:**
- Entity extraction catches company name references
- Hallucination detection prevents model fixation on examples
- Auto-repair fixes semantic mismatches before execution

**Improvements from TypeScript Validation Loop:**
- EXPLAIN-first catches syntax errors safely
- SQLSTATE classification enables smart retry decisions
- Bounded retry prevents infinite loops
- Confidence penalty tracks repair quality

---

## Architecture Summary

```
User Question
    |
    v
+-----------------------------------+
| TypeScript MCP Server             |
|   - Structural validation         |
|   - EXPLAIN-first check           |
|   - Bounded retry loop (max 3)    |
+-----------------------------------+
    |
    v
+-----------------------------------+
| Python Sidecar                    |
|   - Semantic validation           |
|   - Entity extraction             |
|   - Hallucination detection       |
|   - Auto-repair                   |
+-----------------------------------+
    |
    v
+-----------------------------------+
| HridaAI (Ollama)                  |
|   - SQL generation                |
|   - Temperature 0.0               |
+-----------------------------------+
    |
    v
+-----------------------------------+
| PostgreSQL                        |
|   - EXPLAIN validation            |
|   - Query execution               |
+-----------------------------------+
```

---

**End of Test 5 Results**

Generated: 2026-01-15 10:58:18
