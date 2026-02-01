"""
Semantic Validator for NL2SQL

Validates that generated SQL actually addresses the entities and intent
mentioned in the natural language question.

This catches cases where the model:
- Ignores company names mentioned in the question
- Uses hardcoded values from prompt examples instead of question values
- Misunderstands the query intent (e.g., SELECT name when asked for state)
"""

import re
import logging
from typing import List, Dict, Tuple, Optional

logger = logging.getLogger(__name__)


def extract_company_names(text: str) -> List[str]:
    """
    Extract potential company names from text.

    Looks for:
    - Multi-word capitalized phrases
    - Names ending in LLC, Inc, Corp, etc.
    - Quoted strings
    """
    companies = []

    # Pattern 1: Quoted strings (highest confidence)
    quoted = re.findall(r"['\"]([^'\"]+)['\"]", text)
    companies.extend(quoted)

    # Pattern 2: Multi-word proper nouns with business suffixes
    # e.g., "Titan Financial Services", "Gateway Distribution LLC"
    suffixes = (
        'LLC|Inc|Corp|Co|Ltd|Services|Systems|Technologies|Solutions|'
        'Group|Partners|Holdings|Enterprises|Industries|International|'
        'Medical|Financial|Energy|Distribution|Logistics|Manufacturing|'
        'Consulting|Analytics|Software|Networks|Communications|Healthcare'
    )
    suffix_pattern = rf'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:{suffixes})))\b'

    suffix_matches = re.findall(suffix_pattern, text)
    companies.extend(suffix_matches)

    # Pattern 3: Any multi-word capitalized phrase (lower confidence)
    # e.g., "Titan Financial Services" without suffix
    general_pattern = r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})\b'
    general_matches = re.findall(general_pattern, text)

    # Filter out common phrases that aren't company names
    common_phrases = {
        'New York', 'Los Angeles', 'San Francisco', 'San Diego', 'San Jose',
        'Las Vegas', 'Salt Lake', 'Kansas City', 'New Orleans', 'New Jersey',
        'North Carolina', 'South Carolina', 'North Dakota', 'South Dakota',
        'West Virginia', 'Rhode Island', 'New Hampshire', 'New Mexico',
        'United States', 'How Many', 'Show Me', 'Tell Me', 'What Is',
        'Which State', 'What Company', 'Find All', 'List All', 'Get All',
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
        'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
    }

    for match in general_matches:
        if match not in common_phrases and len(match) > 5:
            companies.append(match)

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for c in companies:
        if c.lower() not in seen:
            seen.add(c.lower())
            unique.append(c)

    return unique


def extract_state_codes(text: str) -> List[str]:
    """Extract US state codes from text."""
    # Two-letter state codes
    state_pattern = r'\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b'
    return re.findall(state_pattern, text, re.IGNORECASE)


def extract_years(text: str) -> List[int]:
    """Extract years from text (2000-2030 range)."""
    year_pattern = r'\b(20[0-3][0-9])\b'
    matches = re.findall(year_pattern, text)
    return [int(y) for y in matches]


def classify_query_intent(question: str) -> str:
    """
    Classify the intent of the question.

    Returns one of:
    - lookup_by_name: Looking up info about a specific entity
    - lookup_state: Asking what state something is in
    - count: Counting entities
    - list: Listing entities
    - aggregate: Sum, avg, min, max
    - compare: Comparing values
    - rank: Top/bottom N
    - general: Other
    """
    q = question.lower()

    # Check for specific patterns
    if re.search(r'which state|what state|where is .* located', q):
        return 'lookup_state'

    if re.search(r'how many|count|number of|total (?:number|count)', q):
        return 'count'

    if re.search(r'top \d+|bottom \d+|highest|lowest|most|least|best|worst', q):
        return 'rank'

    if re.search(r'compare|difference|between .* and|vs\.?|versus', q):
        return 'compare'

    if re.search(r'average|avg|sum|total|mean|median', q):
        return 'aggregate'

    if re.search(r'show|list|display|get|find|all', q):
        return 'list'

    # Check if question mentions a specific company name
    companies = extract_company_names(question)
    if companies:
        return 'lookup_by_name'

    return 'general'


def validate_semantic_match(
    question: str,
    sql: str,
    schema: Optional[Dict] = None
) -> Tuple[bool, List[Dict]]:
    """
    Validate that the SQL semantically matches the question.

    Args:
        question: The natural language question
        sql: The generated SQL
        schema: Optional schema dict for column validation

    Returns:
        Tuple of (is_valid, list of issues)
    """
    issues = []
    sql_upper = sql.upper()

    # 1. Check company names
    companies = extract_company_names(question)
    for company in companies:
        # Check if company name appears in SQL (in quotes)
        if f"'{company}'" not in sql and f'"{company}"' not in sql:
            # Also check case-insensitive
            if company.lower() not in sql.lower():
                issues.append({
                    'code': 'MISSING_ENTITY',
                    'severity': 'error',
                    'message': f"Question mentions '{company}' but SQL doesn't reference it",
                    'suggestion': f"Add WHERE name = '{company}' or similar filter",
                    'entity': company,
                    'entity_type': 'company'
                })

    # 2. Check query intent alignment
    intent = classify_query_intent(question)

    if intent == 'lookup_state':
        # Should be selecting state column
        if 'STATE' not in sql_upper or ('SELECT' in sql_upper and 'STATE' not in sql_upper.split('FROM')[0]):
            # Check if state is in SELECT clause
            select_clause = sql_upper.split('FROM')[0] if 'FROM' in sql_upper else sql_upper
            if 'STATE' not in select_clause and 'C.STATE' not in select_clause:
                issues.append({
                    'code': 'WRONG_SELECT',
                    'severity': 'warning',
                    'message': "Question asks 'which state' but SQL doesn't SELECT state",
                    'suggestion': "SELECT state FROM companies WHERE ...",
                    'expected_column': 'state'
                })

    if intent == 'count':
        if 'COUNT(' not in sql_upper:
            issues.append({
                'code': 'MISSING_AGGREGATION',
                'severity': 'warning',
                'message': "Question asks 'how many' but SQL doesn't use COUNT()",
                'suggestion': "Use SELECT COUNT(*) FROM ..."
            })

    # 3. Check for hardcoded values that don't appear in question
    # Look for state codes in SQL that weren't in the question
    sql_states = extract_state_codes(sql)
    question_states = extract_state_codes(question)

    # Also check for state names in question
    state_names = {
        'california': 'CA', 'texas': 'TX', 'new york': 'NY', 'florida': 'FL',
        'ohio': 'OH', 'illinois': 'IL', 'michigan': 'MI', 'pennsylvania': 'PA',
        'georgia': 'GA', 'missouri': 'MO', 'indiana': 'IN', 'kentucky': 'KY',
        'maryland': 'MD', 'vermont': 'VT'
    }

    for name, code in state_names.items():
        if name in question.lower():
            question_states.append(code)

    for state in sql_states:
        state_upper = state.upper()
        if state_upper not in [s.upper() for s in question_states]:
            # Check if state appears as a literal in WHERE clause (potential hallucination)
            if f"= '{state_upper}'" in sql.upper() or f"= '{state}'" in sql:
                issues.append({
                    'code': 'HALLUCINATED_VALUE',
                    'severity': 'error',
                    'message': f"SQL filters by state '{state_upper}' but question doesn't mention this state",
                    'suggestion': "Remove hardcoded state filter or use correct state from question",
                    'hallucinated_value': state_upper
                })

    # 4. Check years
    sql_years = extract_years(sql)
    question_years = extract_years(question)

    for year in sql_years:
        if year not in question_years and question_years:
            # Only flag if question mentions specific years
            issues.append({
                'code': 'WRONG_YEAR',
                'severity': 'warning',
                'message': f"SQL uses year {year} but question mentions {question_years}",
                'suggestion': f"Use year(s) from question: {question_years}"
            })

    is_valid = not any(issue['severity'] == 'error' for issue in issues)

    if issues:
        logger.warning(f"Semantic validation found {len(issues)} issues")
        for issue in issues:
            logger.debug(f"  - {issue['code']}: {issue['message']}")

    return is_valid, issues


def format_semantic_issues(issues: List[Dict]) -> str:
    """Format semantic issues for repair prompt."""
    if not issues:
        return "No semantic issues found."

    lines = []
    for issue in issues:
        severity = issue.get('severity', 'error')
        emoji = {'error': '❌', 'warning': '⚠️', 'info': 'ℹ️'}.get(severity, '•')

        lines.append(f"{emoji} **{issue['code']}**: {issue['message']}")
        if issue.get('suggestion'):
            lines.append(f"   → {issue['suggestion']}")
        if issue.get('entity'):
            lines.append(f"   Entity: '{issue['entity']}'")

    return '\n'.join(lines)
