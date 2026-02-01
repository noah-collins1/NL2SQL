# Python Sidecar - NL2SQL AI Layer

## Overview

This Python sidecar handles AI-powered SQL generation for the NL2SQL MCP server. It communicates with Ollama/HridaAI to generate SQL from natural language questions.

**Components:**
- `app.py` - FastAPI server with `/generate_sql` and `/repair_sql` endpoints
- `config.py` - Prompts, schema, and configuration
- `hrida_client.py` - Ollama API client
- `keyword_filter.py` - Stage 1 table filtering
- `semantic_validator.py` - Semantic validation layer (v1.3.0)

---

## Semantic Validator (`semantic_validator.py`)

### Purpose

Catches cases where the AI model generates syntactically valid SQL that doesn't actually answer the question. This happens when the model:
- Fixates on examples in the prompt instead of the actual question
- Hallucinates values not mentioned in the question
- Misunderstands query intent

### How It Works

```
Question: "Which state is Titan Financial Services in?"

1. Extract entities: ["Titan Financial Services"]
2. Classify intent: "lookup_state"
3. Check SQL contains entities: ❌ SQL has WHERE state='CA' not WHERE name='Titan...'
4. Check for hallucinations: ❌ 'CA' not mentioned in question
5. Trigger auto-repair with semantic feedback
```

### Current Capabilities

#### What's Universal (Works for Any Database)

**Entity Extraction** - Pattern-based, not hardcoded:
```python
# Works for ANY multi-word capitalized phrase
"Which state is Titan Financial Services in?"     ✅ extracts "Titan Financial Services"
"Which state is Acme Global Solutions in?"        ✅ extracts "Acme Global Solutions"
"Which state is XYZ Manufacturing Corp in?"       ✅ extracts "XYZ Manufacturing Corp"

# Works for ANY US state code
"Companies in California" → detects 'CA' mention
"Companies in Ohio"       → detects 'OH' mention

# Works for ANY year in 2000-2030
"Revenue in 2019" ✅
"Revenue in 2025" ✅
```

**Intent Classification** - Keyword patterns:
```python
# These patterns work universally
"which state"  → lookup_state intent
"how many"     → count intent
"top 5"        → rank intent
"compare"      → compare intent
```

#### What's Limited (May Break)

**1. Entity Pattern Matching**
```python
# Won't catch:
"Show revenue for acme corp"           # lowercase - won't extract
"Find company #12345"                  # ID-based lookup
"Show me John's company"               # possessive reference
"The company mentioned above"          # contextual reference
```

**2. Schema Awareness**
```python
# Doesn't know your schema - can't catch:
"Show employee salaries"   # Doesn't know 'employees' table doesn't exist
"Filter by department"     # Doesn't know 'department' isn't a column
```

**3. Domain-Specific Entities**
```python
# Only handles:
- US state codes (2-letter)
- Years 2000-2030
- Company names (capitalized multi-word)

# Doesn't handle:
- Country names ("companies in Germany")
- City names ("companies in Chicago")
- Product names, categories, etc.
- Dates ("Q1 2023", "last quarter")
```

**4. Semantic Understanding**
```python
# Doesn't understand synonyms:
"businesses" vs "companies"    # Doesn't know these are the same
"earnings" vs "revenue"        # Can't map synonyms to columns
```

### Flexibility Summary

| Aspect | Flexibility | Notes |
|--------|-------------|-------|
| Company names | ⚠️ Medium | Works for capitalized multi-word names |
| US States | ✅ High | All 50 states supported |
| Years | ⚠️ Medium | Only 2000-2030 range |
| Intent detection | ⚠️ Medium | Basic keyword matching |
| Schema awareness | ❌ None | Doesn't know your tables/columns |
| Synonyms | ❌ None | No semantic understanding |

---

## Future Improvements

### Option A: Schema-Aware Validation

Pass schema to validator and check if columns/tables mentioned in question appear correctly in SQL:

```python
def validate_semantic_match(question, sql, schema):
    # Extract columns mentioned in question
    for table_name, table_info in schema.items():
        for column in table_info['columns']:
            if column_mentioned_in_question(question, column):
                if column not in sql:
                    issues.append({
                        'code': 'MISSING_COLUMN',
                        'message': f"Question mentions '{column}' but SQL doesn't use it"
                    })
```

### Option B: LLM-Based Validation

Use a small/fast LLM to check semantic match:

```python
async def validate_with_llm(question: str, sql: str) -> Tuple[bool, List[str]]:
    prompt = f"""
    Question: {question}
    Generated SQL: {sql}

    Does this SQL correctly answer the question?
    List any entities from the question that are missing from the SQL.
    List any values in the SQL that weren't mentioned in the question.

    Response format:
    VALID: yes/no
    MISSING_ENTITIES: [list]
    HALLUCINATED_VALUES: [list]
    """

    response = await fast_llm.generate(prompt)
    return parse_validation_response(response)
```

**Pros:** Much more flexible, understands context and synonyms
**Cons:** Adds latency, requires another LLM call, may be inconsistent

### Option C: Configurable Entity Extractors

Per-database configuration for entity types:

```python
# config.py
ENTITY_EXTRACTORS = {
    "mcptest": {
        "company_name": {
            "pattern": r"[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+(?:\s+(?:LLC|Inc|Corp|Services))?",
            "sql_column": "name",
            "sql_table": "companies"
        },
        "state": {
            "pattern": r"\b(AL|AK|AZ|AR|CA|CO|CT|...|WY)\b",
            "sql_column": "state",
            "sql_table": "companies"
        },
        "year": {
            "pattern": r"\b(20[0-2][0-9])\b",
            "sql_column": "year",
            "sql_table": "company_revenue_annual"
        }
    },
    "hr_database": {
        "employee_name": {
            "pattern": r"[A-Z][a-z]+\s+[A-Z][a-z]+",
            "sql_column": "full_name",
            "sql_table": "employees"
        },
        "department": {
            "pattern": r"(Engineering|Sales|Marketing|HR|Finance)",
            "sql_column": "department",
            "sql_table": "employees"
        }
    }
}
```

### Option D: Embedding-Based Entity Matching

Use embeddings to match question entities to SQL entities:

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('all-MiniLM-L6-v2')

def find_similar_entities(question_entity: str, sql_values: List[str]) -> Optional[str]:
    """Find if question entity has a similar match in SQL values"""
    q_embedding = model.encode(question_entity)

    for sql_val in sql_values:
        sql_embedding = model.encode(sql_val)
        similarity = cosine_similarity(q_embedding, sql_embedding)
        if similarity > 0.8:
            return sql_val

    return None  # No match found - potential issue
```

**Pros:** Handles synonyms, typos, variations
**Cons:** Requires embedding model, adds latency

---

## Test Results

### Test 4 (2026-01-14)

**Before Semantic Validation:** 63.0% (17/27)
**After Semantic Validation:** 77.8% (21/27)
**Improvement:** +14.8%

Questions fixed by semantic validation:
- Q1: Removed unnecessary JOIN that inflated count
- Q3: Fixed entity reference (Titan Financial Services)
- Q5: Fixed undefined table aliases
- Q7: Removed hallucinated Midwest filter
- Q25: Fixed column name (revenue → revenue_millions)

---

## API Reference

### POST /generate_sql

```json
{
    "question": "How many companies are in California?",
    "database_id": "mcptest"
}
```

Response includes `notes` field if semantic repair was triggered:
```json
{
    "sql_generated": "SELECT COUNT(*) FROM companies WHERE state = 'CA';",
    "confidence_score": 0.9,
    "notes": "Auto-repaired semantic issues: MISSING_ENTITY, HALLUCINATED_VALUE"
}
```

### POST /repair_sql

```json
{
    "question": "Which state is Titan Financial Services in?",
    "database_id": "mcptest",
    "previous_sql": "SELECT name FROM companies WHERE state = 'CA';",
    "semantic_issues": [
        {
            "code": "MISSING_ENTITY",
            "severity": "error",
            "message": "Question mentions 'Titan Financial Services' but SQL doesn't reference it"
        }
    ],
    "attempt": 1
}
```

---

## Change Log

**v1.3.0** (2026-01-14)
- Added semantic validation layer
- Entity extraction (company names, states, years)
- Intent classification (lookup_state, count, rank, etc.)
- Hallucination detection
- Auto-repair integration
- Test 4: 63% → 77.8% success rate

**v1.2.0** (2026-01-14)
- Removed problematic 'CA' example from prompt
- Added few-shot query patterns
- Updated HRIDA_BASE_PROMPT

**v1.0.0** (2026-01-13)
- Initial implementation
- Ollama/HridaAI integration
- Keyword-based table filtering
