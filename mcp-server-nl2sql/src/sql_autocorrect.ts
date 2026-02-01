/**
 * SQL Autocorrect Module
 *
 * Provides deterministic correction for common SQL errors before falling back
 * to LLM repair. Currently handles:
 * - 42703 (undefined column) - fuzzy matching to correct column names
 * - 42P01 (undefined table) - alias resolution
 *
 * This is DB-agnostic and works with any SchemaContextPacket.
 */

import type { SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Types
// ============================================================================

export interface AutocorrectResult {
	/** Whether autocorrect was attempted */
	attempted: boolean

	/** Whether autocorrect succeeded */
	success: boolean

	/** The corrected SQL (or original if no correction) */
	sql: string

	/** Description of the correction made */
	correction?: string

	/** The candidate that was selected */
	selected_candidate?: ColumnCandidate

	/** All candidates considered */
	candidates?: ColumnCandidate[]

	/** Why autocorrect failed (if attempted but unsuccessful) */
	failure_reason?: string
}

export interface ColumnCandidate {
	table_name: string
	column_name: string
	data_type: string
	qualified_name: string // table.column
	match_type: "exact_case" | "exact_lower" | "snake_normalized" | "fuzzy" | "prefix" | "suffix"
	match_score: number // 0.0 - 1.0
}

export interface AliasMap {
	[alias: string]: string // alias -> table_name
}

// ============================================================================
// Configuration
// ============================================================================

const AUTOCORRECT_CONFIG = {
	/** Minimum score to auto-apply correction */
	minConfidence: 0.70,

	/** Minimum score to include in candidates */
	minCandidateScore: 0.4,

	/** Maximum candidates to return */
	maxCandidates: 5,

	/** Score weights for different match types */
	matchScores: {
		exact_case: 1.0, // Exact match including case (shouldn't happen if error occurred)
		exact_lower: 0.95, // Case-insensitive exact match
		snake_normalized: 0.85, // After removing underscores
		prefix: 0.7, // Column starts with search term
		suffix: 0.65, // Column ends with search term
		fuzzy: 0.6, // Levenshtein-based
	},
}

// ============================================================================
// Error Parsing
// ============================================================================

/**
 * Parse 42703 error message to extract undefined column name
 *
 * PostgreSQL formats:
 * - 'column "foo" does not exist'
 * - 'column foo does not exist'
 * - 'column "foo" of relation "bar" does not exist'
 * - 'column table.column does not exist' (qualified name)
 * - 'column "table.column" does not exist' (quoted qualified name)
 */
export function parseUndefinedColumn(message: string): {
	column: string
	tableHint?: string
} | null {
	// Pattern 1: column "name" of relation "table" does not exist
	const withRelation = /column "?([^"]+)"? of relation "?([^"]+)"? does not exist/i
	const match1 = message.match(withRelation)
	if (match1) {
		return { column: match1[1], tableHint: match1[2] }
	}

	// Pattern 2: column "table.column" does not exist (quoted qualified)
	const quotedQualified = /column "([^"]+)\.([^"]+)" does not exist/i
	const match2a = message.match(quotedQualified)
	if (match2a) {
		return { column: match2a[2], tableHint: match2a[1] }
	}

	// Pattern 3: column "name" does not exist (quoted simple)
	const simpleQuoted = /column "([^"]+)" does not exist/i
	const match2 = message.match(simpleQuoted)
	if (match2) {
		return { column: match2[1] }
	}

	// Pattern 4: column table.column does not exist (unquoted qualified)
	const unquotedQualified = /column ([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*) does not exist/i
	const match3a = message.match(unquotedQualified)
	if (match3a) {
		return { column: match3a[2], tableHint: match3a[1] }
	}

	// Pattern 5: column name does not exist (unquoted simple)
	const simpleUnquoted = /column (\w+) does not exist/i
	const match3 = message.match(simpleUnquoted)
	if (match3) {
		return { column: match3[1] }
	}

	return null
}

/**
 * Parse 42P01 error message to extract missing table/alias
 *
 * PostgreSQL formats:
 * - 'missing FROM-clause entry for table "foo"'
 * - 'relation "foo" does not exist'
 */
export function parseMissingTable(message: string): string | null {
	// Pattern 1: missing FROM-clause entry for table "name"
	const fromClause = /missing FROM-clause entry for table "?([^"]+)"?/i
	const match1 = message.match(fromClause)
	if (match1) {
		return match1[1]
	}

	// Pattern 2: relation "name" does not exist
	const relation = /relation "?([^"]+)"? does not exist/i
	const match2 = message.match(relation)
	if (match2) {
		return match2[1]
	}

	return null
}

// ============================================================================
// SQL Parsing Utilities
// ============================================================================

/**
 * Extract table aliases from SQL
 *
 * Patterns:
 * - FROM table_name alias
 * - FROM table_name AS alias
 * - JOIN table_name alias
 * - JOIN table_name AS alias
 */
export function extractAliases(sql: string): AliasMap {
	const aliases: AliasMap = {}

	// Normalize whitespace
	const normalized = sql.replace(/\s+/g, " ")

	// Pattern: FROM/JOIN table_name [AS] alias
	const aliasPattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|,|ON|WHERE|GROUP|ORDER|LIMIT|;|$)/gi

	let match
	while ((match = aliasPattern.exec(normalized)) !== null) {
		const tableName = match[1].toLowerCase()
		const alias = match[2].toLowerCase()

		// Skip if alias is a SQL keyword
		const keywords = ["on", "where", "group", "order", "limit", "having", "join", "left", "right", "inner", "outer", "cross", "natural", "and", "or"]
		if (!keywords.includes(alias)) {
			aliases[alias] = tableName
		}
	}

	return aliases
}

/**
 * Find all occurrences of an identifier in SQL
 * Returns positions where the identifier appears (for replacement)
 */
function findIdentifierPositions(sql: string, identifier: string): number[] {
	const positions: number[] = []
	const pattern = new RegExp(`\\b${escapeRegex(identifier)}\\b`, "gi")

	let match
	while ((match = pattern.exec(sql)) !== null) {
		positions.push(match.index)
	}

	return positions
}

/**
 * Replace identifier at specific position, preserving surrounding context
 */
function replaceIdentifier(sql: string, oldId: string, newId: string): string {
	// Use word boundary replacement to avoid partial matches
	const pattern = new RegExp(`\\b${escapeRegex(oldId)}\\b`, "gi")
	return sql.replace(pattern, newId)
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ============================================================================
// Column Candidate Matching
// ============================================================================

/**
 * Build column candidates from schema context
 */
export function buildColumnCandidates(
	schemaContext: SchemaContextPacket,
	undefinedColumn: string,
	tableHint?: string,
): ColumnCandidate[] {
	const candidates: ColumnCandidate[] = []
	const searchLower = undefinedColumn.toLowerCase()
	const searchNormalized = normalizeSnakeCase(searchLower)

	for (const table of schemaContext.tables) {
		// If tableHint provided, prioritize that table
		const isHintedTable = tableHint?.toLowerCase() === table.table_name.toLowerCase()

		// Parse columns from m_schema
		const columns = parseColumnsFromMSchema(table.m_schema)

		for (const col of columns) {
			const colLower = col.name.toLowerCase()
			const colNormalized = normalizeSnakeCase(colLower)
			const qualifiedName = `${table.table_name}.${col.name}`

			let matchType: ColumnCandidate["match_type"] | null = null
			let score = 0

			// Exact case match (shouldn't happen but handle it)
			if (col.name === undefinedColumn) {
				matchType = "exact_case"
				score = AUTOCORRECT_CONFIG.matchScores.exact_case
			}
			// Case-insensitive exact match
			else if (colLower === searchLower) {
				matchType = "exact_lower"
				score = AUTOCORRECT_CONFIG.matchScores.exact_lower
			}
			// Snake case normalized match (revenue_millions vs revenuemillions)
			else if (colNormalized === searchNormalized) {
				matchType = "snake_normalized"
				score = AUTOCORRECT_CONFIG.matchScores.snake_normalized
			}
			// Prefix match (column starts with search term)
			else if (colLower.startsWith(searchLower) || searchLower.startsWith(colLower)) {
				matchType = "prefix"
				score = AUTOCORRECT_CONFIG.matchScores.prefix
			}
			// Suffix match (column ends with search term)
			else if (colLower.endsWith(searchLower) || searchLower.endsWith(colLower)) {
				matchType = "suffix"
				score = AUTOCORRECT_CONFIG.matchScores.suffix
			}
			// Fuzzy match
			else {
				const distance = levenshteinDistance(searchLower, colLower)
				const maxLen = Math.max(searchLower.length, colLower.length)
				const similarity = 1 - distance / maxLen

				if (similarity >= 0.5) {
					matchType = "fuzzy"
					score = AUTOCORRECT_CONFIG.matchScores.fuzzy * similarity
				}
			}

			// Boost score if it's the hinted table
			if (isHintedTable && matchType) {
				score = Math.min(1.0, score + 0.15)
			}

			if (matchType && score >= AUTOCORRECT_CONFIG.minCandidateScore) {
				candidates.push({
					table_name: table.table_name,
					column_name: col.name,
					data_type: col.type,
					qualified_name: qualifiedName,
					match_type: matchType,
					match_score: score,
				})
			}
		}
	}

	// Sort by score descending
	candidates.sort((a, b) => b.match_score - a.match_score)

	// Return top N
	return candidates.slice(0, AUTOCORRECT_CONFIG.maxCandidates)
}

/**
 * Parse columns from M-Schema format
 *
 * Format: table_name (col1 TYPE, col2 TYPE FK→target, ...)
 */
function parseColumnsFromMSchema(mSchema: string): Array<{ name: string; type: string }> {
	const columns: Array<{ name: string; type: string }> = []

	// Extract content between parentheses
	const match = mSchema.match(/\(([^)]+)\)/)
	if (!match) return columns

	const content = match[1]

	// Split by comma, handling potential nested content
	const parts = content.split(/,\s*/)

	for (const part of parts) {
		// Parse "column_name TYPE [PK|FK→target|...]"
		const colMatch = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(\S+)/)
		if (colMatch) {
			columns.push({
				name: colMatch[1],
				type: colMatch[2],
			})
		}
	}

	return columns
}

/**
 * Normalize snake_case by removing underscores
 */
function normalizeSnakeCase(str: string): string {
	return str.replace(/_/g, "")
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(s1: string, s2: string): number {
	const m = s1.length
	const n = s2.length

	// Early exit for empty strings
	if (m === 0) return n
	if (n === 0) return m

	// Create distance matrix
	const d: number[][] = Array(m + 1)
		.fill(null)
		.map(() => Array(n + 1).fill(0))

	// Initialize first row and column
	for (let i = 0; i <= m; i++) d[i][0] = i
	for (let j = 0; j <= n; j++) d[0][j] = j

	// Fill in the rest
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
			d[i][j] = Math.min(
				d[i - 1][j] + 1, // deletion
				d[i][j - 1] + 1, // insertion
				d[i - 1][j - 1] + cost, // substitution
			)
		}
	}

	return d[m][n]
}

// ============================================================================
// Main Autocorrect Functions
// ============================================================================

/**
 * Attempt to autocorrect a 42703 (undefined column) error
 */
export function autocorrectUndefinedColumn(
	sql: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
): AutocorrectResult {
	// Parse the error to get undefined column
	const parsed = parseUndefinedColumn(errorMessage)
	if (!parsed) {
		return {
			attempted: false,
			success: false,
			sql,
			failure_reason: "Could not parse undefined column from error message",
		}
	}

	const { column: undefinedColumn, tableHint } = parsed

	// Extract aliases from SQL and resolve tableHint if it's an alias
	const aliases = extractAliases(sql)
	let resolvedTableHint = tableHint
	if (tableHint) {
		const tableHintLower = tableHint.toLowerCase()
		// Check if tableHint is an alias - resolve to actual table name
		if (aliases[tableHintLower]) {
			resolvedTableHint = aliases[tableHintLower]
		}
	}

	// Build candidates with resolved table hint
	const candidates = buildColumnCandidates(schemaContext, undefinedColumn, resolvedTableHint)

	if (candidates.length === 0) {
		return {
			attempted: true,
			success: false,
			sql,
			candidates: [],
			failure_reason: `No candidates found for column '${undefinedColumn}'`,
		}
	}

	// Check if best candidate meets confidence threshold
	const bestCandidate = candidates[0]

	if (bestCandidate.match_score < AUTOCORRECT_CONFIG.minConfidence) {
		return {
			attempted: true,
			success: false,
			sql,
			candidates,
			failure_reason: `Best candidate '${bestCandidate.qualified_name}' has score ${bestCandidate.match_score.toFixed(2)} < threshold ${AUTOCORRECT_CONFIG.minConfidence}`,
		}
	}

	// Determine what to replace
	// If SQL uses qualified name (alias.column or table.column), replace the whole thing
	// Otherwise just replace the column name

	// aliases was already extracted above for resolving tableHint
	let correctedSQL = sql

	// Try to find the pattern: alias.undefined_column or table.undefined_column
	const qualifiedPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\.(${escapeRegex(undefinedColumn)})\\b`, "gi")
	const qualifiedMatches = [...sql.matchAll(qualifiedPattern)]

	if (qualifiedMatches.length > 0) {
		// Replace qualified references
		for (const match of qualifiedMatches) {
			const qualifier = match[1]
			const qualifierLower = qualifier.toLowerCase()

			// Check if qualifier is an alias or table name
			const resolvedTable = aliases[qualifierLower] || qualifierLower

			// If the best candidate is from this table, apply the correction
			if (bestCandidate.table_name.toLowerCase() === resolvedTable) {
				const oldText = `${qualifier}.${undefinedColumn}`
				const newText = `${qualifier}.${bestCandidate.column_name}`
				correctedSQL = correctedSQL.replace(new RegExp(escapeRegex(oldText), "gi"), newText)
			}
		}
	} else {
		// Unqualified column reference - just replace the column name
		correctedSQL = replaceIdentifier(sql, undefinedColumn, bestCandidate.column_name)
	}

	// Check if we actually made a change
	if (correctedSQL === sql) {
		return {
			attempted: true,
			success: false,
			sql,
			candidates,
			selected_candidate: bestCandidate,
			failure_reason: "Replacement pattern not found in SQL",
		}
	}

	return {
		attempted: true,
		success: true,
		sql: correctedSQL,
		correction: `Replaced '${undefinedColumn}' with '${bestCandidate.column_name}' (${bestCandidate.match_type}, score: ${bestCandidate.match_score.toFixed(2)})`,
		selected_candidate: bestCandidate,
		candidates,
	}
}

/**
 * Attempt to autocorrect a 42P01 (missing FROM-clause) error
 *
 * This handles cases where an alias is used but not defined.
 */
export function autocorrectMissingTable(
	sql: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
): AutocorrectResult {
	const missingTable = parseMissingTable(errorMessage)
	if (!missingTable) {
		return {
			attempted: false,
			success: false,
			sql,
			failure_reason: "Could not parse missing table from error message",
		}
	}

	const missingLower = missingTable.toLowerCase()

	// Check if it's an undefined alias (common pattern)
	const aliases = extractAliases(sql)

	// Find tables in schema context
	const availableTables = schemaContext.tables.map((t) => t.table_name.toLowerCase())

	// If the missing "table" is actually meant to be an alias, find what table it should reference
	// Look for patterns like: SELECT x.col FROM table_a a JOIN table_b b WHERE x.col = ...
	// where 'x' is used but never defined

	// First check if any table in context starts with this letter/prefix
	const possibleTable = availableTables.find((t) => t.startsWith(missingLower) || t[0] === missingLower[0])

	if (possibleTable) {
		// Find where we need to define this alias
		// This is complex - for now just return as repairable error with hint
		return {
			attempted: true,
			success: false,
			sql,
			failure_reason: `Alias '${missingTable}' not defined. Possible table: ${possibleTable}. Define alias in FROM/JOIN clause.`,
		}
	}

	return {
		attempted: true,
		success: false,
		sql,
		failure_reason: `Unknown table or alias '${missingTable}'. Available tables: ${availableTables.join(", ")}`,
	}
}

/**
 * Main autocorrect entry point
 *
 * Attempts to fix SQL errors deterministically before falling back to LLM repair.
 */
export function attemptAutocorrect(
	sql: string,
	sqlstate: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
): AutocorrectResult {
	switch (sqlstate) {
		case "42703":
			return autocorrectUndefinedColumn(sql, errorMessage, schemaContext)

		case "42P01":
			return autocorrectMissingTable(sql, errorMessage, schemaContext)

		default:
			return {
				attempted: false,
				success: false,
				sql,
				failure_reason: `SQLSTATE ${sqlstate} not supported for autocorrect`,
			}
	}
}
