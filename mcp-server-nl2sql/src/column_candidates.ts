/**
 * Column Candidates Module
 *
 * Provides error-driven column suggestions for SQLSTATE 42703 (undefined column) errors.
 *
 * When EXPLAIN fails with an undefined column error, this module:
 * 1. Extracts the undefined column name from the error message
 * 2. Detects the referenced table alias/table for the missing column
 * 3. Searches for candidate columns using:
 *    - Exact match (different case)
 *    - Fuzzy match (Levenshtein distance)
 *    - Embedding similarity
 * 4. Returns table-aware candidates:
 *    - If table is known: candidates from that table only
 *    - If table is unknown: candidates grouped by table with top-1 per table
 * 5. Includes column whitelist block for repair prompt
 */

import { Pool, PoolClient } from "pg"
import { getPythonClient, PythonClient } from "./python_client.js"
import type { ColumnCandidate, ErrorContextWithCandidates, SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Error Parsing
// ============================================================================

/**
 * Extract undefined column name from PostgreSQL error
 *
 * Error format: 'column "foo" does not exist'
 * Position may point to location in query
 */
export function extractUndefinedColumn(errorMessage: string): string | null {
	// Pattern: column "column_name" does not exist
	const match = errorMessage.match(/column\s+"([^"]+)"\s+does not exist/i)
	if (match) {
		return match[1]
	}

	// Pattern: column column_name does not exist (unquoted)
	const unquotedMatch = errorMessage.match(/column\s+(\w+)\s+does not exist/i)
	if (unquotedMatch) {
		return unquotedMatch[1]
	}

	return null
}

/**
 * Extract table context from error (if available)
 *
 * Error may include: 'column "foo" of relation "bar" does not exist'
 */
export function extractTableFromError(errorMessage: string): string | null {
	const match = errorMessage.match(/of relation\s+"([^"]+)"/i)
	return match ? match[1] : null
}

/**
 * Extract table/alias from SQL for a column reference
 *
 * Looks for patterns like:
 * - alias.column_name
 * - table_name.column_name
 * - FROM table_name ... WHERE column_name (infer from context)
 */
export function extractTableContextFromSQL(
	sql: string,
	columnName: string,
): { tableOrAlias: string | null; isAlias: boolean } {
	// Look for qualified reference: table.column or alias.column
	const qualifiedPattern = new RegExp(
		`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\.${escapeRegex(columnName)}\\b`,
		"i"
	)
	const match = sql.match(qualifiedPattern)

	if (match) {
		const tableOrAlias = match[1].toLowerCase()
		return { tableOrAlias, isAlias: true } // Could be either, will resolve later
	}

	return { tableOrAlias: null, isAlias: false }
}

/**
 * Resolve alias to table name using SQL FROM/JOIN clauses
 */
export function resolveAliasToTable(sql: string, aliasOrTable: string): string | null {
	const aliasLower = aliasOrTable.toLowerCase()

	// Pattern: FROM/JOIN table_name [AS] alias
	const aliasPattern = new RegExp(
		`(?:FROM|JOIN)\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s+(?:AS\\s+)?${escapeRegex(aliasOrTable)}(?:\\s|,|ON|WHERE|;|$)`,
		"i"
	)
	const match = sql.match(aliasPattern)

	if (match) {
		return match[1].toLowerCase()
	}

	// Check if it's a table name directly used in FROM/JOIN
	const tablePattern = new RegExp(
		`(?:FROM|JOIN)\\s+${escapeRegex(aliasOrTable)}(?:\\s|,|ON|WHERE|;|$)`,
		"i"
	)
	if (tablePattern.test(sql)) {
		return aliasLower
	}

	return null
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ============================================================================
// Column Candidate Finder
// ============================================================================

export class ColumnCandidateFinder {
	private pool: Pool
	private pythonClient: PythonClient
	private logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}

	constructor(
		pool: Pool,
		logger: { info: Function; error: Function; warn: Function; debug: Function },
	) {
		this.pool = pool
		this.pythonClient = getPythonClient()
		this.logger = logger
	}

	/**
	 * Find column candidates for an undefined column error
	 *
	 * @param databaseId Database identifier
	 * @param undefinedColumn The column name that doesn't exist
	 * @param schemaContext Current schema context (limits search to selected tables)
	 * @param maxCandidates Maximum candidates to return (default: 5)
	 * @param targetTable Optional: specific table to search (from error context)
	 * @param sql Optional: the SQL that failed (for context extraction)
	 */
	async findCandidates(
		databaseId: string,
		undefinedColumn: string,
		schemaContext: SchemaContextPacket,
		maxCandidates: number = 5,
		targetTable?: string,
		sql?: string,
	): Promise<ColumnCandidate[]> {
		const selectedTables = schemaContext.tables.map((t) => t.table_name)

		if (selectedTables.length === 0) {
			return []
		}

		// Try to determine target table from SQL if not provided
		let resolvedTargetTable = targetTable?.toLowerCase()

		if (!resolvedTargetTable && sql) {
			const { tableOrAlias } = extractTableContextFromSQL(sql, undefinedColumn)
			if (tableOrAlias) {
				// Try to resolve alias to table
				const resolved = resolveAliasToTable(sql, tableOrAlias)
				if (resolved && selectedTables.map(t => t.toLowerCase()).includes(resolved)) {
					resolvedTargetTable = resolved
					this.logger.debug("Resolved column reference to table", {
						undefined_column: undefinedColumn,
						alias_or_table: tableOrAlias,
						resolved_table: resolvedTargetTable,
					})
				}
			}
		}

		// Determine which tables to search
		let searchTables: string[]
		if (resolvedTargetTable && selectedTables.map(t => t.toLowerCase()).includes(resolvedTargetTable)) {
			// Search only in the target table
			searchTables = [resolvedTargetTable]
			this.logger.debug("Table-aware search", {
				undefined_column: undefinedColumn,
				target_table: resolvedTargetTable,
			})
		} else {
			// Search all selected tables
			searchTables = selectedTables
		}

		let client: PoolClient | null = null
		const candidates: ColumnCandidate[] = []

		try {
			client = await this.pool.connect()

			// Step 1: Exact match (different case)
			const exactMatches = await this.findExactMatches(
				client,
				databaseId,
				undefinedColumn,
				searchTables,
			)
			candidates.push(...exactMatches)

			// Step 2: Fuzzy match (Levenshtein)
			if (candidates.length < maxCandidates) {
				const fuzzyMatches = await this.findFuzzyMatches(
					client,
					databaseId,
					undefinedColumn,
					searchTables,
					maxCandidates - candidates.length,
				)

				// Deduplicate
				for (const match of fuzzyMatches) {
					if (!candidates.some((c) => c.table_name === match.table_name && c.column_name === match.column_name)) {
						candidates.push(match)
					}
				}
			}

			// Step 3: Embedding similarity (if still need more)
			if (candidates.length < maxCandidates) {
				const embeddingMatches = await this.findEmbeddingMatches(
					client,
					databaseId,
					undefinedColumn,
					searchTables,
					maxCandidates - candidates.length,
				)

				// Deduplicate
				for (const match of embeddingMatches) {
					if (!candidates.some((c) => c.table_name === match.table_name && c.column_name === match.column_name)) {
						candidates.push(match)
					}
				}
			}

			// If we searched a single table and found nothing, expand to all tables
			if (candidates.length === 0 && searchTables.length === 1 && selectedTables.length > 1) {
				this.logger.debug("No candidates in target table, expanding search to all tables", {
					undefined_column: undefinedColumn,
					target_table: resolvedTargetTable,
				})

				// Search all tables, but get top-1 per table for grouped results
				const allTableCandidates = await this.findCandidatesGroupedByTable(
					client,
					databaseId,
					undefinedColumn,
					selectedTables,
					maxCandidates,
				)
				candidates.push(...allTableCandidates)
			}

			// Sort by match score descending
			candidates.sort((a, b) => b.match_score - a.match_score)

			this.logger.debug("Column candidates found", {
				undefined_column: undefinedColumn,
				target_table: resolvedTargetTable,
				candidates: candidates.map((c) => `${c.table_name}.${c.column_name} (${c.match_type}:${c.match_score.toFixed(2)}`),
			})

			return candidates.slice(0, maxCandidates)
		} finally {
			if (client) {
				client.release()
			}
		}
	}

	/**
	 * Find best candidate from each table (for when table is unknown)
	 */
	private async findCandidatesGroupedByTable(
		client: PoolClient,
		databaseId: string,
		undefinedColumn: string,
		selectedTables: string[],
		maxCandidates: number,
	): Promise<ColumnCandidate[]> {
		const candidates: ColumnCandidate[] = []

		// Get top candidate from each table using fuzzy match
		for (const table of selectedTables.slice(0, maxCandidates)) {
			const fuzzyMatches = await this.findFuzzyMatches(
				client,
				databaseId,
				undefinedColumn,
				[table],
				1,
			)

			if (fuzzyMatches.length > 0) {
				candidates.push(fuzzyMatches[0])
			}
		}

		return candidates
	}

	/**
	 * Find exact matches (case-insensitive)
	 */
	private async findExactMatches(
		client: PoolClient,
		databaseId: string,
		undefinedColumn: string,
		selectedTables: string[],
	): Promise<ColumnCandidate[]> {
		const query = `
			SELECT
				table_name,
				column_name,
				data_type,
				gloss
			FROM rag.schema_embeddings
			WHERE database_id = $1
				AND entity_type = 'column'
				AND table_name = ANY($2)
				AND LOWER(column_name) = LOWER($3)
				AND column_name != $3
		`

		const result = await client.query(query, [databaseId, selectedTables, undefinedColumn])

		return result.rows.map((row) => ({
			table_name: row.table_name,
			column_name: row.column_name,
			data_type: row.data_type,
			gloss: row.gloss,
			match_type: "exact" as const,
			match_score: 0.95, // High score for exact match
		}))
	}

	/**
	 * Find fuzzy matches using trigram similarity
	 */
	private async findFuzzyMatches(
		client: PoolClient,
		databaseId: string,
		undefinedColumn: string,
		selectedTables: string[],
		maxResults: number,
	): Promise<ColumnCandidate[]> {
		// Use pg_trgm for fuzzy matching
		const query = `
			SELECT
				table_name,
				column_name,
				data_type,
				gloss,
				similarity(column_name, $3) AS sim_score
			FROM rag.schema_embeddings
			WHERE database_id = $1
				AND entity_type = 'column'
				AND table_name = ANY($2)
				AND similarity(column_name, $3) > 0.3
			ORDER BY similarity(column_name, $3) DESC
			LIMIT $4
		`

		try {
			const result = await client.query(query, [
				databaseId,
				selectedTables,
				undefinedColumn,
				maxResults,
			])

			return result.rows.map((row) => ({
				table_name: row.table_name,
				column_name: row.column_name,
				data_type: row.data_type,
				gloss: row.gloss,
				match_type: "fuzzy" as const,
				match_score: parseFloat(row.sim_score) * 0.9, // Scale to max 0.9
			}))
		} catch (err) {
			// pg_trgm might not be installed
			this.logger.warn("Fuzzy match failed (pg_trgm not available?)", { error: String(err) })
			return []
		}
	}

	/**
	 * Find matches using embedding similarity
	 */
	private async findEmbeddingMatches(
		client: PoolClient,
		databaseId: string,
		undefinedColumn: string,
		selectedTables: string[],
		maxResults: number,
	): Promise<ColumnCandidate[]> {
		try {
			// Embed the undefined column name
			const embedding = await this.pythonClient.embedText(undefinedColumn)
			const vectorLiteral = `[${embedding.join(",")}]`

			const query = `
				SELECT
					table_name,
					column_name,
					data_type,
					gloss,
					1 - (embedding <=> $1::vector) AS similarity
				FROM rag.schema_embeddings
				WHERE database_id = $2
					AND entity_type = 'column'
					AND table_name = ANY($3)
					AND 1 - (embedding <=> $1::vector) > 0.3
				ORDER BY embedding <=> $1::vector
				LIMIT $4
			`

			const result = await client.query(query, [
				vectorLiteral,
				databaseId,
				selectedTables,
				maxResults,
			])

			return result.rows.map((row) => ({
				table_name: row.table_name,
				column_name: row.column_name,
				data_type: row.data_type,
				gloss: row.gloss,
				match_type: "embedding" as const,
				match_score: parseFloat(row.similarity) * 0.8, // Scale to max 0.8
			}))
		} catch (err) {
			this.logger.error("Embedding match failed", { error: String(err) })
			return []
		}
	}

	/**
	 * Enrich error context with column candidates
	 *
	 * Call this when EXPLAIN fails with SQLSTATE 42703
	 *
	 * @param errorContext The PostgreSQL error context
	 * @param databaseId Database identifier
	 * @param schemaContext Current schema context
	 * @param failedSQL Optional: the SQL that failed (for table context extraction)
	 */
	async enrichErrorWithCandidates(
		errorContext: {
			sqlstate: string
			message: string
			hint?: string
			detail?: string
			position?: number
		},
		databaseId: string,
		schemaContext: SchemaContextPacket,
		failedSQL?: string,
	): Promise<ErrorContextWithCandidates> {
		// Only process 42703 (undefined column) errors
		if (errorContext.sqlstate !== "42703") {
			return errorContext
		}

		const undefinedColumn = extractUndefinedColumn(errorContext.message)
		if (!undefinedColumn) {
			return errorContext
		}

		// Try to get table context from error message
		const tableFromError = extractTableFromError(errorContext.message)

		const candidates = await this.findCandidates(
			databaseId,
			undefinedColumn,
			schemaContext,
			5,
			tableFromError || undefined,
			failedSQL,
		)

		return {
			...errorContext,
			undefined_column: undefinedColumn,
			column_candidates: candidates,
		}
	}
}

// ============================================================================
// Format Candidates for Prompt
// ============================================================================

/**
 * Format column candidates for inclusion in repair prompt
 *
 * Includes strong instruction to choose from provided columns only.
 */
export function formatCandidatesForPrompt(
	candidates: ColumnCandidate[],
	undefinedColumn: string,
	targetTable?: string,
): string {
	if (candidates.length === 0) {
		return `Column "${undefinedColumn}" does not exist. Check column names in the schema above.`
	}

	const lines = [
		`## Column Error Analysis`,
		"",
		`Column "${undefinedColumn}" does not exist.`,
		"",
	]

	if (targetTable) {
		lines.push(`**Table context:** ${targetTable}`)
		lines.push("")
	}

	lines.push("**YOU MUST choose from these columns only:**")
	lines.push("")

	// Group candidates by table
	const byTable = new Map<string, ColumnCandidate[]>()
	for (const candidate of candidates) {
		const existing = byTable.get(candidate.table_name) || []
		existing.push(candidate)
		byTable.set(candidate.table_name, existing)
	}

	for (const [table, tableCandidates] of byTable) {
		lines.push(`**${table}:**`)
		for (const candidate of tableCandidates) {
			const matchInfo = candidate.match_type === "exact"
				? "(case mismatch)"
				: candidate.match_type === "fuzzy"
					? "(similar spelling)"
					: "(similar meaning)"

			lines.push(`  - ${candidate.column_name} ${matchInfo} [${candidate.data_type}]`)
			if (candidate.gloss) {
				lines.push(`    Description: ${candidate.gloss}`)
			}
		}
		lines.push("")
	}

	lines.push("**Critical:** Use the exact column name from the list above. Do not guess or invent column names.")

	return lines.join("\n")
}

/**
 * Generate column whitelist block for repair prompt
 *
 * Lists all available columns per table from schema context.
 */
export function generateColumnWhitelistBlock(
	schemaContext: SchemaContextPacket,
	highlightCandidates?: ColumnCandidate[],
): string {
	const lines = [
		"## Available Columns by Table",
		"",
		"**Only use columns listed below:**",
		"",
	]

	// Build set of highlighted columns for quick lookup
	const highlightedColumns = new Set<string>()
	if (highlightCandidates) {
		for (const candidate of highlightCandidates) {
			highlightedColumns.add(`${candidate.table_name}.${candidate.column_name}`.toLowerCase())
		}
	}

	for (const table of schemaContext.tables) {
		// Parse columns from m_schema
		const columns = parseColumnsFromMSchema(table.m_schema)

		if (columns.length > 0) {
			lines.push(`**${table.table_name}:**`)

			const columnList = columns.map(col => {
				const fullName = `${table.table_name}.${col.name}`.toLowerCase()
				const isHighlighted = highlightedColumns.has(fullName)
				return isHighlighted ? `**${col.name}**` : col.name
			}).join(", ")

			lines.push(`  ${columnList}`)
			lines.push("")
		}
	}

	return lines.join("\n")
}

/**
 * Parse columns from M-Schema format
 *
 * Format: table_name (col1[TAG], col2[TAG], ...)
 */
export function parseColumnsFromMSchema(mSchema: string): Array<{ name: string; type?: string }> {
	const columns: Array<{ name: string; type?: string }> = []

	// Extract content between parentheses
	const match = mSchema.match(/\(([^)]+)\)/)
	if (!match) return columns

	const content = match[1]

	// Split by comma, handling potential nested content
	const parts = content.split(/,\s*/)

	for (const part of parts) {
		// Parse "column_name[TAG]" or just "column_name"
		const colMatch = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)
		if (colMatch) {
			columns.push({ name: colMatch[1] })
		}
	}

	return columns
}

// ============================================================================
// Column Whitelist Generation
// ============================================================================

/**
 * Build a column whitelist from schema context
 *
 * Returns a map of table_name -> column_names[]
 */
export function buildColumnWhitelist(
	schemaContext: SchemaContextPacket,
): Record<string, string[]> {
	const whitelist: Record<string, string[]> = {}

	for (const table of schemaContext.tables) {
		const columns = parseColumnsFromMSchema(table.m_schema)
		whitelist[table.table_name.toLowerCase()] = columns.map(c => c.name.toLowerCase())
	}

	return whitelist
}

// ============================================================================
// Pre-Execution Column Validator
// ============================================================================

/**
 * Result of column validation
 */
export interface ColumnValidationResult {
	valid: boolean
	missingColumns: Array<{
		alias: string
		column: string
		resolvedTable: string | null
		availableColumns: string[]
	}>
	unresolvedAliases: string[]
}

/**
 * Extract all alias.column references from SQL
 */
export function extractColumnReferences(sql: string): Array<{ alias: string; column: string }> {
	const refs: Array<{ alias: string; column: string }> = []

	// Match alias.column patterns (not inside quotes)
	// This is a simplified pattern - we look for word.word patterns
	const pattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi

	let match
	while ((match = pattern.exec(sql)) !== null) {
		const alias = match[1].toLowerCase()
		const column = match[2].toLowerCase()

		// Skip schema-qualified table names (public.table_name)
		if (alias === "public" || alias === "pg_catalog") continue

		// Skip function calls like COUNT(*), SUM(x)
		if (["count", "sum", "avg", "min", "max", "coalesce", "nullif", "cast", "extract", "date_trunc"].includes(alias)) continue

		refs.push({ alias, column })
	}

	return refs
}

/**
 * Build alias -> table mapping from SQL
 */
export function buildAliasMap(sql: string): Map<string, string> {
	const aliasMap = new Map<string, string>()

	// Pattern: FROM/JOIN table_name [AS] alias
	const patterns = [
		/\bFROM\s+(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\b/gi,
		/\bJOIN\s+(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\b/gi,
		// Table name used directly (no alias)
		/\bFROM\s+(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*(?:WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP|ORDER|LIMIT|;|$))/gi,
		/\bJOIN\s+(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s+ON\b/gi,
	]

	// Process aliased patterns
	for (const pattern of patterns.slice(0, 2)) {
		let match
		while ((match = pattern.exec(sql)) !== null) {
			const table = match[1].toLowerCase()
			const alias = match[2].toLowerCase()
			if (table !== alias) { // Real alias
				aliasMap.set(alias, table)
			}
			aliasMap.set(table, table) // Table can also be used as its own "alias"
		}
	}

	// Process direct table references
	for (const pattern of patterns.slice(2)) {
		let match
		while ((match = pattern.exec(sql)) !== null) {
			const table = match[1].toLowerCase()
			aliasMap.set(table, table)
		}
	}

	return aliasMap
}

/**
 * Find similar columns in a table (for suggestions)
 */
export function findSimilarColumns(
	missingColumn: string,
	availableColumns: string[],
	maxResults: number = 3,
): Array<{ column: string; similarity: number }> {
	const suggestions: Array<{ column: string; similarity: number }> = []

	for (const col of availableColumns) {
		const similarity = calculateSimilarity(missingColumn, col)
		if (similarity > 0.3) {
			suggestions.push({ column: col, similarity })
		}
	}

	return suggestions
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, maxResults)
}

/**
 * Simple string similarity (Dice coefficient on bigrams)
 */
function calculateSimilarity(a: string, b: string): number {
	if (a === b) return 1.0
	if (a.length < 2 || b.length < 2) return 0

	const aBigrams = new Set<string>()
	for (let i = 0; i < a.length - 1; i++) {
		aBigrams.add(a.slice(i, i + 2))
	}

	let intersection = 0
	for (let i = 0; i < b.length - 1; i++) {
		if (aBigrams.has(b.slice(i, i + 2))) {
			intersection++
		}
	}

	return (2 * intersection) / (a.length - 1 + b.length - 1)
}

/**
 * Validate SQL column references against schema whitelist
 *
 * Returns validation result with missing columns and suggestions.
 * Conservative: if alias resolution fails, skips validation for that alias.
 */
export function validateSQLColumns(
	sql: string,
	columnWhitelist: Record<string, string[]>,
): ColumnValidationResult {
	const refs = extractColumnReferences(sql)
	const aliasMap = buildAliasMap(sql)

	const missingColumns: ColumnValidationResult["missingColumns"] = []
	const unresolvedAliases: string[] = []
	const checkedAliases = new Set<string>()

	for (const ref of refs) {
		// Resolve alias to table
		const table = aliasMap.get(ref.alias)

		if (!table) {
			// Can't resolve alias - skip validation but note it
			if (!checkedAliases.has(ref.alias)) {
				unresolvedAliases.push(ref.alias)
				checkedAliases.add(ref.alias)
			}
			continue
		}

		// Check if table is in whitelist
		const tableColumns = columnWhitelist[table]
		if (!tableColumns) {
			// Table not in schema context - skip validation
			continue
		}

		// Check if column exists
		if (!tableColumns.includes(ref.column)) {
			missingColumns.push({
				alias: ref.alias,
				column: ref.column,
				resolvedTable: table,
				availableColumns: tableColumns,
			})
		}
	}

	return {
		valid: missingColumns.length === 0,
		missingColumns,
		unresolvedAliases,
	}
}

/**
 * Format column validation errors for repair prompt
 */
export function formatColumnValidationErrors(
	result: ColumnValidationResult,
	columnWhitelist: Record<string, string[]>,
): string {
	if (result.valid) return ""

	const lines: string[] = [
		"## Column Validation Failed (Pre-Execution Check)",
		"",
		"The following column references are INVALID:",
		"",
	]

	for (const missing of result.missingColumns) {
		const suggestions = findSimilarColumns(missing.column, missing.availableColumns)

		lines.push(`**\`${missing.alias}.${missing.column}\`** - column does not exist in table \`${missing.resolvedTable}\``)

		if (suggestions.length > 0) {
			const suggestionText = suggestions.map(s => `\`${s.column}\``).join(", ")
			lines.push(`  → Did you mean: ${suggestionText}?`)
		}
		lines.push("")
	}

	lines.push("## Column Whitelist (ONLY use these columns)")
	lines.push("")
	lines.push("**You MUST use ONLY column names exactly as listed below. Do NOT invent columns.**")
	lines.push("")

	// Only show tables that were referenced
	const referencedTables = new Set(result.missingColumns.map(m => m.resolvedTable).filter(Boolean))

	for (const [table, columns] of Object.entries(columnWhitelist)) {
		if (referencedTables.has(table) || referencedTables.size === 0) {
			lines.push(`**${table}:** ${columns.join(", ")}`)
		}
	}

	lines.push("")
	lines.push("**Fix Strategy:**")
	lines.push("1. Replace invalid column names with exact names from the whitelist above")
	lines.push("2. If the column exists in a different table, JOIN that table")
	lines.push("3. Do NOT guess or invent column names")

	return lines.join("\n")
}

// ============================================================================
// Singleton
// ============================================================================

let defaultFinder: ColumnCandidateFinder | null = null

export function getColumnCandidateFinder(
	pool: Pool,
	logger: { info: Function; error: Function; warn: Function; debug: Function },
): ColumnCandidateFinder {
	if (!defaultFinder) {
		defaultFinder = new ColumnCandidateFinder(pool, logger)
	}
	return defaultFinder
}

export function resetColumnCandidateFinder(): void {
	defaultFinder = null
}
