/**
 * SQL Validation, Linting, Autocorrect & PG Normalization
 *
 * Consolidated module combining:
 * - sql_validator.ts — Structural validation (SELECT-only, dangerous keywords, tables)
 * - sql_lint.ts — Deterministic SQL linting (parens, quotes, trailing commas, JOINs)
 * - sql_autocorrect.ts — Automatic SQL fixes (column fuzzy match, alias resolution)
 * - pg_normalize.ts — PostgreSQL dialect normalization (MySQL/Oracle → PG)
 */

import type { SchemaContextPacket } from "./schema_types.js"
import { getConfig } from "./config/loadConfig.js"

// ============================================================================
// Feature Flag (PG Normalization)
// ============================================================================

export const PG_NORMALIZE_ENABLED = process.env.PG_NORMALIZE_ENABLED !== undefined
	? process.env.PG_NORMALIZE_ENABLED !== "false"
	: getConfig().features.pg_normalize

// ============================================================================
// Validator Types
// ============================================================================

export interface ValidationContext {
	allowedTables: string[]
	maxLimit?: number
	maxJoins?: number
	requireLimit?: boolean
}

export interface ValidationResult {
	valid: boolean
	sql: string // Original or auto-fixed
	issues: ValidationIssue[]
	autoFixed: boolean
	executableSafely: boolean // Can attempt EXPLAIN/EXECUTE
}

export interface ValidationIssue {
	code: IssueCode
	severity: "error" | "warning" | "info"
	message: string
	action: "fail_fast" | "auto_fix" | "rewrite" | "review"
	location?: { line?: number; column?: number; context?: string }
	suggestion?: string
}

export type IssueCode =
	// Structure issues
	| "MULTIPLE_STATEMENTS"
	| "NO_SELECT"
	| "MISSING_SEMICOLON"
	| "NESTED_SEMICOLONS"
	// Safety issues
	| "DANGEROUS_KEYWORD"
	| "WRITE_OPERATION"
	| "DDL_OPERATION"
	| "ADMIN_FUNCTION"
	| "DANGEROUS_FUNCTION"
	// Schema issues
	| "UNKNOWN_TABLE"
	| "UNKNOWN_COLUMN"
	| "AMBIGUOUS_IDENTIFIER"
	// Performance issues
	| "MISSING_LIMIT"
	| "EXCESSIVE_JOINS"
	| "CARTESIAN_PRODUCT"
	// Syntax issues
	| "INVALID_SYNTAX"
	| "UNBALANCED_PARENS"
	| "QUOTE_MISMATCH"

// ============================================================================
// Lint Types
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
// Autocorrect Types
// ============================================================================

export interface CrossTableHint {
	parent_table: string
	column: string
	fk_join: string        // "order_lines.order_id = sales_orders.order_id"
	instruction: string    // Human-readable for repair prompt
}

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

	/** Cross-table hint when column found on FK-parent table */
	cross_table_hint?: CrossTableHint

	/** Phantom column hint when column doesn't exist anywhere */
	phantom_column_hint?: string
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
// PG Normalize Types
// ============================================================================

export interface PgNormalizeResult {
	/** Normalized SQL */
	sql: string
	/** List of transform names applied */
	applied: string[]
	/** Whether any transforms were applied */
	changed: boolean
}

// ============================================================================
// Shared Tokenizer
// ============================================================================

/**
 * Token types for state machine
 */
enum TokenType {
	NORMAL = "NORMAL",
	SINGLE_QUOTE = "SINGLE_QUOTE",
	DOUBLE_QUOTE = "DOUBLE_QUOTE",
	DOLLAR_QUOTE = "DOLLAR_QUOTE",
	LINE_COMMENT = "LINE_COMMENT",
	BLOCK_COMMENT = "BLOCK_COMMENT",
}

/**
 * Token extracted from SQL
 */
interface Token {
	type: TokenType
	value: string
	start: number
	end: number
}

/**
 * Tokenize SQL with proper handling of strings, comments, and dollar quoting
 */
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
			if (i < len) i++ // Skip newline
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
					// Check for escaped quote ''
					if (i + 1 < len && sql[i + 1] === "'") {
						i += 2 // Skip both quotes
						continue
					}
					i++ // Skip closing quote
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
					// Check for escaped quote ""
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
			// Extract tag (between first two $)
			let tag = ""
			while (i < len && sql[i] !== "$") {
				tag += sql[i]
				i++
			}
			if (i < len) i++ // Skip second $

			const openDelim = "$" + tag + "$"
			const closeDelim = openDelim

			// Find closing delimiter
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

		// Normal token (accumulate until special char)
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
			// Single special char that's not part of a comment/string
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

/**
 * Extract all NORMAL tokens (code outside strings/comments)
 */
function getNormalTokens(tokens: Token[]): Token[] {
	return tokens.filter((t) => t.type === TokenType.NORMAL)
}

function getNormalSQL(tokens: Token[]): string {
	return getNormalTokens(tokens).map((t) => t.value).join("")
}

// ============================================================================
// Dangerous Keywords/Functions Lists (Validator)
// ============================================================================

const DANGEROUS_KEYWORDS = [
	// DDL
	"DROP", "CREATE", "ALTER", "TRUNCATE", "RENAME",
	// DML (write operations)
	"INSERT", "UPDATE", "DELETE",
	// DCL
	"GRANT", "REVOKE",
	// TCL
	"BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
	// Other dangerous
	"COPY", "EXECUTE", "PREPARE",
]

const DANGEROUS_FUNCTIONS = [
	// File I/O
	"pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_export", "lo_import",
	// System functions
	"pg_sleep", "pg_terminate_backend", "pg_cancel_backend",
	// External connections
	"dblink", "dblink_connect", "dblink_exec", "postgres_fdw",
	// Admin functions
	"pg_reload_conf", "pg_rotate_logfile", "pg_stat_reset",
]

// ============================================================================
// Validator Internal Functions
// ============================================================================

function checkMultipleStatements(
	tokens: Token[],
): { hasMultiple: boolean; semicolonPositions: number[] } {
	const normalTokens = getNormalTokens(tokens)
	const semicolonPositions: number[] = []

	for (const token of normalTokens) {
		for (let i = 0; i < token.value.length; i++) {
			if (token.value[i] === ";") {
				const position = token.start + i
				semicolonPositions.push(position)
			}
		}
	}

	if (semicolonPositions.length === 0) {
		return { hasMultiple: false, semicolonPositions: [] }
	}

	if (semicolonPositions.length === 1) {
		const lastSemiPos = semicolonPositions[0]
		const afterSemi = tokens.filter((t) => t.start > lastSemiPos)
		const hasCodeAfterSemi = afterSemi.some(
			(t) => t.type === TokenType.NORMAL && t.value.trim().length > 0,
		)
		return { hasMultiple: hasCodeAfterSemi, semicolonPositions }
	}

	return { hasMultiple: true, semicolonPositions }
}

function checkDangerousKeywords(tokens: Token[]): {
	found: string[]
	positions: number[]
} {
	const normalTokens = getNormalTokens(tokens)
	const found: string[] = []
	const positions: number[] = []

	for (const token of normalTokens) {
		for (const keyword of DANGEROUS_KEYWORDS) {
			const regex = new RegExp(`\\b${keyword}\\b`, "gi")
			let match
			while ((match = regex.exec(token.value)) !== null) {
				found.push(keyword)
				positions.push(token.start + match.index)
			}
		}
	}

	return { found: Array.from(new Set(found)), positions }
}

function checkDangerousFunctions(tokens: Token[]): {
	found: string[]
	positions: number[]
} {
	const normalTokens = getNormalTokens(tokens)
	const found: string[] = []
	const positions: number[] = []

	for (const token of normalTokens) {
		for (const func of DANGEROUS_FUNCTIONS) {
			const regex = new RegExp(`\\b${func}\\s*\\(`, "gi")
			let match
			while ((match = regex.exec(token.value)) !== null) {
				found.push(func)
				positions.push(token.start + match.index)
			}
		}
	}

	return { found: Array.from(new Set(found)), positions }
}

function extractTableNames(tokens: Token[]): string[] {
	const normalTokens = getNormalTokens(tokens)
	const normalSQL = normalTokens.map((t) => t.value).join("")
	const tables: string[] = []

	const extractParts = "YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|EPOCH|QUARTER|WEEK|DOW|DOY|CENTURY|DECADE|ISOYEAR|TIMEZONE|TIMEZONE_HOUR|TIMEZONE_MINUTE"
	const fromLookbehind = `(?<!(?:${extractParts})\\s)(?<!TRIM\\s)(?<!SUBSTRING\\s)(?<!OVERLAY\\s)`
	const patterns = [
		new RegExp(`\\b${fromLookbehind}FROM\\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)?)`, "gi"),
		/\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
		new RegExp(`\\b${fromLookbehind}FROM\\s+"([^"]+)"`, "gi"),
		/\bJOIN\s+"([^"]+)"/gi,
	]

	for (const pattern of patterns) {
		let match
		while ((match = pattern.exec(normalSQL)) !== null) {
			let tableName = match[1]
			if (tableName.includes(".")) {
				tableName = tableName.split(".").pop()!
			}
			tableName = tableName.replace(/"/g, "")
			tables.push(tableName.toLowerCase())
		}
	}

	return Array.from(new Set(tables))
}

function hasLimitClause(sql: string): boolean {
	const tokens = tokenizeSQL(sql)
	const normalSQL = getNormalTokens(tokens)
		.map((t) => t.value)
		.join("")
		.toUpperCase()

	return (
		normalSQL.includes("LIMIT") ||
		normalSQL.includes("FETCH FIRST") ||
		normalSQL.includes("FETCH NEXT")
	)
}

function countJoins(sql: string): number {
	const tokens = tokenizeSQL(sql)
	const normalSQL = getNormalTokens(tokens)
		.map((t) => t.value)
		.join("")
		.toUpperCase()

	return (normalSQL.match(/\bJOIN\b/g) || []).length
}

// ============================================================================
// Validator: Main
// ============================================================================

export function validateSQL(
	sql: string,
	context: ValidationContext,
): ValidationResult {
	const issues: ValidationIssue[] = []
	let autoFixed = false
	let currentSQL = sql.trim()

	const tokens = tokenizeSQL(currentSQL)

	// Rule 1: Must start with SELECT
	const normalTokens = getNormalTokens(tokens)
	const firstCodeToken = normalTokens.find((t) => t.value.trim().length > 0)
	if (!firstCodeToken || !firstCodeToken.value.trim().toUpperCase().startsWith("SELECT")) {
		issues.push({
			code: "NO_SELECT",
			severity: "error",
			action: "fail_fast",
			message: "Query must start with SELECT",
			suggestion: "Only SELECT queries are allowed",
		})
		return {
			valid: false,
			sql: currentSQL,
			issues,
			autoFixed: false,
			executableSafely: false,
		}
	}

	// Rule 2: Single statement only
	const { hasMultiple, semicolonPositions } = checkMultipleStatements(tokens)
	if (hasMultiple) {
		issues.push({
			code: "MULTIPLE_STATEMENTS",
			severity: "error",
			action: "fail_fast",
			message: "Multiple statements detected (separated by semicolons)",
			suggestion: "Submit only one SELECT statement",
		})
		return {
			valid: false,
			sql: currentSQL,
			issues,
			autoFixed: false,
			executableSafely: false,
		}
	}

	// Optional: Add trailing semicolon if missing
	if (semicolonPositions.length === 0) {
		currentSQL = currentSQL + ";"
		autoFixed = true
		issues.push({
			code: "MISSING_SEMICOLON",
			severity: "info",
			action: "auto_fix",
			message: "Added trailing semicolon for consistency",
		})
	}

	// Rule 3: Check for dangerous keywords
	const { found: keywords } = checkDangerousKeywords(tokens)
	if (keywords.length > 0) {
		issues.push({
			code: "DANGEROUS_KEYWORD",
			severity: "error",
			action: "fail_fast",
			message: `Dangerous keywords detected: ${keywords.join(", ")}`,
			suggestion: "Only SELECT queries are allowed",
		})
		return {
			valid: false,
			sql: currentSQL,
			issues,
			autoFixed,
			executableSafely: false,
		}
	}

	// Rule 4: Check for dangerous functions
	const { found: functions } = checkDangerousFunctions(tokens)
	if (functions.length > 0) {
		issues.push({
			code: "DANGEROUS_FUNCTION",
			severity: "error",
			action: "fail_fast",
			message: `Dangerous functions detected: ${functions.join(", ")}`,
			suggestion: "Admin functions and file I/O are not allowed",
		})
		return {
			valid: false,
			sql: currentSQL,
			issues,
			autoFixed,
			executableSafely: false,
		}
	}

	// Rule 5: Table allowlist enforcement
	const tablesUsed = extractTableNames(tokens)
	const unknownTables = tablesUsed.filter(
		(table) => !context.allowedTables.map((t) => t.toLowerCase()).includes(table),
	)
	if (unknownTables.length > 0) {
		issues.push({
			code: "UNKNOWN_TABLE",
			severity: "error",
			action: "rewrite",
			message: `Unknown tables: ${unknownTables.join(", ")}`,
			suggestion: `Use only these tables: ${context.allowedTables.join(", ")}`,
		})
	}

	// Rule 6: LIMIT enforcement (auto-fix)
	const requireLimit = context.requireLimit !== false
	if (requireLimit && !hasLimitClause(currentSQL)) {
		const maxLimit = context.maxLimit || 1000
		if (currentSQL.endsWith(";")) {
			currentSQL = currentSQL.slice(0, -1) + ` LIMIT ${maxLimit};`
		} else {
			currentSQL = currentSQL + ` LIMIT ${maxLimit}`
		}
		autoFixed = true
		issues.push({
			code: "MISSING_LIMIT",
			severity: "warning",
			action: "auto_fix",
			message: `Added LIMIT ${maxLimit} for safety`,
			suggestion: "Always include LIMIT in your queries",
		})
	}

	// Rule 7: Excessive JOINs (warning)
	const maxJoins = context.maxJoins || 5
	const joinCount = countJoins(currentSQL)
	if (joinCount > maxJoins) {
		issues.push({
			code: "EXCESSIVE_JOINS",
			severity: "warning",
			action: "review",
			message: `Query has ${joinCount} JOINs (max recommended: ${maxJoins})`,
			suggestion: "Consider splitting into multiple queries",
		})
	}

	const hasErrors = issues.some((i) => i.severity === "error")
	const hasFailFast = issues.some((i) => i.action === "fail_fast")

	return {
		valid: !hasErrors,
		sql: currentSQL,
		issues,
		autoFixed,
		executableSafely: !hasFailFast,
	}
}

export function compressIssuesForRepair(issues: ValidationIssue[]): string[] {
	const instructions: string[] = []
	const seen = new Set<string>()

	for (const issue of issues) {
		let instruction = ""

		switch (issue.code) {
			case "MULTIPLE_STATEMENTS":
				instruction = "Output one SELECT statement only, no multiple queries"
				break
			case "NO_SELECT":
				instruction = "Query must start with SELECT"
				break
			case "DANGEROUS_KEYWORD":
			case "WRITE_OPERATION":
			case "DDL_OPERATION":
				instruction = "Remove write operations (INSERT/UPDATE/DELETE/DROP/etc)"
				break
			case "DANGEROUS_FUNCTION":
			case "ADMIN_FUNCTION":
				instruction = "Remove admin functions and file I/O (pg_read_file, COPY, etc)"
				break
			case "UNKNOWN_TABLE":
				if (issue.suggestion) {
					instruction = issue.suggestion
				} else {
					instruction = "Use only allowed tables"
				}
				break
			case "UNKNOWN_COLUMN":
				instruction = issue.message
				break
			case "MISSING_LIMIT":
				instruction = "Add LIMIT clause to restrict rows"
				break
			case "EXCESSIVE_JOINS":
				instruction = "Simplify query: reduce number of JOINs or split into multiple queries"
				break
			default:
				instruction = issue.message
		}

		if (!seen.has(instruction)) {
			seen.add(instruction)
			instructions.push(instruction)
		}
	}

	return instructions
}

export function formatIssuesForLog(issues: ValidationIssue[]): string {
	return issues
		.map((i) => {
			const emoji =
				i.severity === "error" ? "❌" : i.severity === "warning" ? "⚠️" : "ℹ️"
			return `${emoji} [${i.code}] ${i.message}`
		})
		.join("\n")
}

// ============================================================================
// Lint: Internal Check Functions
// ============================================================================

function checkUnbalancedParens(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []
	let depth = 0
	let lastOpenPos = -1

	for (let i = 0; i < normalSQL.length; i++) {
		if (normalSQL[i] === "(") {
			depth++
			lastOpenPos = i
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
				depth = 0
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

function checkUnclosedQuotes(sql: string, tokens: Token[]): LintIssue[] {
	const issues: LintIssue[] = []

	const singleQuoteTokens = tokens.filter((t) => t.type === TokenType.SINGLE_QUOTE)
	for (const token of singleQuoteTokens) {
		const value = token.value
		let quoteCount = 0
		for (let i = 0; i < value.length; i++) {
			if (value[i] === "'") {
				if (i + 1 < value.length && value[i + 1] === "'") {
					i++
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

function checkTrailingCommas(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []

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

function checkJoinWithoutCondition(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []

	const joinPattern = /\b((?:LEFT|RIGHT|INNER|OUTER|FULL)?\s*JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?)\s*/gi

	let match
	while ((match = joinPattern.exec(normalSQL)) !== null) {
		const joinEnd = match.index + match[0].length
		const afterJoin = normalSQL.substring(joinEnd, joinEnd + 30).toUpperCase()

		if (!afterJoin.match(/^\s*(ON|USING)\b/)) {
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

function lintExtractAliases(normalSQL: string): Map<string, string> {
	const aliases = new Map<string, string>()

	const aliasPattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|,|ON|WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|OUTER|FULL|JOIN|;|$)/gi

	let match
	while ((match = aliasPattern.exec(normalSQL)) !== null) {
		const tableName = match[1].toLowerCase()
		const alias = match[2].toLowerCase()

		const keywords = ["on", "where", "group", "order", "limit", "having", "join", "left", "right", "inner", "outer", "cross", "natural", "and", "or", "as"]
		if (!keywords.includes(alias)) {
			aliases.set(alias, tableName)
		}
	}

	const tablePattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*(?:,|ON|WHERE|GROUP|ORDER|LIMIT|;|$))/gi
	while ((match = tablePattern.exec(normalSQL)) !== null) {
		const tableName = match[1].toLowerCase()
		if (!aliases.has(tableName)) {
			aliases.set(tableName, tableName)
		}
	}

	return aliases
}

function lintExtractTablesReferenced(normalSQL: string): string[] {
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

function checkUndefinedAliases(normalSQL: string, aliases: Map<string, string>): LintIssue[] {
	const issues: LintIssue[] = []

	const aliasRefPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi

	let match
	while ((match = aliasRefPattern.exec(normalSQL)) !== null) {
		const aliasOrTable = match[1].toLowerCase()

		if (!aliases.has(aliasOrTable)) {
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

function checkAggregateWithoutGroupBy(normalSQL: string): {
	issues: LintIssue[]
	hasAggregates: boolean
	hasGroupBy: boolean
} {
	const issues: LintIssue[] = []

	const aggregateFunctions = ["COUNT", "SUM", "AVG", "MIN", "MAX", "ARRAY_AGG", "STRING_AGG", "BOOL_AND", "BOOL_OR"]
	const aggregatePattern = new RegExp(`\\b(${aggregateFunctions.join("|")})\\s*\\(`, "gi")

	const hasAggregates = aggregatePattern.test(normalSQL)
	const hasGroupBy = /\bGROUP\s+BY\b/i.test(normalSQL)

	if (hasAggregates && !hasGroupBy) {
		const selectMatch = normalSQL.match(/\bSELECT\s+(.*?)\s+FROM\b/is)
		if (selectMatch) {
			const selectClause = selectMatch[1]
			const selectItems = selectClause.split(/,(?![^()]*\))/)

			let hasNonAggregate = false
			for (const item of selectItems) {
				const trimmed = item.trim()
				const itemHasAggregate = aggregateFunctions.some((fn) =>
					new RegExp(`\\b${fn}\\s*\\(`, "i").test(trimmed)
				)
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

function checkEmptyClauses(normalSQL: string): LintIssue[] {
	const issues: LintIssue[] = []

	if (/\bSELECT\s+FROM\b/i.test(normalSQL)) {
		issues.push({
			code: "empty_select",
			severity: "error",
			message: "Empty SELECT clause",
			hint: "Specify columns to select (e.g., SELECT * FROM or SELECT column1, column2 FROM)",
		})
	}

	if (/\bSELECT\b/i.test(normalSQL) && !/\bFROM\b/i.test(normalSQL)) {
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
// Lint: Main
// ============================================================================

export function lintSQL(sql: string): LintResult {
	const tokens = tokenizeSQL(sql)
	const normalSQL = getNormalSQL(tokens)

	const allIssues: LintIssue[] = []

	allIssues.push(...checkUnbalancedParens(normalSQL))
	allIssues.push(...checkUnclosedQuotes(sql, tokens))
	allIssues.push(...checkTrailingCommas(normalSQL))
	allIssues.push(...checkJoinWithoutCondition(normalSQL))

	const aliases = lintExtractAliases(normalSQL)
	allIssues.push(...checkUndefinedAliases(normalSQL, aliases))

	const { issues: aggregateIssues, hasAggregates, hasGroupBy } = checkAggregateWithoutGroupBy(normalSQL)
	allIssues.push(...aggregateIssues)

	allIssues.push(...checkEmptyClauses(normalSQL))

	const tablesReferenced = lintExtractTablesReferenced(normalSQL)
	const groupByColumns = extractGroupByColumns(normalSQL)

	const columnsSelected: string[] = []
	const selectMatch = normalSQL.match(/\bSELECT\s+(.*?)\s+FROM\b/is)
	if (selectMatch) {
		const selectClause = selectMatch[1]
		const items = selectClause.split(/,(?![^()]*\))/)
		for (const item of items) {
			const trimmed = item.trim()
			const colMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)/i)
			if (colMatch) {
				columnsSelected.push(colMatch[1].toLowerCase())
			}
		}
	}

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

// ============================================================================
// Autocorrect: Configuration
// ============================================================================

const AUTOCORRECT_CONFIG = {
	minConfidence: 0.70,
	minCandidateScore: 0.4,
	maxCandidates: 5,
	matchScores: {
		exact_case: 1.0,
		exact_lower: 0.95,
		snake_normalized: 0.85,
		prefix: 0.7,
		suffix: 0.65,
		fuzzy: 0.6,
	},
}

// ============================================================================
// Autocorrect: Error Parsing
// ============================================================================

export function parseUndefinedColumn(message: string): {
	column: string
	tableHint?: string
} | null {
	const withRelation = /column "?([^"]+)"? of relation "?([^"]+)"? does not exist/i
	const match1 = message.match(withRelation)
	if (match1) {
		return { column: match1[1], tableHint: match1[2] }
	}

	const quotedQualified = /column "([^"]+)\.([^"]+)" does not exist/i
	const match2a = message.match(quotedQualified)
	if (match2a) {
		return { column: match2a[2], tableHint: match2a[1] }
	}

	const simpleQuoted = /column "([^"]+)" does not exist/i
	const match2 = message.match(simpleQuoted)
	if (match2) {
		return { column: match2[1] }
	}

	const unquotedQualified = /column ([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*) does not exist/i
	const match3a = message.match(unquotedQualified)
	if (match3a) {
		return { column: match3a[2], tableHint: match3a[1] }
	}

	const simpleUnquoted = /column (\w+) does not exist/i
	const match3 = message.match(simpleUnquoted)
	if (match3) {
		return { column: match3[1] }
	}

	return null
}

export function parseMissingTable(message: string): string | null {
	const fromClause = /missing FROM-clause entry for table "?([^"]+)"?/i
	const match1 = message.match(fromClause)
	if (match1) {
		return match1[1]
	}

	const relation = /relation "?([^"]+)"? does not exist/i
	const match2 = message.match(relation)
	if (match2) {
		return match2[1]
	}

	return null
}

// ============================================================================
// Autocorrect: SQL Parsing Utilities
// ============================================================================

export function extractAliases(sql: string): AliasMap {
	const aliases: AliasMap = {}

	const normalized = sql.replace(/\s+/g, " ")

	const aliasPattern = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|,|ON|WHERE|GROUP|ORDER|LIMIT|;|$)/gi

	let match
	while ((match = aliasPattern.exec(normalized)) !== null) {
		const tableName = match[1].toLowerCase()
		const alias = match[2].toLowerCase()

		const keywords = ["on", "where", "group", "order", "limit", "having", "join", "left", "right", "inner", "outer", "cross", "natural", "and", "or"]
		if (!keywords.includes(alias)) {
			aliases[alias] = tableName
		}
	}

	return aliases
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replaceIdentifier(sql: string, oldId: string, newId: string): string {
	const pattern = new RegExp(`\\b${escapeRegex(oldId)}\\b`, "gi")
	return sql.replace(pattern, newId)
}

// ============================================================================
// Autocorrect: Column Candidate Matching
// ============================================================================

export function buildColumnCandidates(
	schemaContext: SchemaContextPacket,
	undefinedColumn: string,
	tableHint?: string,
): ColumnCandidate[] {
	const candidates: ColumnCandidate[] = []
	const searchLower = undefinedColumn.toLowerCase()
	const searchNormalized = normalizeSnakeCase(searchLower)

	for (const table of schemaContext.tables) {
		const isHintedTable = tableHint?.toLowerCase() === table.table_name.toLowerCase()

		const columns = parseColumnsFromMSchema(table.m_schema)

		for (const col of columns) {
			const colLower = col.name.toLowerCase()
			const colNormalized = normalizeSnakeCase(colLower)
			const qualifiedName = `${table.table_name}.${col.name}`

			let matchType: ColumnCandidate["match_type"] | null = null
			let score = 0

			if (col.name === undefinedColumn) {
				matchType = "exact_case"
				score = AUTOCORRECT_CONFIG.matchScores.exact_case
			}
			else if (colLower === searchLower) {
				matchType = "exact_lower"
				score = AUTOCORRECT_CONFIG.matchScores.exact_lower
			}
			else if (colNormalized === searchNormalized) {
				matchType = "snake_normalized"
				score = AUTOCORRECT_CONFIG.matchScores.snake_normalized
			}
			else if (colLower.startsWith(searchLower) || searchLower.startsWith(colLower)) {
				matchType = "prefix"
				score = AUTOCORRECT_CONFIG.matchScores.prefix
			}
			else if (colLower.endsWith(searchLower) || searchLower.endsWith(colLower)) {
				matchType = "suffix"
				score = AUTOCORRECT_CONFIG.matchScores.suffix
			}
			else {
				const distance = levenshteinDistance(searchLower, colLower)
				const maxLen = Math.max(searchLower.length, colLower.length)
				const similarity = 1 - distance / maxLen

				if (similarity >= 0.5) {
					matchType = "fuzzy"
					score = AUTOCORRECT_CONFIG.matchScores.fuzzy * similarity
				}
			}

			// Containment bonus: if search term is fully contained in column name or vice versa
			if (matchType && searchLower.length >= 3) {
				if (colLower.includes(searchLower) || searchLower.includes(colLower)) {
					score = Math.min(1.0, score + 0.10)
				}
			}

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

	candidates.sort((a, b) => b.match_score - a.match_score)
	return candidates.slice(0, AUTOCORRECT_CONFIG.maxCandidates)
}

function parseColumnsFromMSchema(mSchema: string): Array<{ name: string; type: string }> {
	const columns: Array<{ name: string; type: string }> = []

	const match = mSchema.match(/\(([^)]+)\)/)
	if (!match) return columns

	const content = match[1]
	const parts = content.split(/,\s*/)

	for (const part of parts) {
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

function normalizeSnakeCase(str: string): string {
	return str.replace(/_/g, "")
}

function levenshteinDistance(s1: string, s2: string): number {
	const m = s1.length
	const n = s2.length

	if (m === 0) return n
	if (n === 0) return m

	const d: number[][] = Array(m + 1)
		.fill(null)
		.map(() => Array(n + 1).fill(0))

	for (let i = 0; i <= m; i++) d[i][0] = i
	for (let j = 0; j <= n; j++) d[0][j] = j

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
			d[i][j] = Math.min(
				d[i - 1][j] + 1,
				d[i][j - 1] + 1,
				d[i - 1][j - 1] + cost,
			)
		}
	}

	return d[m][n]
}

// ============================================================================
// Autocorrect: FK Join Helper
// ============================================================================

function findFKJoin(
	schemaContext: SchemaContextPacket,
	fromTable: string,
	toTable: string,
): { from_column: string; to_column: string } | null {
	const fromLower = fromTable.toLowerCase()
	const toLower = toTable.toLowerCase()
	for (const edge of schemaContext.fk_edges) {
		if (edge.from_table.toLowerCase() === fromLower && edge.to_table.toLowerCase() === toLower)
			return { from_column: edge.from_column, to_column: edge.to_column }
		if (edge.from_table.toLowerCase() === toLower && edge.to_table.toLowerCase() === fromLower)
			return { from_column: edge.to_column, to_column: edge.from_column }
	}
	return null
}

// ============================================================================
// Autocorrect: Main Functions
// ============================================================================

export function autocorrectUndefinedColumn(
	sql: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
): AutocorrectResult {
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

	const aliases = extractAliases(sql)
	let resolvedTableHint = tableHint
	if (tableHint) {
		const tableHintLower = tableHint.toLowerCase()
		if (aliases[tableHintLower]) {
			resolvedTableHint = aliases[tableHintLower]
		}
	}

	const candidates = buildColumnCandidates(schemaContext, undefinedColumn, resolvedTableHint)

	if (candidates.length === 0) {
		// Check if column exists ANYWHERE in schema — if not, it's a phantom column
		let phantom_column_hint: string | undefined
		const searchLower = undefinedColumn.toLowerCase()
		let foundAnywhere = false
		for (const table of schemaContext.tables) {
			const columns = parseColumnsFromMSchema(table.m_schema)
			if (columns.some(c => c.name.toLowerCase() === searchLower)) { foundAnywhere = true; break }
		}
		if (!foundAnywhere) {
			phantom_column_hint = `Column '${undefinedColumn}' does not exist in ANY table. Remove the WHERE/reference to '${undefinedColumn}' — if this is a division scope, it is handled automatically by PostgreSQL search_path.`
		}
		return {
			attempted: true,
			success: false,
			sql,
			candidates: [],
			phantom_column_hint,
			failure_reason: phantom_column_hint ? `Phantom column: '${undefinedColumn}'` : `No candidates found for column '${undefinedColumn}'`,
		}
	}

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

	let correctedSQL = sql

	const qualifiedPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\.(${escapeRegex(undefinedColumn)})\\b`, "gi")
	const qualifiedMatches = [...sql.matchAll(qualifiedPattern)]

	if (qualifiedMatches.length > 0) {
		for (const match of qualifiedMatches) {
			const qualifier = match[1]
			const qualifierLower = qualifier.toLowerCase()
			const resolvedTable = aliases[qualifierLower] || qualifierLower

			if (bestCandidate.table_name.toLowerCase() === resolvedTable) {
				const oldText = `${qualifier}.${undefinedColumn}`
				const newText = `${qualifier}.${bestCandidate.column_name}`
				correctedSQL = correctedSQL.replace(new RegExp(escapeRegex(oldText), "gi"), newText)
			}
		}
	} else {
		correctedSQL = replaceIdentifier(sql, undefinedColumn, bestCandidate.column_name)
	}

	if (correctedSQL === sql) {
		// Check if best candidate is on a different (FK-reachable) table → cross-table hint
		let cross_table_hint: CrossTableHint | undefined
		if (bestCandidate && resolvedTableHint) {
			const candidateTable = bestCandidate.table_name.toLowerCase()
			const resolved = resolvedTableHint.toLowerCase()
			if (candidateTable !== resolved) {
				const fk = findFKJoin(schemaContext, resolved, candidateTable)
				if (fk) {
					cross_table_hint = {
						parent_table: bestCandidate.table_name,
						column: bestCandidate.column_name,
						fk_join: `${resolvedTableHint}.${fk.from_column} = ${bestCandidate.table_name}.${fk.to_column}`,
						instruction: `Column '${undefinedColumn}' is on '${bestCandidate.table_name}', not '${resolvedTableHint}'. JOIN ${bestCandidate.table_name} ON ${resolvedTableHint}.${fk.from_column} = ${bestCandidate.table_name}.${fk.to_column} and use ${bestCandidate.table_name}.${bestCandidate.column_name}`,
					}
				}
			}
		}
		return {
			attempted: true,
			success: false,
			sql,
			candidates,
			selected_candidate: bestCandidate,
			cross_table_hint,
			failure_reason: cross_table_hint
				? `Cross-table: found on '${cross_table_hint.parent_table}'`
				: "Replacement pattern not found in SQL",
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
	const aliases = extractAliases(sql)
	const availableTables = schemaContext.tables.map((t) => t.table_name.toLowerCase())
	const possibleTable = availableTables.find((t) => t.startsWith(missingLower) || t[0] === missingLower[0])

	if (possibleTable) {
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

// ============================================================================
// PG Normalize: Internal Helpers
// ============================================================================

function extractParenExpr(sql: string, startIdx: number): { content: string; endIdx: number } | null {
	if (sql[startIdx] !== "(") return null
	let depth = 1
	let i = startIdx + 1
	while (i < sql.length && depth > 0) {
		if (sql[i] === "(") depth++
		else if (sql[i] === ")") depth--
		i++
	}
	if (depth !== 0) return null
	return {
		content: sql.substring(startIdx + 1, i - 1),
		endIdx: i,
	}
}

function transformDateExtract(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const parts = ["YEAR", "MONTH", "DAY"]

	for (const part of parts) {
		const regex = new RegExp(`\\b(${part})\\s*\\(`, "gi")
		let result = sql
		let match: RegExpExecArray | null

		const workingSql = sql
		regex.lastIndex = 0

		while ((match = regex.exec(workingSql)) !== null) {
			const openParenIdx = match.index + match[0].length - 1
			const paren = extractParenExpr(workingSql, openParenIdx)
			if (!paren) continue

			const fullMatch = workingSql.substring(match.index, paren.endIdx)
			const replacement = `EXTRACT(${part.toUpperCase()} FROM ${paren.content})`

			result = result.replace(fullMatch, replacement)
			applied.push(`${part.toUpperCase()}_TO_EXTRACT`)
		}

		sql = result
	}

	return { sql, applied }
}

function transformCoalesce(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const funcs = ["IFNULL", "ISNULL", "NVL"]

	for (const func of funcs) {
		const regex = new RegExp(`\\b${func}\\s*\\(`, "gi")
		if (regex.test(sql)) {
			sql = sql.replace(new RegExp(`\\b${func}\\s*\\(`, "gi"), "COALESCE(")
			applied.push(`${func}_TO_COALESCE`)
		}
	}

	return { sql, applied }
}

function transformDateAddSub(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	for (const [func, op] of [["DATE_ADD", "+"], ["DATE_SUB", "-"]] as const) {
		const regex = new RegExp(`\\b${func}\\s*\\(`, "gi")
		let match: RegExpExecArray | null

		regex.lastIndex = 0
		while ((match = regex.exec(sql)) !== null) {
			const openParenIdx = match.index + match[0].length - 1
			const paren = extractParenExpr(sql, openParenIdx)
			if (!paren) continue

			const content = paren.content.trim()
			const intervalMatch = content.match(/^(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*$/i)
			if (!intervalMatch) continue

			const [, dateExpr, num, unit] = intervalMatch
			const fullMatch = sql.substring(match.index, paren.endIdx)
			const replacement = `${dateExpr.trim()} ${op} INTERVAL '${num} ${unit.toUpperCase()}'`

			sql = sql.replace(fullMatch, replacement)
			applied.push(`${func}_TO_INTERVAL`)

			regex.lastIndex = 0
		}
	}

	return { sql, applied }
}

function transformDatediff(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const regex = /\bDATEDIFF\s*\(/gi

	let match: RegExpExecArray | null
	regex.lastIndex = 0

	while ((match = regex.exec(sql)) !== null) {
		const openParenIdx = match.index + match[0].length - 1
		const paren = extractParenExpr(sql, openParenIdx)
		if (!paren) continue

		const parts = paren.content.split(",").map(p => p.trim())
		if (parts.length !== 2) continue

		const [a, b] = parts
		const fullMatch = sql.substring(match.index, paren.endIdx)
		const replacement = `(${a}::date - ${b}::date)`

		sql = sql.replace(fullMatch, replacement)
		applied.push("DATEDIFF_TO_SUBTRACT")

		regex.lastIndex = 0
	}

	return { sql, applied }
}

function transformGroupConcat(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const regex = /\bGROUP_CONCAT\s*\(/gi

	let match: RegExpExecArray | null
	regex.lastIndex = 0

	while ((match = regex.exec(sql)) !== null) {
		const openParenIdx = match.index + match[0].length - 1
		const paren = extractParenExpr(sql, openParenIdx)
		if (!paren) continue

		const expr = paren.content.trim()
		const fullMatch = sql.substring(match.index, paren.endIdx)
		const replacement = `STRING_AGG(${expr}::text, ', ')`

		sql = sql.replace(fullMatch, replacement)
		applied.push("GROUP_CONCAT_TO_STRING_AGG")

		regex.lastIndex = 0
	}

	return { sql, applied }
}

function transformLimitOffset(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	const regex = /\bLIMIT\s+(\d+)\s*,\s*(\d+)\b/gi
	const match = regex.exec(sql)
	if (match) {
		const [fullMatch, offset, limit] = match
		sql = sql.replace(fullMatch, `LIMIT ${limit} OFFSET ${offset}`)
		applied.push("MYSQL_LIMIT_OFFSET")
	}

	return { sql, applied }
}

function transformBackticks(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	if (sql.includes("`")) {
		sql = sql.replace(/`/g, "")
		applied.push("REMOVE_BACKTICKS")
	}

	return { sql, applied }
}

/**
 * Strip phantom division scope clauses like WHERE division = 'div_19'.
 * Divisions (div_01..div_20) are PostgreSQL schemas handled by search_path,
 * so no column should be filtered by a 'div_XX' literal. LLMs commonly hallucinate
 * these clauses when the question mentions "corporate division div_19".
 */
function transformStripDivisionScope(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	const divLiteral = `'div_\\d+'`
	const colRef = `(?:[\\w]+\\.)?[\\w]+` // optional alias.column

	// Case 1: sole WHERE condition → remove WHERE entirely
	// WHERE col = 'div_XX' [GROUP BY|ORDER BY|LIMIT|HAVING|;|end]
	const soleWhereRe = new RegExp(
		`\\bWHERE\\s+${colRef}\\s*=\\s*${divLiteral}\\s*(?=\\b(?:GROUP|ORDER|LIMIT|HAVING)\\b|;|$)`,
		"gi"
	)
	const beforeSole = sql
	sql = sql.replace(soleWhereRe, "")
	if (sql !== beforeSole) applied.push("STRIP_DIVISION_SCOPE")

	// Case 2: first condition with AND → remove condition, keep WHERE
	// WHERE col = 'div_XX' AND ... → WHERE ...
	const firstCondRe = new RegExp(
		`\\bWHERE\\s+${colRef}\\s*=\\s*${divLiteral}\\s+AND\\s+`,
		"gi"
	)
	const beforeFirst = sql
	sql = sql.replace(firstCondRe, "WHERE ")
	if (sql !== beforeFirst) applied.push("STRIP_DIVISION_SCOPE")

	// Case 3: subsequent condition → remove AND + condition
	// ... AND col = 'div_XX'
	const andCondRe = new RegExp(
		`\\s+AND\\s+${colRef}\\s*=\\s*${divLiteral}`,
		"gi"
	)
	const beforeAnd = sql
	sql = sql.replace(andCondRe, "")
	if (sql !== beforeAnd) applied.push("STRIP_DIVISION_SCOPE")

	return { sql, applied }
}

function transformDivisionSafety(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	const aggregates = ["COUNT", "SUM", "AVG"]
	for (const agg of aggregates) {
		const regex = new RegExp(
			`\\/\\s*(?!NULLIF)(${agg}\\s*\\()`,
			"gi"
		)
		let match: RegExpExecArray | null
		regex.lastIndex = 0

		while ((match = regex.exec(sql)) !== null) {
			const before = sql.substring(Math.max(0, match.index - 7), match.index)
			if (/NULLIF\s*\(\s*$/i.test(before)) continue

			const funcStart = match.index + match[0].length - 1
			const paren = extractParenExpr(sql, funcStart)
			if (!paren) continue

			const fullAggExpr = `${agg}(${paren.content})`
			const slashAndExpr = sql.substring(match.index, paren.endIdx)
			const replacement = `/ NULLIF(${fullAggExpr}, 0)`

			sql = sql.replace(slashAndExpr, replacement)
			applied.push("DIVISION_SAFETY_NULLIF")

			regex.lastIndex = 0
			break
		}
	}

	return { sql, applied }
}

function transformDateIntervalComparison(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	const regex = /\(\s*CURRENT_DATE\s*-\s*([\w.]+)\s*\)\s*(>=?|<=?)\s*(INTERVAL\s+'[^']+')/gi

	let match: RegExpExecArray | null
	regex.lastIndex = 0

	while ((match = regex.exec(sql)) !== null) {
		const [fullMatch, dateCol, op, interval] = match

		const flippedOp = op === ">" ? "<" : op === ">=" ? "<=" : op === "<" ? ">" : ">="
		const replacement = `${dateCol} ${flippedOp} CURRENT_DATE - ${interval}`

		sql = sql.replace(fullMatch, replacement)
		applied.push("DATE_INTERVAL_COMPARISON_FIX")

		regex.lastIndex = 0
	}

	return { sql, applied }
}

function transformDatePartDaySubtract(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const regex = /\bDATE_PART\s*\(\s*'day'\s*,\s*/gi
	let match: RegExpExecArray | null
	regex.lastIndex = 0
	while ((match = regex.exec(sql)) !== null) {
		// Find the full DATE_PART(...) using existing extractParenExpr helper
		const funcNameStart = sql.lastIndexOf("DATE_PART", match.index)
		const openParen = sql.indexOf("(", funcNameStart)
		const paren = extractParenExpr(sql, openParen)
		if (!paren) continue
		// Extract the expression after 'day',
		const content = paren.content.replace(/^\s*'day'\s*,\s*/, "").trim()
		// Only transform simple column subtractions: identifier - identifier
		if (/^[a-zA-Z_][a-zA-Z0-9_.]*\s*-\s*[a-zA-Z_][a-zA-Z0-9_.]*$/.test(content)) {
			const fullMatch = sql.substring(funcNameStart, paren.endIdx)
			sql = sql.replace(fullMatch, `(${content})`)
			applied.push("DATE_PART_DAY_SUBTRACT")
			regex.lastIndex = 0
		}
	}

	// Also handle EXTRACT(DAY FROM expr - expr) — in PG, date - date = integer,
	// so EXTRACT(DAY FROM integer) fails. Just use the subtraction directly.
	const extractDayRegex = /\bEXTRACT\s*\(\s*DAY\s+FROM\s+/gi
	extractDayRegex.lastIndex = 0
	while ((match = extractDayRegex.exec(sql)) !== null) {
		const extractStart = sql.lastIndexOf("EXTRACT", match.index)
		const openParen = sql.indexOf("(", extractStart)
		const paren = extractParenExpr(sql, openParen)
		if (!paren) continue
		// Remove the "DAY FROM" prefix to get the inner expression
		const inner = paren.content.replace(/^\s*DAY\s+FROM\s+/i, "").trim()
		// Match parenthesized or bare date subtractions: (a.col - b.col) or a.col - b.col
		const bareSubtract = /^[a-zA-Z_][\w.]*\s*-\s*[a-zA-Z_][\w.]*$/
		const parenSubtract = /^\(\s*[a-zA-Z_][\w.]*\s*-\s*[a-zA-Z_][\w.]*\s*\)$/
		if (bareSubtract.test(inner) || parenSubtract.test(inner)) {
			const fullMatch = sql.substring(extractStart, paren.endIdx)
			// Normalize to parenthesized form
			const normalized = parenSubtract.test(inner) ? inner : `(${inner})`
			sql = sql.replace(fullMatch, normalized)
			applied.push("EXTRACT_DAY_FROM_DATE_SUBTRACT")
			extractDayRegex.lastIndex = 0
		}
	}

	return { sql, applied }
}

function transformIntegerIntervalBetween(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	// Pattern: (date_expr - date_expr) BETWEEN INTERVAL 'N days' AND INTERVAL 'M days'
	// In PG, date - date = integer (days), so comparing to INTERVAL fails
	// Replace INTERVAL 'N days' with just N
	const betweenRegex = /\(([a-zA-Z_][\w.]*\s*-\s*[a-zA-Z_][\w.]*)\)\s*BETWEEN\s+INTERVAL\s+'(\d+)\s*days?'\s+AND\s+INTERVAL\s+'(\d+)\s*days?'/gi
	let match: RegExpExecArray | null

	betweenRegex.lastIndex = 0
	while ((match = betweenRegex.exec(sql)) !== null) {
		const fullMatch = match[0]
		const subtraction = match[1]
		sql = sql.replace(fullMatch, `(${subtraction}) BETWEEN ${match[2]} AND ${match[3]}`)
		applied.push("INTEGER_INTERVAL_COMPARISON")
		betweenRegex.lastIndex = 0
	}

	// Pattern: (date_expr - date_expr) >= INTERVAL 'N days'
	const compRegex = /\(([a-zA-Z_][\w.]*\s*-\s*[a-zA-Z_][\w.]*)\)\s*(>=?|<=?)\s*INTERVAL\s+'(\d+)\s*days?'/gi
	compRegex.lastIndex = 0
	while ((match = compRegex.exec(sql)) !== null) {
		const fullMatch = match[0]
		const subtraction = match[1]
		const op = match[2]
		sql = sql.replace(fullMatch, `(${subtraction}) ${op} ${match[3]}`)
		applied.push("INTEGER_INTERVAL_COMPARISON")
		compRegex.lastIndex = 0
	}

	return { sql, applied }
}

function transformDateTruncCast(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	const regex = /(\w[\w.]*)\s*::\s*date_trunc\s*\(/gi
	let match: RegExpExecArray | null

	regex.lastIndex = 0
	while ((match = regex.exec(sql)) !== null) {
		const funcStart = match.index + match[0].length - 1
		const paren = extractParenExpr(sql, funcStart)
		if (!paren) continue

		const fullMatch = sql.substring(match.index, paren.endIdx)
		const replacement = `date_trunc(${paren.content})`

		sql = sql.replace(fullMatch, replacement)
		applied.push("DATE_TRUNC_CAST_FIX")

		regex.lastIndex = 0
	}

	return { sql, applied }
}

// ============================================================================
// PG Normalize: Main
// ============================================================================

export function pgNormalize(sql: string): PgNormalizeResult {
	if (!sql || !sql.trim()) {
		return { sql, applied: [], changed: false }
	}

	const allApplied: string[] = []
	let currentSQL = sql

	const transforms = [
		transformStripDivisionScope,
		transformDateExtract,
		transformCoalesce,
		transformDateAddSub,
		transformDatediff,
		transformGroupConcat,
		transformLimitOffset,
		transformBackticks,
		transformDateTruncCast,
		transformDateIntervalComparison,
		transformDatePartDaySubtract,
		transformIntegerIntervalBetween,
		transformDivisionSafety,
	]

	for (const transform of transforms) {
		const result = transform(currentSQL)
		if (result.applied.length > 0) {
			currentSQL = result.sql
			allApplied.push(...result.applied)
		}
	}

	return {
		sql: currentSQL,
		applied: allApplied,
		changed: allApplied.length > 0,
	}
}
