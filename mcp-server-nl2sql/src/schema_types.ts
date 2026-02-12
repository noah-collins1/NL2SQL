/**
 * Schema Types for RAG-Based Schema Retrieval (V2)
 *
 * Defines types for:
 * - SchemaContextPacket (passed to Python sidecar)
 * - Dual retrieval (table + column)
 * - Score fusion
 * - FK relationships
 * - M-Schema rendering
 * - Error-driven column candidates
 */

// ============================================================================
// Retrieval Result Types (V2)
// ============================================================================

/**
 * Raw table retrieval result from pgvector
 */
export interface TableRetrievalHit {
	table_schema: string
	table_name: string
	module: string | null
	gloss: string
	m_schema_compact: string
	similarity: number
	is_generic?: boolean
}

/**
 * Raw column retrieval result from pgvector
 */
export interface ColumnRetrievalHit {
	table_schema: string
	table_name: string
	column_name: string
	module: string | null
	gloss: string
	data_type: string
	is_pk: boolean
	is_fk: boolean
	fk_target: string | null
	similarity: number
	is_generic: boolean
}

/**
 * Aggregated column score per table
 */
export interface TableColumnScore {
	table_name: string
	top1_similarity: number
	top2_similarity: number
	column_hits: ColumnRetrievalHit[]
	aggregated_score: number // top1 + 0.5*top2, with generic downweight
}

/**
 * Fused table score (table retrieval + column aggregation)
 */
export interface FusedTableScore {
	table_name: string
	table_schema: string
	module: string | null
	gloss: string
	m_schema_compact: string

	// Component scores
	table_similarity: number // Direct table retrieval score (0 if not retrieved)
	column_score: number // Aggregated column score (0 if no column hits)
	fused_score: number // 0.6 * table + 0.4 * column

	// Metadata
	source: "retrieval" | "fk_expansion" | "column_only"
	column_hits: ColumnRetrievalHit[]
	is_hub?: boolean
}

/**
 * Evidence set for FK gating
 */
export interface EvidenceSet {
	/** Tables with retrieval evidence */
	tables: Set<string>

	/** Minimum score to be in evidence set */
	minScore: number
}

// ============================================================================
// Legacy Types (for compatibility)
// ============================================================================

/**
 * Column metadata from rag.schema_columns
 */
export interface ColumnMeta {
	column_name: string
	data_type: string
	is_pk: boolean
	is_fk: boolean
	fk_target_table: string | null
	fk_target_column: string | null
	inferred_gloss: string
	ordinal_pos: number
}

/**
 * Table metadata from rag.schema_tables
 */
export interface TableMeta {
	table_schema: string
	table_name: string
	module: string
	table_gloss: string
	fk_degree: number
	is_hub: boolean
	columns: ColumnMeta[]
}

/**
 * FK relationship from rag.schema_fks
 */
export interface FKRelation {
	fk_table: string
	fk_column: string
	pk_table: string
	pk_column: string
}

/**
 * Retrieved table with similarity score
 */
export interface RetrievedTable {
	table_name: string
	table_schema: string
	module: string
	table_gloss: string
	similarity: number
	source: "retrieval" | "fk_expansion" | "bm25" | "hybrid"
	fk_degree?: number
	is_hub?: boolean
}

/**
 * Retrieval configuration
 */
export interface RetrievalConfig {
	/** Maximum tables from initial retrieval */
	topK: number

	/** Similarity threshold (0.0-1.0) */
	threshold: number

	/** Maximum tables after FK expansion */
	maxTables: number

	/** Maximum FK expansion depth */
	fkExpansionLimit: number

	/** Hub table FK expansion cap (for mega-hubs like employees) */
	hubFKCap: number

	/** Minimum similarity for FK expansion to include */
	fkMinSimilarity: number
}

/**
 * Default retrieval configuration
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
	topK: 15,
	threshold: 0.25,
	maxTables: 10,
	fkExpansionLimit: 3,
	hubFKCap: 5,
	fkMinSimilarity: 0.20,
}

/**
 * M-Schema format for a table (compact DDL)
 *
 * Format: table_name (col1 TYPE, col2 TYPE → fk_table, ...)
 */
export interface MSchemaTable {
	table_name: string
	module: string
	gloss: string
	columns: string // M-Schema column string
}

/**
 * Join hint for LLM prompt - describes a FK relationship
 */
export interface JoinHint {
	/** Source table.column */
	from: string
	/** Target table.column */
	to: string
	/** Human-readable description of the relationship */
	description?: string
}

/**
 * Suggested join path for multi-hop joins
 */
export interface JoinPath {
	/** Path description (e.g., "projects → project_resources → employees") */
	path: string
	/** Tables in order */
	tables: string[]
	/** Join conditions */
	conditions: string[]
}

/**
 * Join hint format options
 */
export type JoinHintFormatOption = "edges" | "paths" | "both" | "none"

/**
 * Schema Context Packet
 *
 * Complete context passed to Python sidecar for prompt construction.
 * Contains everything needed to generate SQL for the question.
 */
export interface SchemaContextPacket {
	/** Unique query ID for tracking */
	query_id: string

	/** Database identifier */
	database_id: string

	/** Original user question */
	question: string

	/** Question embedding (768 dims for nomic-embed-text) */
	question_embedding?: number[]

	/** Retrieved tables with M-Schema format */
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

	/** FK graph edges between selected tables */
	fk_edges: Array<{
		from_table: string
		from_column: string
		to_table: string
		to_column: string
	}>

	/** Join hints for LLM - formatted FK relationships (V2) */
	join_hints?: JoinHint[]

	/** Suggested join paths for complex multi-table queries (V2) */
	join_paths?: JoinPath[]

	/** Modules represented in selected tables */
	modules: string[]

	/** Retrieval metadata */
	retrieval_meta: {
		total_candidates: number
		threshold_used: number
		tables_from_retrieval: number
		tables_from_fk_expansion: number
		hub_tables_capped: string[]
	}

	/** Timestamp for caching */
	created_at: string
}

/**
 * Repair context for retry attempts
 *
 * Stateless - same schema context, escalate detail not re-retrieve
 */
export interface RepairContext {
	/** Original schema context (immutable across retries) */
	schema_context: SchemaContextPacket

	/** Previous SQL that failed */
	previous_sql: string

	/** Current attempt (1-based) */
	attempt: number

	/** Validator issues from TypeScript */
	validator_issues?: Array<{
		code: string
		severity: string
		message: string
		suggestion?: string
	}>

	/** PostgreSQL error */
	postgres_error?: {
		sqlstate: string
		message: string
		hint?: string
		detail?: string
		position?: number
	}

	/** Semantic issues from Python validator */
	semantic_issues?: Array<{
		code: string
		severity: string
		message: string
	}>
}

/**
 * Render M-Schema for a table
 *
 * Format: table_name (col1 TYPE, col2 TYPE FK→target, col3 TYPE PK, ...)
 */
export function renderMSchema(table: TableMeta): string {
	const colParts = table.columns.map((col) => {
		let part = `${col.column_name} ${col.data_type}`

		if (col.is_pk) {
			part += " PK"
		} else if (col.is_fk && col.fk_target_table) {
			part += ` FK→${col.fk_target_table}`
		}

		return part
	})

	return `${table.table_name} (${colParts.join(", ")})`
}

/**
 * Render full schema block for prompt
 *
 * Groups tables by module, includes glosses
 */
export function renderSchemaBlock(
	tables: SchemaContextPacket["tables"],
	fkEdges: SchemaContextPacket["fk_edges"],
): string {
	const lines: string[] = []

	// Group by module
	const byModule = new Map<string, typeof tables>()
	for (const table of tables) {
		const existing = byModule.get(table.module) || []
		existing.push(table)
		byModule.set(table.module, existing)
	}

	// Render each module
	for (const [module, moduleTables] of byModule) {
		lines.push(`## ${module}`)
		lines.push("")

		for (const table of moduleTables) {
			lines.push(`### ${table.table_name}`)
			lines.push(`${table.gloss}`)
			lines.push("```")
			lines.push(table.m_schema)
			lines.push("```")
			lines.push("")
		}
	}

	// Add FK relationships if multiple tables
	if (fkEdges.length > 0) {
		lines.push("## Relationships")
		lines.push("")
		for (const edge of fkEdges) {
			lines.push(`- ${edge.from_table}.${edge.from_column} → ${edge.to_table}.${edge.to_column}`)
		}
		lines.push("")
	}

	return lines.join("\n")
}

/**
 * Render join hints based on format option
 *
 * @param format - "edges" | "paths" | "both" | "none"
 * @param joinHints - FK edge hints
 * @param joinPaths - Suggested join paths
 * @param tables - Selected table names (for filtering)
 */
export function renderJoinHints(
	format: JoinHintFormatOption,
	joinHints?: JoinHint[],
	joinPaths?: JoinPath[],
	tables?: string[],
): string {
	if (format === "none") {
		return ""
	}

	const lines: string[] = []
	const tableSet = new Set(tables?.map(t => t.toLowerCase()) || [])

	// Filter hints to only include selected tables
	const filteredHints = joinHints?.filter(h => {
		const fromTable = h.from.split(".")[0]?.toLowerCase() || h.from.toLowerCase()
		const toTable = h.to.split(".")[0]?.toLowerCase() || h.to.toLowerCase()
		return tableSet.has(fromTable) && tableSet.has(toTable)
	}) || []

	const filteredPaths = joinPaths?.filter(p =>
		p.tables.every(t => tableSet.has(t.toLowerCase()))
	) || []

	if (format === "edges" || format === "both") {
		if (filteredHints.length > 0) {
			lines.push("## Join Hints (FK Edges)")
			lines.push("")
			for (const hint of filteredHints.slice(0, 10)) {
				lines.push(`- ${hint.from} → ${hint.to}`)
			}
			lines.push("")
		}
	}

	if (format === "paths" || format === "both") {
		if (filteredPaths.length > 0) {
			lines.push("## Suggested Join Paths")
			lines.push("")
			for (const path of filteredPaths.slice(0, 3)) {
				lines.push(`- ${path.path}`)
				if (path.conditions.length > 0) {
					lines.push(`  ON: ${path.conditions.join(" AND ")}`)
				}
			}
			lines.push("")
		}
	}

	return lines.join("\n")
}

// ============================================================================
// V2 Retrieval Configuration
// ============================================================================

/**
 * V2 Retrieval configuration with dual retrieval + score fusion
 */
export interface RetrievalConfigV2 {
	// Table retrieval
	tableTopK: number // Max tables from initial retrieval (default: 15)
	tableThreshold: number // Similarity threshold for tables (default: 0.20)

	// Column retrieval
	columnTopK: number // Max columns from retrieval (default: 50)
	columnThreshold: number // Similarity threshold for columns (default: 0.18)

	// Score fusion
	tableWeight: number // Weight for table score (default: 0.6)
	columnWeight: number // Weight for column score (default: 0.4)
	genericDownweight: number // Multiplier for generic columns (default: 0.7)

	// Final selection
	maxTables: number // Max tables after fusion (default: 10)

	// FK expansion (relevance-gated)
	fkExpansionCap: number // Max FK additions (default: 3)
	fkEvidenceThreshold: number // Min score to be in evidence set (default: 0.20)
	fkEvidenceTopK: number // Top K tables for evidence set (default: 20)

	// Final cap
	finalMaxTables: number // Absolute max after FK expansion (default: 12)
}

/**
 * Default V2 retrieval configuration
 */
export const DEFAULT_RETRIEVAL_CONFIG_V2: RetrievalConfigV2 = {
	tableTopK: 15,
	tableThreshold: 0.20,

	columnTopK: 50,
	columnThreshold: 0.18,

	tableWeight: 0.6,
	columnWeight: 0.4,
	genericDownweight: 0.7,

	maxTables: 10,

	fkExpansionCap: 3,
	fkEvidenceThreshold: 0.20,
	fkEvidenceTopK: 20,

	finalMaxTables: 12,
}

// ============================================================================
// Column Candidates (Error-Driven)
// ============================================================================

/**
 * Column candidate for error-driven suggestions
 *
 * Used when EXPLAIN fails with SQLSTATE 42703 (undefined column)
 */
export interface ColumnCandidate {
	table_name: string
	column_name: string
	data_type: string
	gloss: string
	match_type: "exact" | "fuzzy" | "embedding"
	match_score: number // 0.0 - 1.0
}

/**
 * Error context with column candidates
 */
export interface ErrorContextWithCandidates {
	sqlstate: string
	message: string
	hint?: string
	detail?: string
	position?: number

	// Column candidates (for 42703 errors)
	column_candidates?: ColumnCandidate[]

	// Undefined column name extracted from error
	undefined_column?: string
}

// ============================================================================
// Retrieval Metrics (for tuning/debugging)
// ============================================================================

/**
 * FK expansion blocked entry (for exam diagnostics)
 */
export interface FKBlockedEntry {
	table: string
	reason: "no_evidence" | "cap_reached" | "max_tables" | "already_selected"
}

/**
 * Retrieval metrics for debugging and tuning
 */
export interface RetrievalMetrics {
	query_id: string
	question_length: number
	embedding_latency_ms: number

	// Table retrieval
	table_retrieval_count: number
	table_threshold_used: number
	table_similarities: Array<{ table: string; similarity: number }>

	// Column retrieval
	column_retrieval_count: number
	column_threshold_used: number
	column_hits_per_table: Record<string, number>
	top_columns_per_table?: Record<string, Array<{ column: string; similarity: number }>>

	// Score fusion
	tables_from_table_retrieval: number
	tables_from_column_only: number
	fusion_weights: { table: number; column: number }
	fused_scores?: Array<{ table: string; fused: number; table_sim: number; col_score: number }>

	// FK expansion
	fk_expansion_candidates: number
	fk_expansion_added: number
	fk_expansion_blocked_no_evidence: number
	fk_expansion_blocked: FKBlockedEntry[]

	// Final selection
	final_table_count: number
	final_tables: string[]
	total_latency_ms: number
}
