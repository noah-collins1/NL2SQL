"""
Configuration for Python AI Sidecar

Hardcoded schema and prompts for MCPtest database (MVP Phase 1).
Phase 2 will receive schema dynamically from TypeScript.
"""

import os

# Ollama Configuration
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "HridaAI/hrida-t2sql:latest")
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "90"))  # seconds (increased for multi-candidate generation)
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "0"))  # 0 = use model default
SEQUENTIAL_CANDIDATES = os.getenv("SEQUENTIAL_CANDIDATES", "false").lower() == "true"
SQL_SYSTEM_PROMPT = os.getenv("SQL_SYSTEM_PROMPT",
    "You are an expert PostgreSQL query generator. Given a database schema and a question, "
    "output ONLY a single SELECT query. No explanations, no markdown, no commentary."
)

# Server Configuration
PORT = int(os.getenv("PORT", "8001"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# Join Hint Format: "edges" | "paths" | "both" | "none"
# - edges: FK edges only (default)
# - paths: Suggested join paths only
# - both: Both edges and paths
# - none: No join hints
JOIN_HINT_FORMAT = os.getenv("JOIN_HINT_FORMAT", "edges")

# MCPtest Database Schema (Hardcoded for MVP)
MCPTEST_SCHEMA = {
    "companies": {
        "columns": ["company_id", "name", "founding_year", "state"],
        "primary_key": "company_id",
        "description": "100 companies with founding year and US state (2-letter code)",
        "sample_values": {
            "state": ["CA", "NY", "TX", "MO", "OH", "IN", "KY", "VT", "MD"],
            "founding_year": "1900-2023 range"
        }
    },
    "company_revenue_annual": {
        "columns": ["company_id", "year", "revenue_millions"],
        "primary_key": ["company_id", "year"],
        "foreign_keys": {
            "company_id": "companies.company_id"
        },
        "description": "Annual revenue data 2017-2026, 10 years per company, revenue in millions of dollars",
        "sample_values": {
            "year": "2017-2026",
            "revenue_millions": "6.23 to 23712.27"
        }
    }
}

# Domain knowledge (fixes for known Hrida issues from Test 3)
DOMAIN_KNOWLEDGE = """
Domain-Specific Rules:
- State codes are 2-letter abbreviations (e.g., 'CA', 'NY', 'TX', not "California")
- Midwest states: IL, IN, IA, KS, MI, MN, MO, NE, ND, OH, SD, WI
- Revenue is already in millions - don't convert
- Years are 2017-2026 (10 years of data)
"""

# Hrida System Prompt Template
HRIDA_BASE_PROMPT_VERSION = "v1.2.0"

HRIDA_BASE_PROMPT = """Generate PostgreSQL SELECT query for the mcptest database.

## Database Schema

{schema}

## PostgreSQL-Specific Rules (IMPORTANT)

1. **Decade Grouping:** Use `(year / 10) * 10` NOT `EXTRACT(DECADE FROM year)`
   - EXTRACT(DECADE ...) does NOT exist in PostgreSQL
   - Example: `SELECT (founding_year / 10) * 10 as decade, COUNT(*) FROM companies GROUP BY decade`

2. **Min/Max Values:** Prefer `ORDER BY + LIMIT` over `MIN()/MAX()` without GROUP BY
   - WRONG: `SELECT name, MIN(founding_year) FROM companies` (missing GROUP BY)
   - RIGHT: `SELECT name, founding_year FROM companies ORDER BY founding_year ASC LIMIT 1`

3. **String Literals:** Always use single quotes for strings
   - RIGHT: `WHERE column = 'value'`
   - WRONG: `WHERE column = "value"` (double quotes are for identifiers)

4. **Table Aliases:** Use short aliases for readability
   - `companies` → `c`
   - `company_revenue_annual` → `r`

5. **JOIN Pattern:**
   ```sql
   FROM companies c
   JOIN company_revenue_annual r ON c.company_id = r.company_id
   ```

6. **Single statement only:** Output one SELECT statement, no multiple queries

## Example Queries (patterns only - use actual values from the question)

- "Which state is [Company] in?" → `SELECT state FROM companies WHERE name = '[Company]'`
- "How many companies in [State]?" → `SELECT COUNT(*) FROM companies WHERE state = '[STATE_CODE]'`
- "Show revenue for [Company]" → `SELECT r.* FROM company_revenue_annual r JOIN companies c ON r.company_id = c.company_id WHERE c.name = '[Company]'`
- "Top N companies by revenue" → `SELECT c.name, SUM(r.revenue_millions) ... GROUP BY ... ORDER BY ... DESC LIMIT N`

**IMPORTANT:** Extract actual entity names from the question. If the question mentions a specific company name, your SQL MUST include that exact name in a WHERE clause.

{domain_knowledge}

## Output Rules

1. Output ONLY the SQL query, nothing else
2. Query MUST start with SELECT
3. Single statement only (no multiple queries separated by semicolons)
4. If you cannot generate valid SQL, respond: CANNOT_GENERATE

## Question

{question}

## SQL Query

"""

# Repair delta block templates (ephemeral, per-attempt)

REPAIR_DELTA_VALIDATOR = """
## Previous Attempt Had Validation Issues

{validator_issues_formatted}

**Critical Instructions:**
- Fix ALL validation errors listed above
- Only use these tables: {allowed_tables}
- Do NOT use dangerous keywords or functions
- Ensure query starts with SELECT
"""

REPAIR_DELTA_POSTGRES = """
## Previous SQL Failed PostgreSQL Validation

**Error Code:** {sqlstate}
**Message:** {message}
{hint_section}

**Previous SQL That Failed:**
```sql
{previous_sql}
```

**What Went Wrong:**
{sqlstate_hint}

{column_candidates_section}

**Your Task:**
Generate a CORRECTED SQL query that fixes the error above.
"""

REPAIR_DELTA_COLUMN_CANDIDATES = """
**Column Error Analysis:**
The column `{undefined_column}` does not exist in the table you referenced.

**Available columns (grouped by table):**
{candidates_by_table}

**Fix Strategy:**
1. If the column exists in a DIFFERENT table, either:
   - Change your FROM/JOIN to include that table, OR
   - Use a column that EXISTS in the table you're already querying
2. If it's a typo, use the correct spelling from the list above
3. Check that your table alias matches the actual table
"""

# MINIMAL column whitelist for 42703 repairs - ONLY the relevant table + FK neighbors
REPAIR_DELTA_MINIMAL_WHITELIST = """
## Column Whitelist for `{resolved_table}`

Use only these exact column names for `{resolved_table}`:
  {primary_columns}

{neighbor_section}

**Rules:**
- Do not invent columns.
- If you need a concept not present, join a table that has it.
"""

# Legacy: Full column whitelist (NOT USED - kept for reference)
REPAIR_DELTA_COLUMN_WHITELIST = """
## COLUMN WHITELIST (MANDATORY)

**CRITICAL:** You MUST use ONLY column names exactly as listed below. Do NOT invent columns.
If a column is not in this list, it does not exist.

{column_whitelist_block}

**Constraint:** Any column reference NOT in the whitelist above is FORBIDDEN.
If you need data that is not available as a column, either:
1. JOIN to a table that has the column, OR
2. Compute it from existing columns, OR
3. Return CANNOT_GENERATE if the data is truly unavailable.
"""

REPAIR_DELTA_WRONG_TABLE_COLUMN = """
**Wrong Table Column Error:**
You referenced `{alias}.{column}` but the table aliased as `{alias}` does not have column `{column}`.

**The table `{resolved_table}` has these columns:**
{table_columns}

**Possible fixes:**
1. Use a column that EXISTS in `{resolved_table}`: {available_columns}
2. If you need `{column}`, JOIN to a table that has it
3. Check your FROM/JOIN clause to ensure you have the right tables
"""

REPAIR_DELTA_SEMANTIC = """
## Semantic Mismatch Detected

Your SQL does not correctly reference entities mentioned in the question.

{semantic_issues_formatted}

**Critical:** If the question asks about a specific company (e.g., "Titan Financial Services"),
your SQL MUST include `WHERE name = 'Titan Financial Services'` (or similar).

**Previous SQL That Missed Entities:**
```sql
{previous_sql}
```

Generate corrected SQL that properly references ALL entities from the question.
"""

# Multi-Candidate SQL Generation Template
MULTI_CANDIDATE_PROMPT = """
## Multi-Candidate SQL Generation

Generate exactly {k} different valid SQL queries that answer the question.
Each query should be a complete, executable SELECT statement.
Separate each SQL candidate with exactly this delimiter on its own line:
{delimiter}

**Variation Guidelines:**
- Candidate 1: Most straightforward approach (simple JOINs, minimal subqueries)
- Candidate 2: Alternative table ordering or JOIN strategy
{extra_guidelines}

**Rules for each candidate:**
- Must be a valid PostgreSQL SELECT statement
- Must use only tables/columns from the schema
- Must return data that answers the question
- Each candidate should be DIFFERENT (not just whitespace/formatting changes)

**Output Format:**
```sql
SELECT a, b FROM table1 WHERE c = 'value';
{delimiter}
SELECT x, y FROM table2 JOIN table1 ON ... WHERE z = 'value';
```

Generate {k} SQL candidates now:
"""

# Default delimiter for multi-candidate output
MULTI_CANDIDATE_DELIMITER = "---SQL_CANDIDATE---"

# SQLSTATE-specific hints
SQLSTATE_HINTS = {
    "42P01": "Table does not exist. Check table name spelling. Valid tables: {allowed_tables}",
    "42703": "Column does not exist. Verify column names match the schema exactly.",
    "42601": "Syntax error. Check for missing parentheses, quotes, or keywords.",
    "42P10": "Invalid column reference. Use explicit table aliases to resolve ambiguity.",
    "42804": "Datatype mismatch. Ensure comparisons use compatible types (e.g., text = 'value', not text = 123).",
    "42883": "Function does not exist. Check function name and argument types. PostgreSQL does not have EXTRACT(DECADE FROM ...).",
    "42501": "Permission denied. Query must be SELECT only (read-only access).",
}

def build_hrida_prompt(question: str, schema: dict = None) -> str:
    """
    Build the complete Hrida prompt

    Args:
        question: Natural language question
        schema: Database schema dict (if None, uses MCPTEST_SCHEMA)

    Returns:
        Complete prompt string for Hrida
    """
    if schema is None:
        schema = MCPTEST_SCHEMA

    # Format schema for prompt
    schema_text = ""
    for table_name, table_info in schema.items():
        columns = ", ".join(table_info["columns"])
        desc = table_info["description"]
        schema_text += f"**{table_name}:** {columns}\n"
        schema_text += f"  Description: {desc}\n"

        if "foreign_keys" in table_info:
            for fk_col, fk_ref in table_info["foreign_keys"].items():
                schema_text += f"  Foreign Key: {fk_col} → {fk_ref}\n"

        schema_text += "\n"

    # Build complete prompt
    prompt = HRIDA_BASE_PROMPT.format(
        schema=schema_text.strip(),
        domain_knowledge=DOMAIN_KNOWLEDGE,
        question=question
    )

    return prompt


# RAG-based prompt template for enterprise databases (V2 Enhanced)
HRIDA_RAG_PROMPT = """Generate PostgreSQL SELECT query for the {database_id} database.

## Database Schema

The following tables and their columns are available. Read the schema carefully:
- [PK] = Primary Key (unique identifier)
- [FK→target] = Foreign Key (join to target table.column)
- [AMT] = Monetary amount, [QTY] = Quantity, [DATE] = Date, [TS] = Timestamp
- [STATUS] = Status enum, [TYPE] = Type/category enum, [CODE] = Code identifier

{schema_block}

## Join Hints

Use these FK relationships for JOINs:
{join_hints_block}

{join_paths_block}

## Column Selection Rules (CRITICAL)

1. **Only use columns that exist in the table** - Check the schema above CAREFULLY before writing SQL
2. **Match columns to their tables** - If you need `project_id`, use it from a table that HAS that column
3. **FK columns link tables** - Use [FK→...] columns to join, don't assume columns exist elsewhere
4. **No cross-table column guessing** - If `budgets` doesn't list `project_id`, don't use `budgets.project_id`
5. **Do NOT guess column names** - Use ONLY the exact column names shown in the schema.
   Common mistakes: `name` vs `first_name`/`last_name`, `price` vs `list_price`/`unit_cost`,
   `posted` vs `status = 'Posted'`, `amount` vs `planned_amount`/`total_amount`
6. **For boolean-like filters** (posted, active, approved), check if the table uses a `status` column instead

## PostgreSQL Rules

1. Use short table aliases for readability
2. Always use explicit JOINs with ON clauses matching FK→PK relationships
3. Use single quotes for string literals
4. For aggregations, include all non-aggregated columns in GROUP BY
5. Output ONE SELECT statement only
6. Date comparisons: To check "more than N years/months ago", write:
   `WHERE column < CURRENT_DATE - INTERVAL 'N years'`
   Do NOT write: `(CURRENT_DATE - column) > INTERVAL '...'` (date minus date returns integer, not interval)
7. Monthly grouping: Use `date_trunc('month', column)` as a function call, NOT `column::date_trunc(...)`
8. "By X" queries: When question says "by customer", "by vendor", "by category" etc.,
   ALWAYS include that grouping entity in both SELECT and GROUP BY
9. Rates and percentages: When asked for "growth rate" or "percentage change",
   compute the actual ratio: `(current - previous) / NULLIF(previous, 0) * 100`
10. Division safety: ALWAYS wrap denominators in NULLIF(expr, 0) to prevent division by zero.
    Use `a * 100.0 / NULLIF(b, 0)` for percentage calculations (100.0 forces float division)
11. Month-over-month growth: Use LAG window function with a CTE:
    ```
    WITH monthly AS (SELECT date_trunc('month', order_date) AS month, SUM(total) AS sales FROM orders GROUP BY 1)
    SELECT month, sales, (sales - LAG(sales) OVER (ORDER BY month)) * 100.0 / NULLIF(LAG(sales) OVER (ORDER BY month), 0) AS growth_pct FROM monthly
    ```

## Question

{question}

## SQL Query

"""


def build_rag_prompt(question: str, schema_context: dict, schema_link_text: str = None, join_plan_text: str = None) -> str:
    """
    Build prompt from RAG-retrieved schema context (V2 Enhanced)

    Args:
        question: Natural language question
        schema_context: SchemaContextPacket from TypeScript
        schema_link_text: Pre-formatted schema link section (Phase 1, opt-in)
        join_plan_text: Pre-formatted join plan section (Phase 2, opt-in)

    Returns:
        Complete prompt string for Hrida
    """
    tables = schema_context.get("tables", [])
    fk_edges = schema_context.get("fk_edges", [])
    join_hints = schema_context.get("join_hints", [])
    join_paths = schema_context.get("join_paths", [])
    database_id = schema_context.get("database_id", "enterprise_erp")

    # Get list of selected table names for filtering
    selected_tables = set(t.get("table_name", "").lower() for t in tables)

    # Build schema block from M-Schema (now multi-line format)
    schema_lines = []
    current_module = None

    for table in sorted(tables, key=lambda t: (t.get("module", ""), t.get("table_name", ""))):
        module = table.get("module", "Unknown")
        if module != current_module:
            if current_module is not None:
                schema_lines.append("")
            schema_lines.append(f"### {module}")
            current_module = module

        # M-Schema with gloss
        m_schema = table.get("m_schema", table.get("table_name", "unknown"))
        schema_lines.append(f"```")
        schema_lines.append(m_schema)
        schema_lines.append(f"```")
        schema_lines.append("")

    schema_block = "\n".join(schema_lines)

    # Build join hints based on JOIN_HINT_FORMAT setting
    join_hints_block = ""
    join_paths_block = ""

    # Filter hints to only include selected tables
    def table_from_hint(hint_str: str) -> str:
        """Extract table name from hint string like 'schema.table.column'"""
        parts = hint_str.split(".")
        return parts[1].lower() if len(parts) >= 2 else parts[0].lower()

    filtered_hints = [
        h for h in (join_hints or [])
        if table_from_hint(h.get('from', '')) in selected_tables
        and table_from_hint(h.get('to', '')) in selected_tables
    ]

    filtered_paths = [
        p for p in (join_paths or [])
        if all(t.lower() in selected_tables for t in p.get('tables', []))
    ]

    if JOIN_HINT_FORMAT in ("edges", "both"):
        if filtered_hints:
            hint_lines = []
            for hint in filtered_hints[:15]:  # Max 15 hints
                hint_lines.append(f"- {hint.get('from')} → {hint.get('to')}")
            join_hints_block = "\n".join(hint_lines)
        else:
            join_hints_block = "No join hints available."

    if JOIN_HINT_FORMAT in ("paths", "both"):
        if filtered_paths:
            path_lines = ["## Suggested Join Paths", ""]
            for path in filtered_paths[:3]:  # Max 3 paths
                path_lines.append(f"**{path.get('path')}**")
                for cond in path.get('conditions', []):
                    path_lines.append(f"  - {cond}")
                path_lines.append("")
            join_paths_block = "\n".join(path_lines)

    if JOIN_HINT_FORMAT == "none":
        join_hints_block = "Use FK relationships from schema to determine JOINs."
        join_paths_block = ""

    # Build the base prompt (unchanged template for backward compatibility)
    prompt = HRIDA_RAG_PROMPT.format(
        database_id=database_id,
        schema_block=schema_block,
        join_hints_block=join_hints_block if join_hints_block else "No join hints available.",
        join_paths_block=join_paths_block,
        question=question
    )

    # Prepend schema link section if provided (opt-in only)
    if schema_link_text:
        prompt = prompt.replace(
            f"Generate PostgreSQL SELECT query for the {database_id} database.",
            f"Generate PostgreSQL SELECT query for the {database_id} database.\n\n{schema_link_text}"
        )

    # Insert join plan section if provided (opt-in only)
    if join_plan_text:
        prompt = prompt.replace(
            "## Column Selection Rules (CRITICAL)",
            f"{join_plan_text}\n\n## Column Selection Rules (CRITICAL)"
        )

    return prompt


def format_column_whitelist(column_whitelist: dict) -> str:
    """
    Format column whitelist for repair prompt.

    Args:
        column_whitelist: Dict mapping table names to list of column names

    Returns:
        Formatted string showing all columns per table
    """
    if not column_whitelist:
        return "No column whitelist available."

    lines = []
    for table_name in sorted(column_whitelist.keys()):
        columns = column_whitelist[table_name]
        lines.append(f"**{table_name}:** {', '.join(columns)}")

    return "\n".join(lines)


def format_candidates_by_table(candidates: list) -> str:
    """
    Format column candidates grouped by table for better LLM understanding
    """
    # Group candidates by table
    by_table = {}
    for c in candidates:
        table = c.get("table_name", "unknown")
        if table not in by_table:
            by_table[table] = []
        by_table[table].append(c)

    lines = []
    for table, cols in by_table.items():
        lines.append(f"\n**{table}:**")
        for c in cols:
            match_info = {
                "exact": "✓ exact match",
                "fuzzy": "~ similar spelling",
                "embedding": "≈ similar meaning",
                "prefix": "✓ prefix match",
                "suffix": "✓ suffix match",
            }.get(c.get("match_type", ""), "")
            score = c.get("match_score", 0)
            lines.append(
                f"  - {c.get('column_name')} ({c.get('data_type')}) {match_info} [{score:.0%}]"
            )
            if c.get("gloss"):
                lines.append(f"    → {c.get('gloss')}")

    return "\n".join(lines)


def build_rag_repair_prompt(
    question: str,
    previous_sql: str,
    schema_context: dict,
    validator_issues: list = None,
    postgres_error: dict = None,
    semantic_issues: list = None,
    schema_link_text: str = None,
    join_plan_text: str = None
) -> str:
    """
    Build repair prompt for RAG-based schema context (V2 Enhanced)

    Args:
        question: Original question
        previous_sql: SQL that failed
        schema_context: SchemaContextPacket from TypeScript
        validator_issues: Validation issues from TypeScript
        postgres_error: PostgreSQL error context
        semantic_issues: Semantic validation issues
        schema_link_text: Pre-formatted schema link section (Phase 1, opt-in)
        join_plan_text: Pre-formatted join plan section (Phase 2, opt-in)

    Returns:
        Complete repair prompt
    """
    # Start with base RAG prompt
    base = build_rag_prompt(question, schema_context, schema_link_text=schema_link_text, join_plan_text=join_plan_text)

    # Get allowed tables from schema context
    allowed_tables = [t.get("table_name") for t in schema_context.get("tables", [])]

    # Append delta blocks
    delta_blocks = []

    # Add semantic issues delta
    if semantic_issues:
        from semantic_validator import format_semantic_issues
        issues_text = format_semantic_issues(semantic_issues)
        delta_blocks.append(
            REPAIR_DELTA_SEMANTIC.format(
                semantic_issues_formatted=issues_text,
                previous_sql=previous_sql
            )
        )

    # Add validator issues delta
    if validator_issues:
        issues_text = format_validator_issues(validator_issues)
        delta_blocks.append(
            REPAIR_DELTA_VALIDATOR.format(
                validator_issues_formatted=issues_text,
                allowed_tables=", ".join(allowed_tables)
            )
        )

    # Add Postgres error delta
    if postgres_error:
        hint_text = ""
        if postgres_error.get("hint"):
            hint_text = f"**Hint:** {postgres_error['hint']}"

        sqlstate = postgres_error.get("sqlstate", "Unknown")
        sqlstate_hint = SQLSTATE_HINTS.get(
            sqlstate,
            "Review the error message and previous SQL carefully."
        ).format(allowed_tables=", ".join(allowed_tables))

        # For 42703 errors: Use MINIMAL whitelist (not full whitelist)
        column_candidates_section = ""
        if sqlstate == "42703" and postgres_error.get("minimal_whitelist"):
            minimal = postgres_error["minimal_whitelist"]
            resolved_table = minimal.get("resolved_table")
            whitelist = minimal.get("whitelist", {})

            # Only apply whitelist if we have actual columns (non-empty list)
            primary_cols_list = whitelist.get(resolved_table.lower(), []) if resolved_table else []
            if resolved_table and primary_cols_list:
                primary_columns = ", ".join(primary_cols_list)

                # Format neighbor tables section
                neighbor_section = ""
                neighbor_tables = minimal.get("neighbor_tables", [])
                if neighbor_tables:
                    neighbor_lines = ["If you need a column not listed above, you may JOIN these related tables:"]
                    for neighbor in neighbor_tables:
                        neighbor_cols = whitelist.get(neighbor.lower(), [])
                        if neighbor_cols:
                            neighbor_lines.append(f"  **{neighbor}:** {', '.join(neighbor_cols)}")
                    neighbor_section = "\n".join(neighbor_lines)

                column_candidates_section = REPAIR_DELTA_MINIMAL_WHITELIST.format(
                    resolved_table=resolved_table,
                    primary_columns=primary_columns,
                    neighbor_section=neighbor_section
                )
        elif postgres_error.get("column_candidates"):
            # Fallback: use candidates if no minimal whitelist
            candidates = postgres_error["column_candidates"]
            undefined_col = postgres_error.get("undefined_column", "unknown")
            candidates_by_table = format_candidates_by_table(candidates)
            column_candidates_section = REPAIR_DELTA_COLUMN_CANDIDATES.format(
                undefined_column=undefined_col,
                candidates_by_table=candidates_by_table
            )

        delta_blocks.append(
            REPAIR_DELTA_POSTGRES.format(
                sqlstate=sqlstate,
                message=postgres_error.get("message", "Unknown error"),
                hint_section=hint_text,
                previous_sql=previous_sql,
                sqlstate_hint=sqlstate_hint,
                column_candidates_section=column_candidates_section
            )
        )

    # Compose: base + deltas
    full_prompt = base + "\n\n" + "\n\n".join(delta_blocks)

    return full_prompt


def build_repair_prompt(
    question: str,
    previous_sql: str,
    schema: dict = None,
    validator_issues: list = None,
    postgres_error: dict = None,
    semantic_issues: list = None,
    allowed_tables: list = None
) -> str:
    """
    Build repair prompt with base + delta blocks

    Args:
        question: Original natural language question
        previous_sql: SQL that failed
        schema: Database schema
        validator_issues: List of validation issues from TypeScript
        postgres_error: PostgreSQL error context (sqlstate, message, hint)
        semantic_issues: List of semantic validation issues
        allowed_tables: List of allowed table names

    Returns:
        Complete repair prompt with delta blocks
    """
    if schema is None:
        schema = MCPTEST_SCHEMA

    if allowed_tables is None:
        allowed_tables = list(schema.keys())

    # Start with base prompt
    base = build_hrida_prompt(question, schema)

    # Append delta blocks
    delta_blocks = []

    # Add semantic issues delta (highest priority - check first)
    if semantic_issues:
        from semantic_validator import format_semantic_issues
        issues_text = format_semantic_issues(semantic_issues)
        delta_blocks.append(
            REPAIR_DELTA_SEMANTIC.format(
                semantic_issues_formatted=issues_text,
                previous_sql=previous_sql
            )
        )

    # Add validator issues delta
    if validator_issues:
        issues_text = format_validator_issues(validator_issues)
        delta_blocks.append(
            REPAIR_DELTA_VALIDATOR.format(
                validator_issues_formatted=issues_text,
                allowed_tables=", ".join(allowed_tables)
            )
        )

    # Add Postgres error delta
    if postgres_error:
        hint_text = ""
        if postgres_error.get("hint"):
            hint_text = f"**Hint:** {postgres_error['hint']}"

        sqlstate = postgres_error.get("sqlstate", "Unknown")
        sqlstate_hint = SQLSTATE_HINTS.get(
            sqlstate,
            "Review the error message and previous SQL carefully."
        ).format(allowed_tables=", ".join(allowed_tables))

        delta_blocks.append(
            REPAIR_DELTA_POSTGRES.format(
                sqlstate=sqlstate,
                message=postgres_error.get("message", "Unknown error"),
                hint_section=hint_text,
                previous_sql=previous_sql,
                sqlstate_hint=sqlstate_hint
            )
        )

    # Compose: base + deltas (ephemeral, never mutate base)
    full_prompt = base + "\n\n" + "\n\n".join(delta_blocks)

    return full_prompt


def format_validator_issues(issues: list) -> str:
    """
    Format validator issues for delta block

    Args:
        issues: List of validation issue dicts with code, message, suggestion

    Returns:
        Formatted string with emoji indicators
    """
    if not issues:
        return "No specific issues provided."

    lines = []
    for issue in issues:
        severity = issue.get("severity", "error")
        code = issue.get("code", "UNKNOWN")
        message = issue.get("message", "")
        suggestion = issue.get("suggestion", "")

        # Emoji for severity
        emoji = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}.get(severity, "•")

        lines.append(f"{emoji} **{code}**: {message}")
        if suggestion:
            lines.append(f"   → Suggestion: {suggestion}")

    return "\n".join(lines)


# Export all configuration
__all__ = [
    'OLLAMA_BASE_URL',
    'OLLAMA_MODEL',
    'OLLAMA_TIMEOUT',
    'OLLAMA_NUM_CTX',
    'SEQUENTIAL_CANDIDATES',
    'SQL_SYSTEM_PROMPT',
    'PORT',
    'LOG_LEVEL',
    'MCPTEST_SCHEMA',
    'DOMAIN_KNOWLEDGE',
    'HRIDA_BASE_PROMPT_VERSION',
    'HRIDA_BASE_PROMPT',
    'HRIDA_RAG_PROMPT',
    'build_hrida_prompt',
    'build_rag_prompt',
    'build_repair_prompt',
    'build_rag_repair_prompt',
    'format_validator_issues',
    'format_candidates_by_table',
    'format_column_whitelist',
    'TABLE_KEYWORDS',
    'COLUMN_KEYWORDS',
    'QUERY_PATTERNS',
]


# Common query patterns for Stage 1 filtering (Phase 1)
QUERY_PATTERNS = {
    "count": ["how many", "count", "number of", "total"],
    "list": ["show", "list", "display", "get", "find"],
    "aggregate": ["average", "avg", "sum", "total", "max", "min"],
    "compare": ["compare", "difference", "between", "vs"],
    "trend": ["trend", "over time", "growth", "change", "year over year", "yoy"],
    "detail": ["information about", "details", "tell me about"],
}

# Table keywords for Stage 1 filtering
TABLE_KEYWORDS = {
    "companies": ["company", "companies", "business", "businesses", "firm", "firms", "name"],
    "company_revenue_annual": ["revenue", "income", "earnings", "money", "sales", "financial", "year", "annual"],
}

# Column keywords for Stage 1 filtering
COLUMN_KEYWORDS = {
    "companies": {
        "name": ["name", "company", "business"],
        "founding_year": ["founded", "founding", "established", "started", "year", "age", "old", "oldest", "newest"],
        "state": ["state", "location", "where", "located", "region"],
    },
    "company_revenue_annual": {
        "year": ["year", "when", "date", "time"],
        "revenue_millions": ["revenue", "income", "earnings", "money", "sales", "financial", "top", "highest", "lowest"],
    },
}
