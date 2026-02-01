"""
Python AI Sidecar - FastAPI Server

Provides /generate_sql endpoint for NL2SQL conversion.
Handles AI logic only - no database credentials or execution.

Architecture:
- Stage 1: Keyword-based table filtering (keyword_filter.py)
- Stage 2: SQL generation via Ollama/Hrida (hrida_client.py)
- Returns: Generated SQL + confidence + metadata

Phase 1: Hardcoded MCPtest schema
Phase 2+: Dynamic schema from TypeScript
"""

import logging
import time
from typing import Optional, List, Dict, Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

from config import (
    MCPTEST_SCHEMA,
    build_hrida_prompt,
    build_repair_prompt,
    build_rag_prompt,
    build_rag_repair_prompt,
    HRIDA_BASE_PROMPT_VERSION
)
from hrida_client import HridaClient, HridaError, get_hrida_client, get_embedding
from keyword_filter import filter_tables, build_filtered_schema, classify_intent
from semantic_validator import validate_semantic_match, format_semantic_issues

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(
    title="NL2SQL Python Sidecar",
    description="AI-powered SQL generation via Ollama/Hrida",
    version="0.1.0"
)


# Request/Response Models (matching TypeScript interfaces)

class SchemaTable(BaseModel):
    """Table from RAG retrieval"""
    table_name: str
    table_schema: str
    module: str
    gloss: str
    m_schema: str
    similarity: float
    source: str  # "retrieval" or "fk_expansion"
    is_hub: Optional[bool] = None


class FKEdge(BaseModel):
    """FK relationship between tables"""
    from_table: str
    from_column: str
    to_table: str
    to_column: str


class SchemaContext(BaseModel):
    """Schema context from RAG retrieval"""
    query_id: str
    database_id: str
    question: str
    tables: List[SchemaTable]
    fk_edges: List[FKEdge]
    modules: List[str]


class NLQueryRequest(BaseModel):
    """Request from TypeScript MCP server"""
    question: str = Field(..., description="Natural language question")
    database_id: str = Field(..., description="Database identifier (e.g., 'mcptest')")
    user_id: Optional[str] = Field(None, description="User ID for logging")
    max_rows: Optional[int] = Field(100, description="Max rows to return")
    timeout_seconds: Optional[int] = Field(30, description="Query timeout")
    explain: Optional[bool] = Field(False, description="Include execution plan")
    trace: Optional[bool] = Field(False, description="Include trace info")
    schema_context: Optional[SchemaContext] = Field(None, description="RAG-retrieved schema context")


class ErrorResponse(BaseModel):
    """Error details"""
    type: str = Field(..., description="Error type: generation, validation, timeout")
    message: str = Field(..., description="Error message")
    recoverable: bool = Field(..., description="Can retry?")


class TraceInfo(BaseModel):
    """Trace information for debugging"""
    query_id: str
    stage_1_tables_selected: List[str]
    stage_1_duration_ms: int
    intent_classified: str
    hrida_prompt_length: int
    hrida_duration_ms: int
    total_duration_ms: int


class PythonSidecarResponse(BaseModel):
    """Response to TypeScript MCP server"""
    query_id: str = Field(..., description="Unique query ID")
    sql_generated: str = Field(..., description="Generated SQL query")
    confidence_score: float = Field(..., description="Confidence 0.0-1.0")
    tables_selected: List[str] = Field(..., description="Tables used in query")
    intent: str = Field(..., description="Query intent classification")
    notes: Optional[str] = Field(None, description="Generation notes")
    error: Optional[ErrorResponse] = Field(None, description="Error if failed")
    trace: Optional[TraceInfo] = Field(None, description="Debug trace info")


# Endpoints

@app.get("/health")
async def health_check():
    """
    Health check endpoint

    Checks:
    - FastAPI server is running
    - Ollama is reachable
    """
    hrida_client = get_hrida_client()
    ollama_healthy = hrida_client.health_check()

    return {
        "status": "healthy" if ollama_healthy else "degraded",
        "python_sidecar": "running",
        "ollama": "reachable" if ollama_healthy else "unreachable",
        "version": "0.2.0"
    }


class EmbedRequest(BaseModel):
    """Request for embedding generation"""
    text: str = Field(..., description="Text to embed")
    model: Optional[str] = Field("nomic-embed-text:latest", description="Embedding model")


class EmbedResponse(BaseModel):
    """Response with embedding vector"""
    embedding: List[float] = Field(..., description="Embedding vector")
    model: str = Field(..., description="Model used")
    dimensions: int = Field(..., description="Vector dimensions")


class BatchEmbedRequest(BaseModel):
    """Request for batch embedding generation"""
    texts: List[str] = Field(..., description="List of texts to embed")
    model: Optional[str] = Field("nomic-embed-text:latest", description="Embedding model")


class BatchEmbedResponse(BaseModel):
    """Response with batch embeddings"""
    embeddings: List[List[float]] = Field(..., description="List of embedding vectors")
    model: str = Field(..., description="Model used")
    dimensions: int = Field(..., description="Vector dimensions")
    count: int = Field(..., description="Number of embeddings generated")


@app.post("/embed", response_model=EmbedResponse)
async def embed_text(request: EmbedRequest) -> EmbedResponse:
    """
    Generate embedding for a single text

    Uses nomic-embed-text model via Ollama for 768-dim embeddings.

    Args:
        request: EmbedRequest with text to embed

    Returns:
        EmbedResponse with embedding vector
    """
    try:
        embedding = get_embedding(request.text, model=request.model)

        return EmbedResponse(
            embedding=embedding,
            model=request.model,
            dimensions=len(embedding)
        )

    except Exception as e:
        logger.error(f"Embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed_batch", response_model=BatchEmbedResponse)
async def embed_batch(request: BatchEmbedRequest) -> BatchEmbedResponse:
    """
    Generate embeddings for multiple texts

    Processes texts sequentially (Ollama doesn't support batch embedding natively).

    Args:
        request: BatchEmbedRequest with texts to embed

    Returns:
        BatchEmbedResponse with all embedding vectors
    """
    try:
        embeddings = []
        dimensions = 0

        for text in request.texts:
            embedding = get_embedding(text, model=request.model)
            embeddings.append(embedding)
            dimensions = len(embedding)

        return BatchEmbedResponse(
            embeddings=embeddings,
            model=request.model,
            dimensions=dimensions,
            count=len(embeddings)
        )

    except Exception as e:
        logger.error(f"Batch embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate_sql", response_model=PythonSidecarResponse)
async def generate_sql(request: NLQueryRequest) -> PythonSidecarResponse:
    """
    Generate SQL from natural language question

    Flow:
    1. Stage 1: Filter relevant tables using keyword matching
    2. Build Hrida prompt with filtered schema
    3. Call Ollama to generate SQL
    4. Return SQL + metadata

    Args:
        request: NLQueryRequest with question and options

    Returns:
        PythonSidecarResponse with SQL or error
    """
    query_id = str(uuid4())
    start_time = time.time()

    logger.info(f"[{query_id}] Generate SQL request: {request.question}")

    # Initialize trace if requested
    trace_data: Optional[Dict[str, Any]] = {} if request.trace else None

    try:
        # Check if we have RAG schema context
        use_rag = request.schema_context is not None

        if use_rag:
            # === RAG-BASED FLOW (Phase C+) ===
            schema_context = request.schema_context.dict()
            selected_tables = [t["table_name"] for t in schema_context.get("tables", [])]

            logger.info(f"[{query_id}] Using RAG schema context with {len(selected_tables)} tables")

            # Skip Stage 1 filtering - tables already selected by RAG
            stage1_duration_ms = 0

            # Classify intent
            intent = classify_intent(request.question)

            # Build prompt from RAG schema context
            prompt = build_rag_prompt(request.question, schema_context)

            # For semantic validation, build a compatible schema dict
            filtered_schema = {}
            for table in schema_context.get("tables", []):
                # Parse M-Schema to extract columns (simplified)
                m_schema = table.get("m_schema", "")
                # Extract column names from M-Schema format: table_name (col1 TYPE, col2 TYPE, ...)
                columns = []
                if "(" in m_schema and ")" in m_schema:
                    cols_part = m_schema.split("(", 1)[1].rsplit(")", 1)[0]
                    for col_def in cols_part.split(","):
                        col_name = col_def.strip().split()[0] if col_def.strip() else ""
                        if col_name:
                            columns.append(col_name)

                filtered_schema[table["table_name"]] = {
                    "columns": columns,
                    "description": table.get("gloss", ""),
                }
        else:
            # === LEGACY FLOW (MCPtest) ===
            if request.database_id != "mcptest":
                return PythonSidecarResponse(
                    query_id=query_id,
                    sql_generated="",
                    confidence_score=0.0,
                    tables_selected=[],
                    intent="",
                    error=ErrorResponse(
                        type="validation",
                        message=f"Unsupported database: {request.database_id}. Use schema_context for non-mcptest databases.",
                        recoverable=False
                    )
                )

            schema = MCPTEST_SCHEMA

            # Stage 1: Keyword-based table filtering
            stage1_start = time.time()
            selected_tables = filter_tables(request.question, schema)
            stage1_duration_ms = int((time.time() - stage1_start) * 1000)

            logger.debug(f"[{query_id}] Stage 1 selected tables: {selected_tables}")

            # Classify intent
            intent = classify_intent(request.question)
            logger.debug(f"[{query_id}] Intent classified as: {intent}")

            # Build filtered schema
            filtered_schema = build_filtered_schema(selected_tables, schema)

            # Build Hrida prompt
            prompt = build_hrida_prompt(request.question, filtered_schema)

        if trace_data is not None:
            trace_data["hrida_prompt_length"] = len(prompt)

        # Stage 2: Call Hrida to generate SQL
        hrida_start = time.time()
        hrida_client = get_hrida_client()

        try:
            sql, confidence = hrida_client.generate_sql(
                prompt=prompt,
                temperature=0.0,  # Deterministic
                max_tokens=200
            )
            hrida_duration_ms = int((time.time() - hrida_start) * 1000)

            logger.info(f"[{query_id}] SQL generated successfully, confidence: {confidence:.2f}")

            # Stage 3: Semantic validation
            semantic_valid, semantic_issues = validate_semantic_match(
                question=request.question,
                sql=sql,
                schema=filtered_schema
            )

            notes = None

            # If semantic errors found, attempt automatic repair
            if not semantic_valid:
                error_issues = [i for i in semantic_issues if i.get('severity') == 'error']
                logger.warning(f"[{query_id}] Semantic validation failed with {len(error_issues)} errors, attempting repair")

                # Build repair prompt with semantic issues
                repair_prompt = build_repair_prompt(
                    question=request.question,
                    previous_sql=sql,
                    schema=filtered_schema,
                    semantic_issues=semantic_issues,
                    allowed_tables=list(schema.keys())
                )

                try:
                    repaired_sql, repaired_confidence = hrida_client.generate_sql(
                        prompt=repair_prompt,
                        temperature=0.0,
                        max_tokens=200
                    )

                    # Re-validate after repair
                    repair_valid, repair_issues = validate_semantic_match(
                        question=request.question,
                        sql=repaired_sql,
                        schema=filtered_schema
                    )

                    if repair_valid or len([i for i in repair_issues if i.get('severity') == 'error']) < len(error_issues):
                        # Repair improved the SQL
                        sql = repaired_sql
                        confidence = max(0.6, repaired_confidence - 0.1)  # Lower confidence for repaired
                        notes = f"Auto-repaired semantic issues: {', '.join([i['code'] for i in error_issues])}"
                        logger.info(f"[{query_id}] Semantic repair successful")
                    else:
                        # Repair didn't help, return original with warning
                        notes = f"Semantic warnings (repair attempted): {', '.join([i['code'] for i in error_issues])}"
                        confidence = max(0.5, confidence - 0.2)
                        logger.warning(f"[{query_id}] Semantic repair did not improve SQL")

                except HridaError as repair_error:
                    logger.error(f"[{query_id}] Semantic repair failed: {repair_error}")
                    notes = f"Semantic issues detected but repair failed: {', '.join([i['code'] for i in error_issues])}"
                    confidence = max(0.4, confidence - 0.3)

            elif semantic_issues:
                # Only warnings, no errors
                notes = f"Semantic warnings: {', '.join([i['code'] for i in semantic_issues])}"

            # Build trace info if requested
            trace_info = None
            if trace_data is not None:
                total_duration_ms = int((time.time() - start_time) * 1000)
                trace_info = TraceInfo(
                    query_id=query_id,
                    stage_1_tables_selected=selected_tables,
                    stage_1_duration_ms=stage1_duration_ms,
                    intent_classified=intent,
                    hrida_prompt_length=trace_data["hrida_prompt_length"],
                    hrida_duration_ms=hrida_duration_ms,
                    total_duration_ms=total_duration_ms
                )

            return PythonSidecarResponse(
                query_id=query_id,
                sql_generated=sql,
                confidence_score=confidence,
                tables_selected=selected_tables,
                intent=intent,
                notes=notes,
                error=None,
                trace=trace_info
            )

        except HridaError as e:
            logger.error(f"[{query_id}] Hrida error: {str(e)}")
            return PythonSidecarResponse(
                query_id=query_id,
                sql_generated="",
                confidence_score=0.0,
                tables_selected=selected_tables,
                intent=intent,
                error=ErrorResponse(
                    type="generation",
                    message=str(e),
                    recoverable=True  # Can retry with different prompt
                )
            )

    except Exception as e:
        logger.error(f"[{query_id}] Unexpected error: {str(e)}", exc_info=True)
        return PythonSidecarResponse(
            query_id=query_id,
            sql_generated="",
            confidence_score=0.0,
            tables_selected=[],
            intent="",
            error=ErrorResponse(
                type="internal",
                message=f"Internal error: {str(e)}",
                recoverable=False
            )
        )


@app.post("/repair_sql", response_model=PythonSidecarResponse)
async def repair_sql(request: dict) -> PythonSidecarResponse:
    """
    Repair SQL based on validation or Postgres errors

    Flow:
    1. Receive previous failed SQL + error context
    2. Build repair prompt with base + delta blocks
    3. Call Ollama to generate corrected SQL
    4. Return corrected SQL + metadata

    Args:
        request: Dict with question, previous_sql, validator_issues, postgres_error, attempt

    Returns:
        PythonSidecarResponse with repaired SQL or error
    """
    query_id = str(uuid4())
    start_time = time.time()

    question = request.get("question")
    database_id = request.get("database_id", "mcptest")
    previous_sql = request.get("previous_sql")
    attempt = request.get("attempt", 1)
    max_attempts = request.get("max_attempts", 3)
    validator_issues = request.get("validator_issues", [])
    postgres_error = request.get("postgres_error")
    semantic_issues = request.get("semantic_issues", [])
    schema_context = request.get("schema_context")

    logger.info(f"[{query_id}] Repair SQL request (attempt {attempt}/{max_attempts}): {question}")

    # Initialize trace if requested
    trace_data: Optional[Dict[str, Any]] = {} if request.get("trace") else None

    try:
        # Check if we have RAG schema context
        use_rag = schema_context is not None

        if use_rag:
            # === RAG-BASED REPAIR ===
            selected_tables = [t["table_name"] for t in schema_context.get("tables", [])]

            logger.info(f"[{query_id}] Using RAG schema context for repair with {len(selected_tables)} tables")

            # Classify intent
            intent = classify_intent(question)

            # Build repair prompt from RAG schema context
            prompt = build_rag_repair_prompt(
                question=question,
                previous_sql=previous_sql,
                schema_context=schema_context,
                validator_issues=validator_issues,
                postgres_error=postgres_error,
                semantic_issues=semantic_issues
            )
        else:
            # === LEGACY REPAIR (MCPtest) ===
            if database_id != "mcptest":
                return PythonSidecarResponse(
                    query_id=query_id,
                    sql_generated="",
                    confidence_score=0.0,
                    tables_selected=[],
                    intent="",
                    error=ErrorResponse(
                        type="validation",
                        message=f"Unsupported database: {database_id}",
                        recoverable=False
                    )
                )

            schema = MCPTEST_SCHEMA

            # Stage 1: Extract tables from previous SQL (best effort)
            # Or re-run keyword filter
            selected_tables = filter_tables(question, schema)

            # Classify intent
            intent = classify_intent(question)

            # Build filtered schema
            filtered_schema = build_filtered_schema(selected_tables, schema)

            # Build repair prompt with delta blocks
            allowed_tables = list(schema.keys())
            prompt = build_repair_prompt(
                question=question,
                previous_sql=previous_sql,
                schema=filtered_schema,
                validator_issues=validator_issues,
                postgres_error=postgres_error,
                semantic_issues=semantic_issues,
                allowed_tables=allowed_tables
            )

        if trace_data is not None:
            trace_data["repair_prompt_length"] = len(prompt)
            trace_data["validator_issues_count"] = len(validator_issues)
            trace_data["semantic_issues_count"] = len(semantic_issues)
            trace_data["has_postgres_error"] = postgres_error is not None

        # Stage 2: Call Hrida to generate repaired SQL
        hrida_start = time.time()
        hrida_client = get_hrida_client()

        try:
            sql, confidence = hrida_client.generate_sql(
                prompt=prompt,
                temperature=0.0,  # Deterministic
                max_tokens=200
            )
            hrida_duration_ms = int((time.time() - hrida_start) * 1000)

            # Lower confidence for repaired SQL
            confidence = max(0.5, confidence - 0.1 * attempt)

            logger.info(f"[{query_id}] SQL repaired successfully, confidence: {confidence:.2f}, attempt: {attempt}")

            # Build trace info if requested
            trace_info = None
            if trace_data is not None:
                total_duration_ms = int((time.time() - start_time) * 1000)
                trace_info = TraceInfo(
                    query_id=query_id,
                    stage_1_tables_selected=selected_tables,
                    stage_1_duration_ms=0,  # Reused from previous attempt
                    intent_classified=intent,
                    hrida_prompt_length=trace_data["repair_prompt_length"],
                    hrida_duration_ms=hrida_duration_ms,
                    total_duration_ms=total_duration_ms
                )

            # Determine what changed
            changes_made = []
            if semantic_issues:
                changes_made.append(f"Fixed {len(semantic_issues)} semantic issue(s)")
            if validator_issues:
                changes_made.append(f"Fixed {len(validator_issues)} validation issue(s)")
            if postgres_error:
                changes_made.append(f"Addressed PostgreSQL error {postgres_error.get('sqlstate', 'Unknown')}")

            notes = f"Repaired SQL (attempt {attempt}/{max_attempts}). Changes: {', '.join(changes_made) if changes_made else 'Regenerated query'}"

            return PythonSidecarResponse(
                query_id=query_id,
                sql_generated=sql,
                confidence_score=confidence,
                tables_selected=selected_tables,
                intent=intent,
                notes=notes,
                error=None,
                trace=trace_info
            )

        except HridaError as e:
            logger.error(f"[{query_id}] Hrida repair error: {str(e)}")
            return PythonSidecarResponse(
                query_id=query_id,
                sql_generated="",
                confidence_score=0.0,
                tables_selected=selected_tables,
                intent=intent,
                notes=f"Repair attempt {attempt} failed",
                error=ErrorResponse(
                    type="generation",
                    message=str(e),
                    recoverable=attempt < max_attempts
                )
            )

    except Exception as e:
        logger.error(f"[{query_id}] Unexpected repair error: {str(e)}", exc_info=True)
        return PythonSidecarResponse(
            query_id=query_id,
            sql_generated="",
            confidence_score=0.0,
            tables_selected=[],
            intent="",
            error=ErrorResponse(
                type="internal",
                message=f"Internal error: {str(e)}",
                recoverable=False
            )
        )


@app.post("/invalidate_cache")
async def invalidate_cache(database_id: str):
    """
    Invalidate schema cache for a database

    Phase 1: Stub (no caching yet)
    Phase 2+: Will invalidate in-memory schema cache

    Args:
        database_id: Database to invalidate cache for

    Returns:
        Success message
    """
    logger.info(f"Cache invalidation requested for {database_id} (Phase 1: no-op)")
    return {
        "status": "success",
        "message": "Phase 1: No caching implemented yet",
        "database_id": database_id
    }


# Startup

if __name__ == "__main__":
    import os

    port = int(os.getenv("PORT", "8001"))

    logger.info(f"Starting Python AI Sidecar on port {port}")
    logger.info(f"Ollama URL: {os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')}")
    logger.info(f"Ollama Model: {os.getenv('OLLAMA_MODEL', 'HridaAI/hrida-t2sql:v1.2.3')}")

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        reload=False  # Set to True for development
    )
