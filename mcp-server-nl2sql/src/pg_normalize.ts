/**
 * PostgreSQL Dialect Normalization
 *
 * Deterministic rewrite of common non-PostgreSQL SQL constructs before EXPLAIN.
 * Handles MySQL, Oracle, and SQL Server patterns that Hrida sometimes generates.
 */

// ============================================================================
// Types
// ============================================================================

export interface PgNormalizeResult {
	/** Normalized SQL */
	sql: string
	/** List of transform names applied */
	applied: string[]
	/** Whether any transforms were applied */
	changed: boolean
}

interface Transform {
	name: string
	pattern: RegExp
	replace: (match: string, ...args: string[]) => string
}

// ============================================================================
// Feature Flag
// ============================================================================

import { getConfig } from "./config/loadConfig.js"

export const PG_NORMALIZE_ENABLED = process.env.PG_NORMALIZE_ENABLED !== undefined
	? process.env.PG_NORMALIZE_ENABLED !== "false"
	: getConfig().features.pg_normalize

// ============================================================================
// Transform Definitions
// ============================================================================

/**
 * Match a balanced parenthesized expression starting after a given prefix.
 * Returns the content inside parens and the full match length.
 */
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

/**
 * Replace YEAR(expr), MONTH(expr), DAY(expr) with EXTRACT(... FROM expr)
 * Handles nested expressions like YEAR(hire_date + INTERVAL '1 day')
 */
function transformDateExtract(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const parts = ["YEAR", "MONTH", "DAY"]

	for (const part of parts) {
		// Use a case-insensitive search, but only match function calls (not column names)
		const regex = new RegExp(`\\b(${part})\\s*\\(`, "gi")
		let result = sql
		let match: RegExpExecArray | null
		let offset = 0

		// Reset regex
		const workingSql = sql
		regex.lastIndex = 0

		while ((match = regex.exec(workingSql)) !== null) {
			const funcName = match[1]
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

/**
 * Replace IFNULL(a, b), ISNULL(a, b), NVL(a, b) with COALESCE(a, b)
 */
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

/**
 * Replace DATE_ADD(d, INTERVAL n unit) with d + INTERVAL 'n unit'
 * Replace DATE_SUB(d, INTERVAL n unit) with d - INTERVAL 'n unit'
 */
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

			// Parse: d, INTERVAL n unit
			const content = paren.content.trim()
			const intervalMatch = content.match(/^(.+?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*$/i)
			if (!intervalMatch) continue

			const [, dateExpr, num, unit] = intervalMatch
			const fullMatch = sql.substring(match.index, paren.endIdx)
			const replacement = `${dateExpr.trim()} ${op} INTERVAL '${num} ${unit.toUpperCase()}'`

			sql = sql.replace(fullMatch, replacement)
			applied.push(`${func}_TO_INTERVAL`)

			// Reset regex since string changed
			regex.lastIndex = 0
		}
	}

	return { sql, applied }
}

/**
 * Replace DATEDIFF(a, b) with (a::date - b::date)
 */
function transformDatediff(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []
	const regex = /\bDATEDIFF\s*\(/gi

	let match: RegExpExecArray | null
	regex.lastIndex = 0

	while ((match = regex.exec(sql)) !== null) {
		const openParenIdx = match.index + match[0].length - 1
		const paren = extractParenExpr(sql, openParenIdx)
		if (!paren) continue

		// Parse: a, b
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

/**
 * Replace GROUP_CONCAT(expr) with STRING_AGG(expr::text, ', ')
 */
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

/**
 * Replace MySQL-style LIMIT n, m with LIMIT m OFFSET n
 * Only matches LIMIT followed by two numbers separated by comma
 * Must be careful not to match LIMIT inside subqueries incorrectly
 */
function transformLimitOffset(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	// Match LIMIT <number>, <number> at the end of the query or before a closing paren
	const regex = /\bLIMIT\s+(\d+)\s*,\s*(\d+)\b/gi
	const match = regex.exec(sql)
	if (match) {
		const [fullMatch, offset, limit] = match
		sql = sql.replace(fullMatch, `LIMIT ${limit} OFFSET ${offset}`)
		applied.push("MYSQL_LIMIT_OFFSET")
	}

	return { sql, applied }
}

/**
 * Remove backtick identifiers (MySQL style)
 */
function transformBackticks(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	if (sql.includes("`")) {
		sql = sql.replace(/`/g, "")
		applied.push("REMOVE_BACKTICKS")
	}

	return { sql, applied }
}

/**
 * Wrap bare integer division denominators with NULLIF to prevent division by zero.
 * Matches: `/ COUNT(...)` or `/ SUM(...)` and wraps in NULLIF(..., 0)
 * Only wraps aggregate function denominators (the most common source of div-by-zero).
 * Skips if already wrapped in NULLIF.
 */
function transformDivisionSafety(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	// Match: / COUNT(...) or / SUM(...) not already inside NULLIF
	// Negative lookbehind for NULLIF( to avoid double-wrapping
	const aggregates = ["COUNT", "SUM", "AVG"]
	for (const agg of aggregates) {
		const regex = new RegExp(
			`\\/\\s*(?!NULLIF)(${agg}\\s*\\()`,
			"gi"
		)
		let match: RegExpExecArray | null
		regex.lastIndex = 0

		while ((match = regex.exec(sql)) !== null) {
			// Check if already inside NULLIF by looking back
			const before = sql.substring(Math.max(0, match.index - 7), match.index)
			if (/NULLIF\s*\(\s*$/i.test(before)) continue

			const funcStart = match.index + match[0].length - 1 // position of '('
			const paren = extractParenExpr(sql, funcStart)
			if (!paren) continue

			const fullAggExpr = `${agg}(${paren.content})`
			const slashAndExpr = sql.substring(match.index, paren.endIdx)
			const replacement = `/ NULLIF(${fullAggExpr}, 0)`

			sql = sql.replace(slashAndExpr, replacement)
			applied.push("DIVISION_SAFETY_NULLIF")

			regex.lastIndex = 0
			break // One replacement at a time, restart scan
		}
	}

	return { sql, applied }
}

/**
 * Fix date-minus-date compared to INTERVAL:
 *   (CURRENT_DATE - col) > INTERVAL 'N unit'  →  col < CURRENT_DATE - INTERVAL 'N unit'
 *   (CURRENT_DATE - col) >= INTERVAL 'N unit' →  col <= CURRENT_DATE - INTERVAL 'N unit'
 *
 * In PostgreSQL, `date - date` returns integer (days), not an interval,
 * so comparing with INTERVAL causes "operator does not exist: integer > interval".
 */
function transformDateIntervalComparison(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	// Match: (CURRENT_DATE - expr) > INTERVAL '...' or >= INTERVAL '...'
	// Captures: (1) the date expression, (2) the operator, (3) the interval literal
	const regex = /\(\s*CURRENT_DATE\s*-\s*([\w.]+)\s*\)\s*(>=?|<=?)\s*(INTERVAL\s+'[^']+')/gi

	let match: RegExpExecArray | null
	regex.lastIndex = 0

	while ((match = regex.exec(sql)) !== null) {
		const [fullMatch, dateCol, op, interval] = match

		// Flip the comparison: (CURRENT_DATE - col) > INTERVAL → col < CURRENT_DATE - INTERVAL
		const flippedOp = op === ">" ? "<" : op === ">=" ? "<=" : op === "<" ? ">" : ">="
		const replacement = `${dateCol} ${flippedOp} CURRENT_DATE - ${interval}`

		sql = sql.replace(fullMatch, replacement)
		applied.push("DATE_INTERVAL_COMPARISON_FIX")

		regex.lastIndex = 0
	}

	return { sql, applied }
}

/**
 * Fix invalid cast-style date_trunc: `expr::date_trunc('unit', expr2)` → `date_trunc('unit', expr2)`
 * The LLM sometimes generates `col::date_trunc('month', col)` which is not valid PostgreSQL.
 */
function transformDateTruncCast(sql: string): { sql: string; applied: string[] } {
	const applied: string[] = []

	// Match patterns like: expr::date_trunc('unit', expr2)
	const regex = /(\w[\w.]*)\s*::\s*date_trunc\s*\(/gi
	let match: RegExpExecArray | null

	regex.lastIndex = 0
	while ((match = regex.exec(sql)) !== null) {
		const funcStart = match.index + match[0].length - 1 // position of '('
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
// Main Function
// ============================================================================

/**
 * Apply all PG normalization transforms to a SQL string.
 *
 * Each transform is independent and applied sequentially.
 * Already-valid PostgreSQL SQL passes through unchanged.
 *
 * @param sql - SQL string to normalize
 * @returns Normalized SQL with list of applied transforms
 */
export function pgNormalize(sql: string): PgNormalizeResult {
	if (!sql || !sql.trim()) {
		return { sql, applied: [], changed: false }
	}

	const allApplied: string[] = []
	let currentSQL = sql

	// Apply transforms in order
	const transforms = [
		transformDateExtract,
		transformCoalesce,
		transformDateAddSub,
		transformDatediff,
		transformGroupConcat,
		transformLimitOffset,
		transformBackticks,
		transformDateTruncCast,
		transformDateIntervalComparison,
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
