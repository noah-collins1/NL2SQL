/**
 * SQL Validator with State Machine Parsing
 *
 * Validates SQL queries with proper handling of:
 * - Strings (single/double quotes with escaping)
 * - Dollar-quoted strings ($tag$...$tag$)
 * - Comments (line comments and block comments)
 * - Multiple statement detection
 * - Dangerous keywords and functions
 * - Table allowlist enforcement
 *
 * See CLAUDE.md for design rationale and gotchas
 */

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

/**
 * Dangerous keywords that should never appear in queries
 * (checked outside strings/comments only)
 */
const DANGEROUS_KEYWORDS = [
	// DDL
	"DROP",
	"CREATE",
	"ALTER",
	"TRUNCATE",
	"RENAME",
	// DML (write operations)
	"INSERT",
	"UPDATE",
	"DELETE",
	// DCL
	"GRANT",
	"REVOKE",
	// TCL
	"BEGIN",
	"COMMIT",
	"ROLLBACK",
	"SAVEPOINT",
	// Other dangerous
	"COPY",
	"EXECUTE",
	"PREPARE",
]

/**
 * Dangerous functions that should be blocked
 * (admin functions, file I/O, system access)
 */
const DANGEROUS_FUNCTIONS = [
	// File I/O
	"pg_read_file",
	"pg_read_binary_file",
	"pg_ls_dir",
	"lo_export",
	"lo_import",
	// System functions
	"pg_sleep",
	"pg_terminate_backend",
	"pg_cancel_backend",
	// External connections
	"dblink",
	"dblink_connect",
	"dblink_exec",
	"postgres_fdw",
	// Admin functions
	"pg_reload_conf",
	"pg_rotate_logfile",
	"pg_stat_reset",
]

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
			// (e.g., arithmetic '-' or division '/')
			// Include it as part of normal token to avoid infinite loop
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

/**
 * Check if SQL contains multiple statements
 * (semicolons outside strings/comments that split the query)
 */
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

	// Allow zero or one semicolon at the very end (after trimming whitespace)
	if (semicolonPositions.length === 0) {
		return { hasMultiple: false, semicolonPositions: [] }
	}

	if (semicolonPositions.length === 1) {
		// Check if it's at the end (only whitespace/comments after it)
		const lastSemiPos = semicolonPositions[0]
		const afterSemi = tokens.filter((t) => t.start > lastSemiPos)
		const hasCodeAfterSemi = afterSemi.some(
			(t) => t.type === TokenType.NORMAL && t.value.trim().length > 0,
		)
		return { hasMultiple: hasCodeAfterSemi, semicolonPositions }
	}

	// Multiple semicolons = multiple statements
	return { hasMultiple: true, semicolonPositions }
}

/**
 * Check for dangerous keywords in normal tokens
 */
function checkDangerousKeywords(tokens: Token[]): {
	found: string[]
	positions: number[]
} {
	const normalTokens = getNormalTokens(tokens)
	const found: string[] = []
	const positions: number[] = []

	for (const token of normalTokens) {
		const upperValue = token.value.toUpperCase()
		for (const keyword of DANGEROUS_KEYWORDS) {
			// Match whole word only
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

/**
 * Check for dangerous functions in normal tokens
 */
function checkDangerousFunctions(tokens: Token[]): {
	found: string[]
	positions: number[]
} {
	const normalTokens = getNormalTokens(tokens)
	const found: string[] = []
	const positions: number[] = []

	for (const token of normalTokens) {
		const lowerValue = token.value.toLowerCase()
		for (const func of DANGEROUS_FUNCTIONS) {
			// Match function call: func_name(
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

/**
 * Extract table names from SQL (best-effort, not a full parser)
 */
function extractTableNames(tokens: Token[]): string[] {
	const normalTokens = getNormalTokens(tokens)
	const normalSQL = normalTokens.map((t) => t.value).join("")
	const tables: string[] = []

	// Pattern: FROM <table> or JOIN <table>
	// Handles: table, schema.table, "table", "schema"."table"
	const patterns = [
		/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
		/\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
		/\bFROM\s+"([^"]+)"/gi,
		/\bJOIN\s+"([^"]+)"/gi,
	]

	for (const pattern of patterns) {
		let match
		while ((match = pattern.exec(normalSQL)) !== null) {
			let tableName = match[1]
			// Strip schema prefix if present
			if (tableName.includes(".")) {
				tableName = tableName.split(".").pop()!
			}
			// Remove quotes
			tableName = tableName.replace(/"/g, "")
			tables.push(tableName.toLowerCase())
		}
	}

	return Array.from(new Set(tables))
}

/**
 * Check if SQL has a LIMIT clause
 */
function hasLimitClause(sql: string): boolean {
	// Simple check: look for LIMIT or FETCH in normal tokens
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

/**
 * Count JOINs in SQL
 */
function countJoins(sql: string): number {
	const tokens = tokenizeSQL(sql)
	const normalSQL = getNormalTokens(tokens)
		.map((t) => t.value)
		.join("")
		.toUpperCase()

	return (normalSQL.match(/\bJOIN\b/g) || []).length
}

/**
 * Main validator function
 */
export function validateSQL(
	sql: string,
	context: ValidationContext,
): ValidationResult {
	const issues: ValidationIssue[] = []
	let autoFixed = false
	let currentSQL = sql.trim()

	// Tokenize SQL
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

	// Rule 2: Single statement only (no multiple statements)
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

	// Optional: Add trailing semicolon if missing (info only, auto-fix)
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
	const requireLimit = context.requireLimit !== false // Default true
	if (requireLimit && !hasLimitClause(currentSQL)) {
		const maxLimit = context.maxLimit || 1000
		// Add LIMIT before the final semicolon
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

	// Rule 7: Excessive JOINs (warning, review)
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

	// Determine if valid
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

/**
 * Compress validator issues into short delta instructions for repair
 */
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

		// Avoid duplicates
		if (!seen.has(instruction)) {
			seen.add(instruction)
			instructions.push(instruction)
		}
	}

	return instructions
}

/**
 * Format validator issues for logging
 */
export function formatIssuesForLog(issues: ValidationIssue[]): string {
	return issues
		.map((i) => {
			const emoji =
				i.severity === "error" ? "❌" : i.severity === "warning" ? "⚠️" : "ℹ️"
			return `${emoji} [${i.code}] ${i.message}`
		})
		.join("\n")
}
