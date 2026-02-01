"""
Keyword Filter - Stage 1 Table Selection

Simple keyword-based table filtering for MVP.
Extracts entities from NL question and matches against table/column names.

Phase 4 will add:
- Stage 2: Semantic ranking with embeddings
- Stage 3: Relationship expansion with FK graph
"""

import logging
from typing import List, Set

from config import TABLE_KEYWORDS, COLUMN_KEYWORDS, MCPTEST_SCHEMA

logger = logging.getLogger(__name__)


def extract_keywords(question: str) -> Set[str]:
    """
    Extract keywords from natural language question

    Args:
        question: Natural language question

    Returns:
        Set of lowercase keywords
    """
    # Convert to lowercase
    text = question.lower()

    # Split on whitespace and punctuation
    import re
    words = re.findall(r'\b\w+\b', text)

    return set(words)


def filter_tables(question: str, schema: dict = None) -> List[str]:
    """
    Stage 1: Keyword-based table filtering

    Extracts keywords from question and matches against:
    - Table names
    - Table descriptions
    - Column names

    Args:
        question: Natural language question
        schema: Database schema (if None, uses MCPTEST_SCHEMA)

    Returns:
        List of selected table names (ordered by relevance score)
    """
    if schema is None:
        schema = MCPTEST_SCHEMA

    logger.debug(f"Filtering tables for question: {question}")

    # Extract keywords from question
    question_keywords = extract_keywords(question)

    logger.debug(f"Extracted keywords: {question_keywords}")

    # Score each table
    table_scores = {}

    for table_name, table_info in schema.items():
        score = 0

        # Match against table keywords
        if table_name in TABLE_KEYWORDS:
            table_kws = TABLE_KEYWORDS[table_name]
            matches = question_keywords.intersection(set(table_kws))
            score += len(matches) * 2  # Weight table name matches heavily

        # Match against column keywords
        if table_name in COLUMN_KEYWORDS:
            for col_name, col_kws in COLUMN_KEYWORDS[table_name].items():
                matches = question_keywords.intersection(set(col_kws))
                score += len(matches)  # Weight column matches

        # Match against table name itself (exact or partial)
        table_name_lower = table_name.lower()
        for keyword in question_keywords:
            if keyword in table_name_lower or table_name_lower in keyword:
                score += 3

        # Match against description
        description_lower = table_info.get("description", "").lower()
        for keyword in question_keywords:
            if keyword in description_lower:
                score += 0.5

        table_scores[table_name] = score

    logger.debug(f"Table scores: {table_scores}")

    # Sort by score (descending)
    sorted_tables = sorted(
        table_scores.items(),
        key=lambda x: x[1],
        reverse=True
    )

    # Filter tables with score > 0
    selected_tables = [table for table, score in sorted_tables if score > 0]

    # If no tables selected, include all tables (better than nothing)
    if len(selected_tables) == 0:
        logger.warning("No tables matched keywords, including all tables")
        selected_tables = list(schema.keys())

    logger.info(f"Selected tables: {selected_tables}")

    return selected_tables


def build_filtered_schema(selected_tables: List[str], schema: dict = None) -> dict:
    """
    Build schema dict with only selected tables

    Args:
        selected_tables: List of table names to include
        schema: Full schema (if None, uses MCPTEST_SCHEMA)

    Returns:
        Filtered schema dict
    """
    if schema is None:
        schema = MCPTEST_SCHEMA

    filtered = {}

    for table_name in selected_tables:
        if table_name in schema:
            filtered[table_name] = schema[table_name]

    return filtered


def classify_intent(question: str) -> str:
    """
    Classify the intent of the question

    Returns one of:
    - "count": Counting queries
    - "list": Show/list queries
    - "aggregate": AVG, SUM, MAX, MIN
    - "compare": Comparison queries
    - "trend": Time-series queries
    - "detail": Specific information queries

    This helps with Stage 1 filtering and can guide SQL generation.
    """
    question_lower = question.lower()

    from config import QUERY_PATTERNS

    for intent, keywords in QUERY_PATTERNS.items():
        for keyword in keywords:
            if keyword in question_lower:
                return intent

    # Default to "list" if no clear intent
    return "list"
