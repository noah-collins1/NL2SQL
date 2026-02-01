/**
 * SQL Lint Validator
 *
 * Deterministic SQL linting that runs after SQL generation and before EXPLAIN.
 * Catches structural issues that would otherwise burn retries:
 * - Unbalanced parentheses
 * - Unclosed quotes
 * - Trailing commas in SELECT/GROUP BY
 * - JOIN without ON/USING
 * - SELECT references alias/table not present in FROM/JOIN
 * - Aggregation errors (non-aggregated column without GROUP BY)
 * - Missing FROM-clause patterns
 *
 * Returns structured LintIssue objects that can be passed to repair prompts.
 */

// ============================================================================
// Types
// ============================================================================

export type LintIssueCode =
	| "unbalanced_parens"
	| "unclosed_quote"
	| "trailing_comma_select"
	| "trailing_comma_groupby"
	| "trailing_comma_orderby"
	| "join_without_condition"
	| "undefined_alias"
	| "undefined_table_ref"
	| "aggregate_without_groupby"
	| "non_aggregate_in_select"
	| "empty_select"
	| "empty_from"
	| "duplicate_alias"
	| "ambiguous_column"
	| "invalid_order_by_ref"

export interface LintIssue {
	code: LintIssueCode
	severity: "error" | "warn"
	message: string
	hint?: string
	span?: { start: number; end: number }
}

export interface LintResult {
	/** Whether the SQL passed linting (no errors, warnings are OK) */
	valid: boolean

	/** All issues found (errors and warnings) */
	issues: LintIssue[]

	/** Whether any error-level issues were found */
	hasErrors: boolean

	/** Extracted metadata for downstream use */
	metadata: {
		aliases: Map<string, string> // alias -> table
		tablesReferenced: string[]
		columnsSelected: string[]
		hasAggregates: boolean
		hasGroupBy: boolean
		groupByColumns: string[]
	}
}

// ============================================================================
// Token Types (reuse concepts from sql_validator.ts)
// ============================================================================

enum TokenType {
	NORMAL = "NORMAL",
	SINGLE_QUOTE = "SINGLE_QUOTE",
	DOUBLE_QUOTE = "DOUBLE_QUOTE",
	DOLLAR_QUOTE = "DOLLAR_QUOTE",
	LINE_COMMENT = "LINE_COMMENT",
	BLOCK_COMMENT = "BLOCK_COMMENT",
}

interface Token {
	type: TokenType
	value: string
	start: number
	end: number
}

// ============================================================================
// Tokenizer (copied from sql_validator.ts for independence)
// ============================================================================

function tokenizeSQL(sql: string): Token[] {
	const tokens: Token[] = []
	let i = 0
	const len = sql.length

	while (i < len) {
		const char = sql[i]
		const next = i + 1 < len ? sql[i + 1] : ""

		// Line comment: -- ...
		if (char === "-" && next === "-") {
			const start = i
			i += 2
			while (i < len && sql[i] !== "\n") {
				i++
			}
			tokens.push({
				type: TokenType.LINE_COMMENT,
				value: sql.substring(start, i),
				start,
				end: i,
			})
			if (i < len) i++
			continue
		}

		// Block comment: /* ... */
		if (char === "/" && next === "*") {
			const start = i
			i += 2
			while (i < len - 1) {
				if (sql[i] === "*" && sql[i + 1] === "/") {
					i += 2
					break
				}
				i++
			}
			tokens.push({
				type: TokenType.BLOCK_COMMENT,
				value: sql.substring(start, i),
				start,
				end: i,
			})
			continue
		}

		// Single-quoted string: '...' (with '' escaping)
		if (char === "'") {
			const start = i
			i++
			while (i < len) {
				if (sql[i] === "'") {
					if (i + 1 < len && sql[i + 1] === "'") {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			tokens.push({
				type: TokenType.SINGLE_QUOTE,
				value: sql.substring(start, i),
				start,
				end: i,
			})
			continue
		}

		// Double-quoted identifier: "..." (with "" escaping)
		if (char === '"') {
			const start = i
			i++
			while (i < len) {
				if (sql[i] === '"') {
					if (i + 1 < len && sql[i + 1] === '"') {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			tokens.push({
				type: TokenType.DOUBLE_QUOTE,
				value: sql.substring(start, i),
				start,
				end: i,
			})
			continue
		}

		// Dollar-quoted string: $tag$...$tag$ or $$...$$
		if (char === "$") {
			const start = i
			i++
			let tag = ""
			while (i < len && sql[i] !== "$") {
				tag += sql[i]
				i++
			}
			if (i < len) i++

			const openDelim = "$" + tag + "$"
			const closeDelim = openDelim

			while (i < len) {
				if (sql.substring(i, i + closeDelim.length) === closeDelim) {
					i += closeDelim.length
					break
				}
				i++
			}
			tokens.push({
				type: TokenType.DOLLAR_QUOTE,
				value: sql.substring(start, i),
				start,
				end: i,
			})
			continue
		}

		// Normal token
		const start = i
		while (
			i < len &&
			sql[i] !== "'" &&
			sql[i] !== '"' &&
			sql[i] !== "$" &&
			sql[i] !== "/" &&
			sql[i] !== "-"
		) {
			i++
		}
		if (i > start) {
			tokens.push({
				type: TokenType.NORMAL,
				value: sql.substring(start, i),
				start,
				end: i,
			})
		} else {
			tokens.push({
				type: TokenType.NORMAL,
				value: sql[i],
				start: i,
				end: i + 1,
			})
			i++
		}
	}

	return tokens
}

function getNormalTokens(tokens: Token[]): Token[] {
	return tokens.filter((t) => t.type === TokenType.NORMAL)
}

function getNormalSQL(tokens: Token[]): string {
	return getNormalTokens(tokens).map((t) => t.value).join("")
}

// ============================================================================
// Lint Checks
// ============================================================================

/**
 * Check for unbalanced parentheses
 */
function checkUnbalancedParens(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []
	let depth = 0
	let maxDepth = 0
	let lastOpenPos = -1

	for (let i = 0; i < normalSQL.length; i++) {
		if (normalSQL[i] === "(") {
			depth++
			lastOpenPos = i
			maxDepth = Math.max(maxDepth, depth)
		} else if (normalSQL[i] === ")") {
			depth--
			if (depth < 0) {
				issues.push({
					code: "unbalanced_parens",
					severity: "error",
					message: "Unmatched closing parenthesis",
					hint: "Remove extra ')' or add matching '('",
					span: { start: i, end: i + 1 },
				})
				depth = 0 // Reset to continue checking
			}
		}
	}

	if (depth > 0) {
		issues.push({
			code: "unbalanced_parens",
			severity: "error",
			message: `${depth} unclosed opening parenthesis${depth > 1 ? "es" : ""}`,
			hint: "Add matching ')' for each '('",
			span: lastOpenPos >= 0 ? { start: lastOpenPos, end: lastOpenPos + 1 } : undefined,
		})
	}

	return issues
}

/**
 * Check for unclosed quotes in normal SQL
 * (tokenizer may not fully catch this if quote is at end)
 */
function checkUnclosedQuotes(sql: string, tokens: Token[]): LintIssue[] {
	const issues: LintIssue[] = []

	// Check for single quotes
	const singleQuoteTokens = tokens.filter((t) => t.type === TokenType.SINGLE_QUOTE)
	for (const token of singleQuoteTokens) {
		const value = token.value
		// Count non-escaped quotes
		let quoteCount = 0
		for (let i = 0; i < value.length; i++) {
			if (value[i] === "'") {
				if (i + 1 < value.length && value[i + 1] === "'") {
					i++ // Skip escaped quote
				} else {
					quoteCount++
				}
			}
		}
		if (quoteCount % 2 !== 0) {
			issues.push({
				code: "unclosed_quote",
				severity: "error",
				message: "Unclosed single quote",
				hint: "Add closing single quote '",
				span: { start: token.start, end: token.end },
			})
		}
	}

	return issues
}

/**
 * Check for trailing commas in SELECT, GROUP BY, ORDER BY clauses
 */
function checkTrailingCommas(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []
	const upperSQL = normalSQL.toUpperCase()

	// Pattern: comma followed by FROM, GROUP BY, ORDER BY, HAVING, WHERE, LIMIT, etc.
	const trailingCommaPatterns = [
		{ pattern: /,\s*FROM\b/gi, clause: "SELECT", code: "trailing_comma_select" as const },
		{ pattern: /,\s*GROUP\s+BY\b/gi, clause: "SELECT", code: "trailing_comma_select" as const },
		{ pattern: /,\s*ORDER\s+BY\b/gi, clause: "clause before ORDER BY", code: "trailing_comma_orderby" as const },
		{ pattern: /,\s*HAVING\b/gi, clause: "GROUP BY", code: "trailing_comma_groupby" as const },
		{ pattern: /,\s*LIMIT\b/gi, clause: "clause before LIMIT", code: "trailing_comma_select" as const },
		{ pattern: /,\s*;/g, clause: "statement", code: "trailing_comma_select" as const },
		{ pattern: /,\s*$/g, clause: "statement", code: "trailing_comma_select" as const },
	]

	for (const { pattern, clause, code } of trailingCommaPatterns) {
		const match = pattern.exec(normalSQL)
		if (match) {
			issues.push({
				code,
				severity: "error",
				message: `Trailing comma in ${clause}`,
				hint: "Remove the trailing comma before the next keyword",
				span: { start: match.index, end: match.index + 1 },
			})
		}
	}

	return issues
}

/**
 * Check for JOIN without ON/USING clause
 */
function checkJoinWithoutCondition(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []

	// Find all JOINs (except CROSS JOIN and NATURAL JOIN which don't need ON)
	const joinPattern = /\b((?:LEFT|RIGHT|INNER|OUTER|FULL)?\s*JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?)\s*/gi

	let match
	while ((match = joinPattern.exec(normalSQL)) !== null) {
		const joinEnd = match.index + match[0].length
		const afterJoin = normalSQL.substring(joinEnd, joinEnd + 30).toUpperCase()

		// Check if ON or USING follows
		if (!afterJoin.match(/^\s*(ON|USING)\b/)) {
			// Check if this is a CROSS JOIN or NATURAL JOIN (which don't need ON)
			const beforeJoin = normalSQL.substring(Math.max(0, match.index - 10), match.index).toUpperCase()
			if (!beforeJoin.includes("CROSS") && !beforeJoin.includes("NATURAL")) {
				issues.push({
					code: "join_without_condition",
					severity: "error",
					message: `JOIN without ON or USING clause`,
					hint: "Add ON condition to specify how tables should be joined",
					span: { start: match.index, end: joinEnd },
				})
			}
		}
	}

	return issues
}

/**
 * Extract table aliases from SQL
 */
function extractAliases(normalSQL: string): Map<string, string> {
	const aliases = new Map<string, string>()

	// Pattern: FROM/JOIN table_name [AS] alias
	const aliasPattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|,|ON|WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|;|$)/gi

	let match
	while ((match = aliasPattern.exec(normalSQL)) !== null) {
		const tableName = match[1].toLowerCase()
		const alias = match[2].toLowerCase()

		// Skip if alias is a SQL keyword
		const keywords = ["on", "where", "group", "order", "limit", "having", "join", "left", "right", "inner", "outer", "cross", "natural", "and", "or", "as"]
		if (!keywords.includes(alias)) {
			aliases.set(alias, tableName)
		}
	}

	// Also add tables without aliases (table references itself)
	const tablePattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*(?:,|ON|WHERE|GROUP|ORDER|LIMIT|;|$))/gi
	while ((match = tablePattern.exec(normalSQL)) !== null) {
		const tableName = match[1].toLowerCase()
		if (!aliases.has(tableName)) {
			aliases.set(tableName, tableName)
		}
	}

	return aliases
}

/**
 * Extract tables referenced in FROM/JOIN
 */
function extractTablesReferenced(normalSQL: string): string[] {
	const tables: string[] = []

	const tablePattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi

	let match
	while ((match = tablePattern.exec(normalSQL)) !== null) {
		const tableName = match[1].toLowerCase()
		if (!tables.includes(tableName)) {
			tables.push(tableName)
		}
	}

	return tables
}

/**
 * Check for undefined aliases (alias used in SELECT/WHERE/etc but not defined in FROM/JOIN)
 */
function checkUndefinedAliases(normalSQL: string, aliases: Map<string, string>): LintIssue[] {
	const issues: LintIssue[] = []

	// Find alias.column references
	const aliasRefPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi

	let match
	while ((match = aliasRefPattern.exec(normalSQL)) !== null) {
		const aliasOrTable = match[1].toLowerCase()

		// Skip if it's a known alias or table
		if (!aliases.has(aliasOrTable)) {
			// Check if it might be a schema-qualified name (schema.table)
			// by looking if it's used in FROM/JOIN
			const isSchemaQualified = normalSQL.toUpperCase().includes(`FROM ${match[0].toUpperCase()}`) ||
				normalSQL.toUpperCase().includes(`JOIN ${match[0].toUpperCase()}`)

			if (!isSchemaQualified) {
				issues.push({
					code: "undefined_alias",
					severity: "error",
					message: `Undefined alias or table reference: ${aliasOrTable}`,
					hint: `Define alias '${aliasOrTable}' in FROM or JOIN clause, or use a valid table name`,
					span: { start: match.index, end: match.index + aliasOrTable.length },
				})
			}
		}
	}

	return issues
}

/**
 * Check for aggregate functions without GROUP BY
 */
function checkAggregateWithoutGroupBy(normalSQL: string): {
	issues: LintIssue[]
	hasAggregates: boolean
	hasGroupBy: boolean
} {
	const issues: LintIssue[] = []
	const upperSQL = normalSQL.toUpperCase()

	// Common aggregate functions
	const aggregateFunctions = ["COUNT", "SUM", "AVG", "MIN", "MAX", "ARRAY_AGG", "STRING_AGG", "BOOL_AND", "BOOL_OR"]
	const aggregatePattern = new RegExp(`\\b(${aggregateFunctions.join("|")})\\s*\\(`, "gi")

	const hasAggregates = aggregatePattern.test(normalSQL)
	const hasGroupBy = /\bGROUP\s+BY\b/i.test(normalSQL)

	// If we have aggregates, check if there are non-aggregated columns in SELECT
	if (hasAggregates && !hasGroupBy) {
		// Extract SELECT clause
		const selectMatch = normalSQL.match(/\bSELECT\s+(.*?)\s+FROM\b/is)
		if (selectMatch) {
			const selectClause = selectMatch[1]

			// Split by comma (simplified - doesn't handle nested function calls perfectly)
			const selectItems = selectClause.split(/,(?![^()]*\))/)

			let hasNonAggregate = false
			for (const item of selectItems) {
				const trimmed = item.trim()
				// Check if this item contains an aggregate function
				const itemHasAggregate = aggregateFunctions.some((fn) =>
					new RegExp(`\\b${fn}\\s*\\(`, "i").test(trimmed)
				)

				// Check if it's a column reference (not a literal or aggregate)
				const isColumnRef = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?(\s+AS\s+[a-zA-Z_][a-zA-Z0-9_]*)?$/i.test(trimmed)

				if (!itemHasAggregate && isColumnRef && trimmed !== "*") {
					hasNonAggregate = true
				}
			}

			if (hasNonAggregate) {
				issues.push({
					code: "non_aggregate_in_select",
					severity: "warn",
					message: "SELECT contains non-aggregated columns with aggregate functions but no GROUP BY",
					hint: "Either add GROUP BY clause or wrap columns in aggregate functions",
				})
			}
		}
	}

	return { issues, hasAggregates, hasGroupBy }
}

/**
 * Check for empty SELECT or FROM clauses
 */
function checkEmptyClauses(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []

	// Empty SELECT
	if (/\bSELECT\s+FROM\b/i.test(normalSQL)) {
		issues.push({
			code: "empty_select",
			severity: "error",
			message: "Empty SELECT clause",
			hint: "Specify columns to select (e.g., SELECT * FROM or SELECT column1, column2 FROM)",
		})
	}

	// Missing FROM (SELECT without FROM is valid in Postgres for expressions, but warn)
	if (/\bSELECT\b/i.test(normalSQL) && !/\bFROM\b/i.test(normalSQL)) {
		// Check if it's a simple expression SELECT (like SELECT 1+1 or SELECT NOW())
		const afterSelect = normalSQL.replace(/^.*?\bSELECT\s+/i, "")
		const isExpression = /^[^a-zA-Z_]*\d|^[a-zA-Z_]+\s*\(/i.test(afterSelect)

		if (!isExpression) {
			issues.push({
				code: "empty_from",
				severity: "warn",
				message: "SELECT without FROM clause",
				hint: "Add FROM clause to specify the table(s) to query",
			})
		}
	}

	return issues
}

/**
 * Extract GROUP BY columns
 */
function extractGroupByColumns(normalSQL: string): string[] {
	const columns: string[] = []

	const groupByMatch = normalSQL.match(/\bGROUP\s+BY\s+(.+?)(?:\s+HAVING|\s+ORDER|\s+LIMIT|\s*;|\s*$)/is)
	if (groupByMatch) {
		const groupByClause = groupByMatch[1]
		const items = groupByClause.split(/,(?![^()]*\))/)

		for (const item of items) {
			const trimmed = item.trim().toLowerCase()
			if (trimmed) {
				columns.push(trimmed)
			}
		}
	}

	return columns
}

// ============================================================================
// Main Lint Function
// ============================================================================

/**
 * Lint SQL for structural issues
 *
 * This runs deterministic checks that can catch errors before EXPLAIN.
 * If lint returns errors, skip EXPLAIN and directly call repair with lint issues.
 */
export function lintSQL(sql: string): LintResult {
	const tokens = tokenizeSQL(sql)
	const normalSQL = getNormalSQL(tokens)

	const allIssues: LintIssue[] = []

	// Run all checks
	allIssues.push(...checkUnbalancedParens(normalSQL))
	allIssues.push(...checkUnclosedQuotes(sql, tokens))
	allIssues.push(...checkTrailingCommas(normalSQL))
	allIssues.push(...checkJoinWithoutCondition(normalSQL))

	const aliases = extractAliases(normalSQL)
	allIssues.push(...checkUndefinedAliases(normalSQL, aliases))

	const { issues: aggregateIssues, hasAggregates, hasGroupBy } = checkAggregateWithoutGroupBy(normalSQL)
	allIssues.push(...aggregateIssues)

	allIssues.push(...checkEmptyClauses(normalSQL))

	// Extract metadata
	const tablesReferenced = extractTablesReferenced(normalSQL)
	const groupByColumns = extractGroupByColumns(normalSQL)

	// Extract columns selected (simplified)
	const columnsSelected: string[] = []
	const selectMatch = normalSQL.match(/\bSELECT\s+(.*?)\s+FROM\b/is)
	if (selectMatch) {
		const selectClause = selectMatch[1]
		const items = selectClause.split(/,(?![^()]*\))/)
		for (const item of items) {
			const trimmed = item.trim()
			// Extract column name (may have alias)
			const colMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)/i)
			if (colMatch) {
				columnsSelected.push(colMatch[1].toLowerCase())
			}
		}
	}

	// Determine if valid (no errors)
	const hasErrors = allIssues.some((i) => i.severity === "error")

	return {
		valid: !hasErrors,
		issues: allIssues,
		hasErrors,
		metadata: {
			aliases,
			tablesReferenced,
			columnsSelected,
			hasAggregates,
			hasGroupBy,
			groupByColumns,
		},
	}
}

/**
 * Format lint issues for repair prompt
 */
export function formatLintIssuesForRepair(issues: LintIssue[]): string {
	if (issues.length === 0) return ""

	const lines = ["## SQL Lint Errors Detected", ""]

	const errors = issues.filter((i) => i.severity === "error")
	const warnings = issues.filter((i) => i.severity === "warn")

	if (errors.length > 0) {
		lines.push("**Errors (must fix):**")
		for (const issue of errors) {
			lines.push(`- ${issue.message}`)
			if (issue.hint) {
				lines.push(`  Hint: ${issue.hint}`)
			}
		}
		lines.push("")
	}

	if (warnings.length > 0) {
		lines.push("**Warnings:**")
		for (const issue of warnings) {
			lines.push(`- ${issue.message}`)
			if (issue.hint) {
				lines.push(`  Hint: ${issue.hint}`)
			}
		}
		lines.push("")
	}

	return lines.join("\n")
}

/**
 * Convert lint issues to validator issues format for repair request
 */
export function lintIssuesToValidatorIssues(
	issues: LintIssue[],
): Array<{
	code: string
	severity: "error" | "warning" | "info"
	message: string
	suggestion?: string
}> {
	return issues.map((issue) => ({
		code: `LINT_${issue.code.toUpperCase()}`,
		severity: issue.severity === "error" ? "error" : "warning",
		message: issue.message,
		suggestion: issue.hint,
	}))
}
