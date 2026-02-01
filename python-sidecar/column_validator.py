"""
Schema-Aware Column Validator

Validates that all column references in SQL exist in the actual schema.
Catches column hallucination errors before they hit PostgreSQL.

Examples caught:
- Q12: SELECT (year / 10) * 10 FROM companies
       → "year" doesn't exist in companies, should be "founding_year"
- Q20: ORDER BY revenue DESC
       → "revenue" doesn't exist, should be "revenue_millions"
"""

import re
import logging
from typing import List, Dict, Tuple, Set, Optional

logger = logging.getLogger(__name__)


def extract_tables_from_sql(sql: str) -> Dict[str, Optional[str]]:
    """
    Extract table names and their aliases from SQL.

    Returns: Dict mapping alias (or table name) to actual table name
    """
    tables = {}
    sql_upper = sql.upper()

    # Pattern: FROM table_name [alias] or JOIN table_name [alias]
    # Handles: FROM companies c, JOIN company_revenue_annual r
    patterns = [
        r'\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)?\s*(?:JOIN|WHERE|GROUP|ORDER|LIMIT|;|$)',
        r'\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)?\s+(?:JOIN|WHERE|GROUP|ORDER|LIMIT)',
        r'\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)?\s+ON',
    ]

    # Simpler approach: find all FROM/JOIN table patterns
    from_pattern = r'\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)'
    join_pattern = r'\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)'

    # Find tables
    from_matches = re.findall(from_pattern, sql, re.IGNORECASE)
    join_matches = re.findall(join_pattern, sql, re.IGNORECASE)

    all_tables = from_matches + join_matches

    # Now find aliases: table_name alias pattern
    alias_pattern = r'\b(companies|company_revenue_annual)\s+([a-zA-Z])\b'
    alias_matches = re.findall(alias_pattern, sql, re.IGNORECASE)

    # Build mapping
    for table in all_tables:
        table_lower = table.lower()
        tables[table_lower] = table_lower

    for table, alias in alias_matches:
        table_lower = table.lower()
        alias_lower = alias.lower()
        tables[alias_lower] = table_lower
        tables[table_lower] = table_lower

    return tables


def extract_column_references(sql: str) -> List[Tuple[str, Optional[str]]]:
    """
    Extract column references from SQL.

    Returns: List of (column_name, table_alias_or_none)
    """
    columns = []

    # Remove string literals to avoid false matches
    sql_clean = re.sub(r"'[^']*'", "''", sql)

    # Pattern: alias.column or just column
    # Match: c.name, r.year, founding_year, revenue_millions
    qualified_pattern = r'\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b'
    unqualified_pattern = r'\b([a-zA-Z_][a-zA-Z0-9_]*)\b'

    # Find qualified columns (alias.column)
    qualified_matches = re.findall(qualified_pattern, sql_clean)
    for alias, column in qualified_matches:
        # Skip SQL keywords and functions
        if alias.upper() not in ('SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR',
                                  'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'AS',
                                  'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
                                  'DISTINCT', 'NULL', 'NOT', 'IN', 'BETWEEN', 'LIKE',
                                  'IS', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'):
            columns.append((column.lower(), alias.lower()))

    return columns


def get_all_columns_from_schema(schema: Dict) -> Dict[str, Set[str]]:
    """
    Build a mapping of table_name -> set of column names.
    """
    result = {}
    for table_name, table_info in schema.items():
        result[table_name.lower()] = set(c.lower() for c in table_info.get('columns', []))
    return result


def validate_columns(
    sql: str,
    schema: Dict,
    question: str = ""
) -> Tuple[bool, List[Dict]]:
    """
    Validate that all column references in SQL exist in the schema.

    Args:
        sql: The generated SQL
        schema: Database schema dict
        question: Original question (for context in error messages)

    Returns:
        Tuple of (is_valid, list of issues)
    """
    issues = []

    # Get schema column mapping
    schema_columns = get_all_columns_from_schema(schema)
    all_valid_columns = set()
    for cols in schema_columns.values():
        all_valid_columns.update(cols)

    # Get tables used in SQL
    tables_in_sql = extract_tables_from_sql(sql)

    # Get column references
    column_refs = extract_column_references(sql)

    # Also check for unqualified column references in specific clauses
    # These are harder to validate without knowing context

    # Check for known problematic patterns
    sql_upper = sql.upper()
    sql_lower = sql.lower()

    # Pattern 1: Using "year" in companies table context
    if 'companies' in sql_lower and 'company_revenue' not in sql_lower:
        # Only querying companies table
        if re.search(r'\byear\b', sql_lower) and not re.search(r'founding_year', sql_lower):
            # Using "year" but companies doesn't have "year", only "founding_year"
            issues.append({
                'code': 'WRONG_COLUMN',
                'severity': 'error',
                'message': "Column 'year' does not exist in 'companies' table. Did you mean 'founding_year'?",
                'suggestion': "Replace 'year' with 'founding_year' for the companies table",
                'wrong_column': 'year',
                'correct_column': 'founding_year',
                'table': 'companies'
            })

    # Pattern 2: Using "revenue" instead of "revenue_millions"
    if re.search(r'\brevenue\b', sql_lower) and not re.search(r'revenue_millions', sql_lower):
        issues.append({
            'code': 'WRONG_COLUMN',
            'severity': 'error',
            'message': "Column 'revenue' does not exist. Did you mean 'revenue_millions'?",
            'suggestion': "Replace 'revenue' with 'revenue_millions'",
            'wrong_column': 'revenue',
            'correct_column': 'revenue_millions',
            'table': 'company_revenue_annual'
        })

    # Pattern 3: Using "company" instead of "name" or "company_id"
    if re.search(r'\bcompany\b', sql_lower) and 'company_id' not in sql_lower and 'companies' not in sql_lower:
        # Check if it's trying to use "company" as a column
        if re.search(r'select.*\bcompany\b|where.*\bcompany\b|order by.*\bcompany\b', sql_lower):
            issues.append({
                'code': 'WRONG_COLUMN',
                'severity': 'warning',
                'message': "Column 'company' may not exist. Did you mean 'name' or 'company_id'?",
                'suggestion': "Use 'name' for company names or 'company_id' for IDs",
                'wrong_column': 'company'
            })

    # Pattern 4: Check ORDER BY clause for invalid columns
    order_by_match = re.search(r'ORDER\s+BY\s+([a-zA-Z_][a-zA-Z0-9_]*)', sql, re.IGNORECASE)
    if order_by_match:
        order_col = order_by_match.group(1).lower()
        # Check if it's a valid column or alias
        if order_col not in all_valid_columns:
            # Check if it might be an alias defined in SELECT
            select_match = re.search(r'SELECT.*?FROM', sql, re.IGNORECASE | re.DOTALL)
            if select_match:
                select_clause = select_match.group(0).lower()
                # Check for "AS alias" pattern
                if f'as {order_col}' not in select_clause:
                    # It's not a column and not an alias
                    issues.append({
                        'code': 'INVALID_ORDER_COLUMN',
                        'severity': 'error',
                        'message': f"ORDER BY column '{order_col}' is not a valid column or alias",
                        'suggestion': f"Use a valid column name like 'revenue_millions' or define an alias in SELECT",
                        'wrong_column': order_col
                    })

    # Pattern 5: Detect column from wrong table in unqualified reference
    # If querying only companies table but using revenue-related columns
    if 'company_revenue' not in sql_lower:
        revenue_cols = ['revenue_millions', 'year']
        for col in revenue_cols:
            # Look for unqualified use (not preceded by r. or company_revenue)
            pattern = rf'(?<!r\.)\b{col}\b'
            if col == 'year' and re.search(pattern, sql_lower):
                # Check if it's in companies-only context
                if 'from companies' in sql_lower.replace('\n', ' '):
                    if 'join' not in sql_lower:
                        issues.append({
                            'code': 'WRONG_TABLE_COLUMN',
                            'severity': 'error',
                            'message': f"Column '{col}' belongs to 'company_revenue_annual', not 'companies'",
                            'suggestion': f"For companies table, use 'founding_year' instead of 'year'",
                            'wrong_column': col,
                            'wrong_table': 'companies',
                            'correct_table': 'company_revenue_annual'
                        })

    is_valid = not any(issue['severity'] == 'error' for issue in issues)

    if issues:
        logger.warning(f"Column validation found {len(issues)} issues")
        for issue in issues:
            logger.debug(f"  - {issue['code']}: {issue['message']}")

    return is_valid, issues


def format_column_issues(issues: List[Dict]) -> str:
    """Format column validation issues for repair prompt."""
    if not issues:
        return ""

    lines = ["## Column Validation Errors\n"]
    for issue in issues:
        lines.append(f"- **{issue['code']}**: {issue['message']}")
        if issue.get('suggestion'):
            lines.append(f"  - Fix: {issue['suggestion']}")
        if issue.get('wrong_column') and issue.get('correct_column'):
            lines.append(f"  - Replace `{issue['wrong_column']}` with `{issue['correct_column']}`")

    return '\n'.join(lines)


# Quick test
if __name__ == "__main__":
    from config import MCPTEST_SCHEMA

    test_cases = [
        # Q12 - year vs founding_year
        ("SELECT (year / 10) * 10 as decade, COUNT(*) FROM companies GROUP BY decade",
         "How many companies were founded in each decade?"),

        # Q20 - revenue vs revenue_millions
        ("SELECT c.name FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id ORDER BY revenue DESC",
         "What company had the highest revenue?"),

        # Valid query
        ("SELECT c.name, r.revenue_millions FROM companies c JOIN company_revenue_annual r ON c.company_id = r.company_id",
         "Show company revenues"),
    ]

    for sql, question in test_cases:
        print(f"\nSQL: {sql[:60]}...")
        valid, issues = validate_columns(sql, MCPTEST_SCHEMA, question)
        print(f"Valid: {valid}")
        if issues:
            for issue in issues:
                print(f"  - {issue['code']}: {issue['message']}")
