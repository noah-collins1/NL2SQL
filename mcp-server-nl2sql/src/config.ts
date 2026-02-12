/**
 * Configuration for NL2SQL MCP Server
 *
 * Includes types, constants, and configuration for:
 * - Python sidecar connection
 * - Database constraints (allowed tables, limits)
 * - Request/response interfaces
 */

/**
 * Database Configuration
 *
 * Supports multiple databases:
 * - mcptest: Simple 2-table test database (hardcoded schema)
 * - enterprise_erp: 86-table ERP database (RAG-based schema retrieval)
 */

/**
 * MCPtest Database Configuration (MVP Phase 1)
 *
 * Hardcoded for MCPtest database.
 */
export const MCPTEST_CONFIG = {
	databaseId: "mcptest",
	allowedTables: ["companies", "company_revenue_annual"],
	maxLimit: 1000,
	requireLimit: true,
	useSchemaRAG: false,
}

/**
 * Enterprise ERP Database Configuration (Phase C+)
 *
 * Uses Schema RAG for table selection from 86-table database.
 */
export const ENTERPRISE_ERP_CONFIG = {
	databaseId: "enterprise_erp",
	maxLimit: 1000,
	requireLimit: true,
	useSchemaRAG: true,
	ragConfig: {
		topK: 15,
		threshold: 0.25,
		maxTables: 10,
		fkExpansionLimit: 3,
		hubFKCap: 5,
	},
}

/**
 * Active database configuration
 *
 * Set via ACTIVE_DATABASE env var or defaults to enterprise_erp
 */
export const ACTIVE_DATABASE = process.env.ACTIVE_DATABASE || "enterprise_erp"

/**
 * Schema RAG version toggle
 *
 * Set USE_SCHEMA_RAG_V2=true to enable dual retrieval + score fusion
 * Default: false (use V1 for stability until V2 is validated)
 */
export const USE_SCHEMA_RAG_V2 = process.env.USE_SCHEMA_RAG_V2 === "true"

/**
 * Exam mode toggle
 *
 * Set EXAM_MODE=true to enable detailed diagnostic logging
 */
export const EXAM_MODE = process.env.EXAM_MODE === "true"

/**
 * Pipeline upgrade feature flags (Phase 1/2/3)
 *
 * Schema glosses, schema linker, join planner, PG normalization, and candidate reranker
 * are all enabled by default (except reranker which is opt-in).
 */
export { SCHEMA_GLOSSES_ENABLED } from "./schema_glosses.js"
export { SCHEMA_LINKER_ENABLED } from "./schema_linker.js"
export {
	JOIN_PLANNER_ENABLED,
	JOIN_PLANNER_TOP_K,
	FK_SUBGRAPH_CACHE_ENABLED,
	DYNAMIC_HUB_CAP_ENABLED,
	JOIN_PATH_SCORING_ENABLED,
	CROSS_MODULE_JOIN_ENABLED,
} from "./join_planner.js"
export { PG_NORMALIZE_ENABLED } from "./pg_normalize.js"
export { CANDIDATE_RERANKER_ENABLED, VALUE_VERIFICATION_ENABLED } from "./candidate_reranker.js"
export { PRE_SQL_ENABLED } from "./pre_sql.js"
export { BM25_SEARCH_ENABLED } from "./bm25_search.js"
export { MODULE_ROUTER_ENABLED } from "./module_router.js"
export { COLUMN_PRUNING_ENABLED } from "./column_pruner.js"

/**
 * Join hint format toggle
 *
 * Set JOIN_HINT_FORMAT to control how join hints are rendered:
 * - "edges": FK edges only (default)
 * - "paths": Suggested join paths (e.g., A -> B -> C)
 * - "both": Both edges and paths
 * - "none": No join hints
 */
export type JoinHintFormat = "edges" | "paths" | "both" | "none"
export const JOIN_HINT_FORMAT: JoinHintFormat = (process.env.JOIN_HINT_FORMAT as JoinHintFormat) || "edges"

/**
 * Get database config by ID
 */
export function getDatabaseConfig(databaseId: string): typeof MCPTEST_CONFIG | typeof ENTERPRISE_ERP_CONFIG {
	switch (databaseId) {
		case "mcptest":
			return MCPTEST_CONFIG
		case "enterprise_erp":
			return ENTERPRISE_ERP_CONFIG
		default:
			// Default to ERP for unknown databases
			return ENTERPRISE_ERP_CONFIG
	}
}

/**
 * Check if database uses Schema RAG
 */
export function usesSchemaRAG(databaseId: string): boolean {
	const config = getDatabaseConfig(databaseId)
	return "useSchemaRAG" in config && config.useSchemaRAG === true
}

/**
 * Python Sidecar Configuration
 */
export const PYTHON_SIDECAR_CONFIG = {
	baseUrl: process.env.PYTHON_SIDECAR_URL || "http://localhost:8001",
	timeout: 30000, // 30 seconds
	endpoints: {
		generateSQL: "/generate_sql",
		repairSQL: "/repair_sql",
		invalidateCache: "/invalidate_cache",
		health: "/health",
	},
}

/**
 * Request to Python Sidecar for SQL generation
 */
export interface NLQueryRequest {
	/** Natural language question */
	question: string

	/** Database identifier (for multi-DB support in Phase 2) */
	database_id: string

	/** Optional: User ID for audit logging (Phase 5) */
	user_id?: string

	/** Optional: Session ID for follow-up questions (Phase 4) */
	session_id?: string

	/** Optional: Previous query ID for context (Phase 4) */
	previous_query_id?: string

	/** Optional: Table hints to help filtering (Phase 3) */
	table_hints?: string[]

	/** Optional: Domain hint (finance, hr, operations) (Phase 3) */
	domain_hint?: string

	/** Schema context from RAG retrieval (Phase C+) */
	schema_context?: {
		query_id: string
		database_id: string
		question: string
		tables: Array<{
			table_name: string
			table_schema: string
			module: string
			gloss: string
			m_schema: string
			similarity: number
			source: "retrieval" | "fk_expansion" | "bm25" | "hybrid"
			is_hub?: boolean
		}>
		fk_edges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>
		modules: string[]
	}

	/** Constraints */
	max_rows?: number // Default 100
	timeout_seconds?: number // Default 30
	read_only?: boolean // Default true

	/** Debugging */
	explain?: boolean
	trace?: boolean

	/** Multi-candidate generation */
	multi_candidate_k?: number
	multi_candidate_delimiter?: string

	/** Pre-formatted schema link section for prompt (Phase 1) */
	schema_link_text?: string

	/** Pre-formatted join plan section for prompt (Phase 2) */
	join_plan_text?: string
}

/**
 * Response from Python Sidecar
 */
export interface PythonSidecarResponse {
	/** Unique query ID for tracking */
	query_id: string

	/** Original question */
	question: string

	/** Database ID */
	database_id: string

	/** Generated SQL */
	sql_generated: string

	/** Whether SQL passed Python-side validation */
	sql_valid: boolean

	/** Validation errors (if any) */
	validation_errors?: string[]

	/** Confidence score (0.0-1.0) */
	confidence_score: number

	/** Optional notes or warnings */
	notes?: string

	/** Tables selected during filtering (Stage 1) */
	tables_selected: string[]

	/** Tables actually used in final SQL */
	tables_used_in_sql: string[]

	/** Trace information (if requested) */
	trace?: {
		stage1_tables: string[]
		stage2_tables?: string[]
		stage3_tables?: string[]
		hrida_latency_ms: number
		total_latency_ms: number
		multi_candidate_k?: number
	}

	/** Error information */
	error?: {
		type: "generation" | "validation" | "timeout"
		message: string
		recoverable: boolean
	}

	/** Multi-candidate SQL responses */
	sql_candidates?: string[]

	/** Raw multi-candidate output for downstream parsing */
	sql_candidates_raw?: string

	/** Token counts from Ollama (for prompt cost tracking) */
	prompt_tokens?: number
	completion_tokens?: number
}

/**
 * Request to Python Sidecar for SQL repair
 */
export interface RepairSQLRequest {
	/** Original natural language question */
	question: string

	/** Database identifier */
	database_id: string

	/** Previous SQL that failed */
	previous_sql: string

	/** Current attempt number (1-based) */
	attempt: number

	/** Maximum attempts allowed */
	max_attempts: number

	/** Validation issues from TypeScript validator */
	validator_issues?: ValidatorIssue[]

	/** PostgreSQL error context (if execution failed) */
	postgres_error?: PostgresErrorContext

	/** Semantic issues from Python semantic validator */
	semantic_issues?: SemanticIssue[]

	/** Schema context from RAG retrieval (stateless - same across retries) */
	schema_context?: {
		query_id: string
		database_id: string
		question: string
		tables: Array<{
			table_name: string
			table_schema: string
			module: string
			gloss: string
			m_schema: string
			similarity: number
			source: "retrieval" | "fk_expansion" | "bm25" | "hybrid"
			is_hub?: boolean
		}>
		fk_edges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>
		modules: string[]
	}

	/** Include trace info */
	trace?: boolean

	/** Pre-formatted schema link section for prompt (Phase 1) */
	schema_link_text?: string

	/** Pre-formatted join plan section for prompt (Phase 2) */
	join_plan_text?: string
}

/**
 * Validator issue for repair request
 */
export interface ValidatorIssue {
	code: string
	severity: "error" | "warning" | "info"
	message: string
	suggestion?: string
}

/**
 * Semantic issue from Python validator
 */
export interface SemanticIssue {
	code: string
	severity: "error" | "warning" | "info"
	message: string
	suggestion?: string
	entity?: string
	entity_type?: string
}

/**
 * Column candidate for error-driven suggestions (V2)
 */
export interface ColumnCandidateInfo {
	table_name: string
	column_name: string
	data_type: string
	gloss: string
	match_type: "exact" | "fuzzy" | "embedding"
	match_score: number
}

/**
 * Minimal whitelist for targeted 42703 repair
 */
export interface MinimalWhitelistInfo {
	/** The alias used in the failing reference (e.g., "p") */
	alias: string | null
	/** The resolved table name (e.g., "projects") */
	resolved_table: string | null
	/** The column that failed (e.g., "project_id") */
	failing_column: string | null
	/** Whitelist: only columns for the resolved table and FK neighbors */
	whitelist: Record<string, string[]>
	/** FK neighbor tables included */
	neighbor_tables?: string[]
	/** Pre-formatted text for repair prompt */
	formatted_text?: string
}

/**
 * PostgreSQL error context for repair
 */
export interface PostgresErrorContext {
	sqlstate: string
	message: string
	hint?: string
	detail?: string
	position?: number

	// Column candidates (for 42703 errors, V2 only)
	undefined_column?: string
	column_candidates?: ColumnCandidateInfo[]

	// Minimal whitelist for 42703 repairs (only relevant table + FK neighbors)
	minimal_whitelist?: MinimalWhitelistInfo
}

/**
 * Execution error classification type
 *
 * Used to distinguish different error types for retry gating and logging:
 * - infra_failure: Connection, pool, resource errors (never retry)
 * - query_timeout: Query canceled due to statement_timeout (may retry with simpler query)
 * - validation_block: Security/validation failure (never retry)
 * - sql_error: SQL syntax/semantic error (retry with repair)
 * - unknown: Unclassified error (log for investigation)
 */
export type ExecutionErrorClass =
	| "infra_failure"
	| "query_timeout"
	| "validation_block"
	| "sql_error"
	| "unknown"

/**
 * SQLSTATE classification for error handling
 */
export const SQLSTATE_CLASSIFICATION = {
	// Infrastructure errors: Never retry - these are system/connection issues
	infrastructure: [
		"08", // Connection exception (08000, 08003, 08006, etc.)
		"53", // Insufficient resources (53100, 53200, 53300)
		"54", // Program limit exceeded (54000, 54001, 54011, 54023)
		"58", // System error (58000, 58030)
		"F0", // Config file error
		"XX", // Internal error
	],

	// Fail-fast: Never retry - security/permission issues
	failFast: [
		"08", // Connection exception
		"0A", // Feature not supported
		"42501", // Insufficient privilege
		"53", // Insufficient resources
		"54", // Program limit exceeded
		"58", // System error
		"F0", // Config file error
		"XX", // Internal error
	],

	// Timeout errors: May retry with simpler query
	timeout: [
		"57014", // Query canceled (statement_timeout)
		"57P01", // Admin shutdown
		"57P02", // Crash shutdown
		"57P03", // Cannot connect now
	],

	// Repairable: Can retry with model feedback
	repairable: [
		"42601", // Syntax error
		"42P01", // Undefined table
		"42703", // Undefined column
		"42P09", // Ambiguous column
		"42P10", // Invalid column reference
		"42804", // Datatype mismatch
		"42883", // Undefined function
		"22", // Data exception (e.g., division by zero)
		"42803", // Grouping error
	],
}

/**
 * Check if SQLSTATE is a fail-fast error
 */
export function isFailFastError(sqlstate: string): boolean {
	// Check exact match first (e.g., 42501)
	if (SQLSTATE_CLASSIFICATION.failFast.includes(sqlstate)) {
		return true
	}
	// Check prefix match (e.g., 08xxx, 53xxx)
	return SQLSTATE_CLASSIFICATION.failFast.some(
		(prefix) => prefix.length === 2 && sqlstate.startsWith(prefix)
	)
}

/**
 * Check if SQLSTATE is an infrastructure error (connection, pool, resource)
 */
export function isInfrastructureError(sqlstate: string): boolean {
	// Check exact match first
	if (SQLSTATE_CLASSIFICATION.infrastructure.includes(sqlstate)) {
		return true
	}
	// Check prefix match
	return SQLSTATE_CLASSIFICATION.infrastructure.some(
		(prefix) => prefix.length === 2 && sqlstate.startsWith(prefix)
	)
}

/**
 * Check if SQLSTATE is a timeout error
 */
export function isTimeoutError(sqlstate: string): boolean {
	return SQLSTATE_CLASSIFICATION.timeout.includes(sqlstate)
}

/**
 * Check if SQLSTATE is a repairable error
 */
export function isRepairableError(sqlstate: string): boolean {
	// Check exact match first
	if (SQLSTATE_CLASSIFICATION.repairable.includes(sqlstate)) {
		return true
	}
	// Check prefix match
	return SQLSTATE_CLASSIFICATION.repairable.some(
		(prefix) => prefix.length === 2 && sqlstate.startsWith(prefix)
	)
}

/**
 * Classify execution error for logging and retry gating
 *
 * @param sqlstate - PostgreSQL SQLSTATE code
 * @param message - Error message (for additional context)
 * @param isValidationFailure - True if this came from validator (not Postgres)
 * @returns Structured error classification
 */
export function classifyExecutionError(
	sqlstate: string,
	message?: string,
	isValidationFailure: boolean = false,
): { errorClass: ExecutionErrorClass; shouldRetry: boolean; reason: string } {
	// Validation block - never retry
	if (isValidationFailure) {
		return {
			errorClass: "validation_block",
			shouldRetry: false,
			reason: "Security or validation violation",
		}
	}

	// Infrastructure errors - never retry (system/connection issues)
	if (isInfrastructureError(sqlstate)) {
		const reason = getInfrastructureErrorReason(sqlstate)
		return {
			errorClass: "infra_failure",
			shouldRetry: false,
			reason,
		}
	}

	// Timeout errors - may retry with simpler query (but count against max attempts)
	if (isTimeoutError(sqlstate)) {
		return {
			errorClass: "query_timeout",
			shouldRetry: true, // Allow retry, but LLM should simplify
			reason: sqlstate === "57014" ? "Query canceled (statement_timeout)" : "Server shutdown or unavailable",
		}
	}

	// SQL errors - repairable with model feedback
	if (isRepairableError(sqlstate)) {
		return {
			errorClass: "sql_error",
			shouldRetry: true,
			reason: getSQLSTATEHint(sqlstate),
		}
	}

	// Other fail-fast errors (permissions, etc.)
	if (isFailFastError(sqlstate)) {
		return {
			errorClass: "validation_block",
			shouldRetry: false,
			reason: "Permission denied or feature not supported",
		}
	}

	// Unknown - log for investigation, don't retry
	return {
		errorClass: "unknown",
		shouldRetry: false,
		reason: `Unclassified error ${sqlstate}: ${message || "unknown"}`,
	}
}

/**
 * Get human-readable reason for infrastructure error
 */
function getInfrastructureErrorReason(sqlstate: string): string {
	const reasons: Record<string, string> = {
		"08000": "Connection error",
		"08003": "Connection does not exist",
		"08006": "Connection failure",
		"08001": "Unable to establish connection",
		"08004": "Server rejected connection",
		"53000": "Insufficient resources",
		"53100": "Disk full",
		"53200": "Out of memory",
		"53300": "Too many connections",
		"54000": "Program limit exceeded",
		"54001": "Statement too complex",
		"54011": "Too many columns",
		"54023": "Too many arguments",
		"58000": "System error",
		"58030": "I/O error",
	}

	// Check exact match
	if (reasons[sqlstate]) {
		return reasons[sqlstate]
	}

	// Check prefix
	if (sqlstate.startsWith("08")) return "Connection failure"
	if (sqlstate.startsWith("53")) return "Insufficient resources"
	if (sqlstate.startsWith("54")) return "Program limit exceeded"
	if (sqlstate.startsWith("58")) return "System error"
	if (sqlstate.startsWith("F0")) return "Configuration error"
	if (sqlstate.startsWith("XX")) return "Internal error"

	return "Infrastructure failure"
}

/**
 * Get hint for SQLSTATE error
 */
export function getSQLSTATEHint(sqlstate: string): string {
	const hints: Record<string, string> = {
		"42601": "Fix SQL syntax based on the error position",
		"42P01": "Use correct table name from the allowed list",
		"42703": "Use correct column name - check schema",
		"42P09": "Qualify ambiguous column with table alias",
		"42P10": "Add table qualifier to column reference",
		"42804": "Fix datatype mismatch in comparison",
		"42883": "Use correct function name or check argument types",
		"42803": "Add missing column to GROUP BY or use aggregate",
		"22012": "Avoid division by zero - add NULLIF or CASE",
		"57014": "Query timed out - simplify query or add filters",
	}
	return hints[sqlstate] || "Review the error message and fix the SQL"
}

/**
 * Repair loop configuration
 */
export const REPAIR_CONFIG = {
	maxAttempts: 3,
	explainTimeout: 2000, // 2 seconds for EXPLAIN
	confidencePenaltyPerAttempt: 0.1,
}

/**
 * Final response to MCP client (LibreChat)
 */
export interface NLQueryResponse {
	/** Unique query ID */
	query_id: string

	/** Original question */
	question: string

	/** Database ID */
	database_id: string

	/** Generated SQL */
	sql_generated: string

	/** Whether SQL passed all validation */
	sql_valid: boolean

	/** Validation errors/warnings */
	validation_errors?: string[]
	validation_warnings?: string[]

	/** Execution results */
	executed: boolean
	execution_time_ms?: number
	rows_returned?: number
	rows?: Record<string, any>[]

	/** Confidence and metadata */
	confidence_score: number
	notes?: string
	tables_used: string[]

	/** Trace (debugging) */
	trace?: {
		python_latency_ms: number
		validation_latency_ms: number
		postgres_latency_ms: number
		retrieval_latency_ms?: number
		total_latency_ms: number
		stage1_tables?: string[]
		hrida_latency_ms?: number
		tables_selected?: number
		modules?: string[]
	}

	/** Error information */
	error?: {
		type: "generation" | "validation" | "execution" | "timeout"
		message: string
		recoverable: boolean
		context?: Record<string, any>
	}
}

/**
 * Audit log entry (for Phase 5)
 */
export interface AuditLogEntry {
	query_id: string
	timestamp: Date
	database_id: string
	user_id?: string
	question: string
	sql_generated: string
	sql_valid: boolean
	executed: boolean
	rows_returned?: number
	execution_time_ms?: number
	error?: string
	python_latency_ms?: number
	postgres_latency_ms?: number
	confidence_score: number
}

/**
 * Error types for structured error handling
 */
export class NL2SQLError extends Error {
	constructor(
		public type: "generation" | "validation" | "execution" | "timeout",
		message: string,
		public recoverable: boolean = false,
		public context?: Record<string, any>,
	) {
		super(message)
		this.name = "NL2SQLError"
	}
}

/**
 * Default configuration values
 */
export const DEFAULTS = {
	maxRows: 100,
	timeoutSeconds: 30,
	readOnly: true,
	requireLimit: true,
	maxLimit: 1000,
}
