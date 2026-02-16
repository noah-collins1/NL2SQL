/**
 * Candidate Reranker (Phase 3)
 *
 * Reranks SQL candidates using orthogonal scoring signals:
 * - Schema adherence: fraction of SQL tables/columns in schema context
 * - Join skeleton matching: compare SQL joins to planner skeletons
 * - Result shape checking: verify aggregation type matches question
 * - Value verification (optional): check WHERE values exist in DB
 *
 * All signals are additive bonuses — reranker can only improve or maintain
 * candidate selection, never reject a candidate.
 */

import type { Pool } from "pg"
import type { SQLCandidate } from "./multi_candidate.js"
import type { SchemaLinkBundle } from "./schema_grounding.js"
import type { JoinPlan, JoinSkeleton } from "./join_planner.js"
import type { SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Feature Flags
// ============================================================================

import { getConfig } from "./config/loadConfig.js"

export const CANDIDATE_RERANKER_ENABLED = process.env.CANDIDATE_RERANKER_ENABLED !== undefined
	? process.env.CANDIDATE_RERANKER_ENABLED !== "false"
	: getConfig().features.reranker

export const VALUE_VERIFICATION_ENABLED = process.env.VALUE_VERIFICATION_ENABLED !== undefined
	? process.env.VALUE_VERIFICATION_ENABLED === "true"
	: getConfig().features.value_verification

// ============================================================================
// Types
// ============================================================================

export interface RerankerContext {
	question: string
	schemaLinkBundle: SchemaLinkBundle | null
	joinPlan: JoinPlan | null
	schemaContext: SchemaContextPacket | null
	pool?: Pool
}

export interface SchemaAdherenceResult {
	tableScore: number
	columnScore: number
	combined: number
	tablesFound: number
	tablesTotal: number
	columnsFound: number
	columnsTotal: number
}

export interface JoinMatchResult {
	matchedJoins: number
	totalJoins: number
	score: number
	bestSkeletonIndex: number
}

export type AggregationType = "count" | "sum" | "avg" | "min" | "max" | "list" | "unknown"

export interface ResultShapeResult {
	expectedAgg: AggregationType
	actualAgg: AggregationType[]
	hasGroupBy: boolean
	expectedGroupBy: boolean
	hasOrderBy: boolean
	expectedOrderBy: boolean
	score: number
}

export interface ValueVerificationResult {
	verified: number
	total: number
	score: number
}

export interface RerankerDetail {
	index: number
	schemaAdherence: SchemaAdherenceResult
	joinMatch: JoinMatchResult
	resultShape: ResultShapeResult
	valueVerification?: ValueVerificationResult
	totalBonus: number
}

export interface RerankerResult {
	candidates: SQLCandidate[]
	rerankDetails: RerankerDetail[]
}

export interface CandidateReranker {
	rerank(candidates: SQLCandidate[], context: RerankerContext): Promise<RerankerResult>
}

// ============================================================================
// SQL Extraction Helpers
// ============================================================================

/** SQL keywords to exclude from column/table extraction */
const SQL_KEYWORDS = new Set([
	"SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
	"ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "GROUP", "BY",
	"ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "HAVING", "UNION", "ALL",
	"DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "BETWEEN", "LIKE",
	"EXISTS", "ANY", "SOME", "TRUE", "FALSE", "COUNT", "SUM", "AVG",
	"MAX", "MIN", "COALESCE", "EXTRACT", "YEAR", "MONTH", "DAY",
	"CAST", "INTERVAL", "DATE", "TEXT", "INTEGER", "NUMERIC", "BOOLEAN",
	"VARCHAR", "TIMESTAMP", "CROSS", "FULL", "SET", "OVER", "PARTITION",
	"ROW", "ROWS", "RANGE", "WINDOW", "LATERAL", "WITH", "RECURSIVE",
	"ILIKE", "CURRENT_DATE", "CURRENT_TIMESTAMP", "NOW", "UPPER", "LOWER",
	"TRIM", "LENGTH", "SUBSTRING", "REPLACE", "CONCAT", "ROUND", "FLOOR",
	"CEIL", "ABS", "NULLIF", "GREATEST", "LEAST", "ARRAY_AGG", "STRING_AGG",
	"BOOL_AND", "BOOL_OR", "FILTER", "WITHIN", "FETCH", "NEXT", "ONLY",
	"FIRST", "LAST", "PRECEDING", "FOLLOWING", "UNBOUNDED", "CURRENT",
	"LAG", "LEAD", "ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE",
	"PERCENT_RANK", "CUME_DIST", "FIRST_VALUE", "LAST_VALUE",
	"NTH_VALUE", "TO_CHAR", "TO_DATE", "TO_NUMBER", "DATE_TRUNC",
	"AGE", "MAKE_DATE", "MAKE_INTERVAL",
])

/**
 * Build alias → table mapping from FROM/JOIN clauses.
 *
 * Handles: FROM table1 t1, FROM table1 AS t1, JOIN table2 t2 ON ...
 */
export function buildAliasMap(sql: string): Map<string, string> {
	const aliasMap = new Map<string, string>()
	// Match: FROM table [AS] alias  or  JOIN table [AS] alias
	const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s+(?:AS\s+)?([a-zA-Z_]\w*)\b/gi
	let match: RegExpExecArray | null
	while ((match = pattern.exec(sql)) !== null) {
		const table = match[1].toLowerCase()
		const alias = match[2].toLowerCase()
		// Skip if alias is a SQL keyword (e.g., "FROM employees LEFT JOIN...")
		if (!SQL_KEYWORDS.has(alias.toUpperCase()) && alias !== "on" && alias !== "where") {
			aliasMap.set(alias, table)
			aliasMap.set(table, table) // table itself resolves to itself
		}
	}
	// Also catch FROM table with no alias
	const simpleFrom = /\bFROM\s+([a-zA-Z_]\w*)\b(?!\s+(?:AS\s+)?[a-zA-Z_]\w*\b(?!\s*[.(]))/gi
	while ((match = simpleFrom.exec(sql)) !== null) {
		const table = match[1].toLowerCase()
		if (!SQL_KEYWORDS.has(table.toUpperCase())) {
			aliasMap.set(table, table)
		}
	}
	return aliasMap
}

/**
 * Extract table names from FROM/JOIN clauses.
 * Returns resolved table names (no aliases).
 */
export function extractTableRefsFromSQL(sql: string): string[] {
	const tables = new Set<string>()
	// Match FROM or JOIN followed by a table name
	const pattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\b/gi
	let match: RegExpExecArray | null
	while ((match = pattern.exec(sql)) !== null) {
		const name = match[1].toLowerCase()
		// Skip SQL keywords that appear after FROM/JOIN (e.g., subqueries)
		if (!SQL_KEYWORDS.has(name.toUpperCase()) && name !== "select" && name !== "(") {
			// If schema-qualified, take the table part
			const parts = name.split(".")
			tables.add(parts[parts.length - 1])
		}
	}
	return Array.from(tables)
}

/**
 * Extract column references from SQL with optional table qualifier.
 * Filters out SQL keywords, functions, string/numeric literals.
 */
export function extractColumnRefsFromSQL(sql: string): Array<{ table?: string; column: string }> {
	const refs: Array<{ table?: string; column: string }> = []
	const seen = new Set<string>()

	// Remove string literals to avoid false positives
	const cleaned = sql.replace(/'[^']*'/g, "''")

	// Collect table qualifiers used in qualified refs (these are aliases/table names, not columns)
	const tableQualifiers = new Set<string>()

	// Match qualified references: table.column or alias.column
	const qualifiedPattern = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\b/g
	let match: RegExpExecArray | null
	while ((match = qualifiedPattern.exec(cleaned)) !== null) {
		const table = match[1]
		const column = match[2]
		if (SQL_KEYWORDS.has(table.toUpperCase()) || SQL_KEYWORDS.has(column.toUpperCase())) continue
		tableQualifiers.add(table.toLowerCase())
		const key = `${table}.${column}`.toLowerCase()
		if (!seen.has(key)) {
			seen.add(key)
			refs.push({ table: table.toLowerCase(), column: column.toLowerCase() })
		}
	}

	// Also collect table names from FROM/JOIN
	const tableNames = new Set(extractTableRefsFromSQL(sql).map(t => t.toLowerCase()))
	const aliasMap = buildAliasMap(sql)
	for (const alias of aliasMap.keys()) {
		tableQualifiers.add(alias)
	}
	for (const t of tableNames) {
		tableQualifiers.add(t)
	}

	// Match unqualified references in SELECT, WHERE, GROUP BY, ORDER BY, ON, HAVING clauses
	const unqualifiedPattern = /\b(?:SELECT|WHERE|ON|HAVING|BY|,)\s+(?:DISTINCT\s+)?([a-zA-Z_]\w*)\b/gi
	while ((match = unqualifiedPattern.exec(cleaned)) !== null) {
		const col = match[1]
		if (SQL_KEYWORDS.has(col.toUpperCase())) continue
		// Skip if it's a table name or alias (not a column)
		if (tableQualifiers.has(col.toLowerCase())) continue
		// Skip if it looks like a function call (followed by parenthesis)
		const afterIdx = match.index + match[0].length
		if (afterIdx < cleaned.length && cleaned[afterIdx] === "(") continue
		const key = col.toLowerCase()
		if (!seen.has(key)) {
			seen.add(key)
			refs.push({ column: key })
		}
	}

	return refs
}

/**
 * Extracted JOIN condition from SQL
 */
export interface ExtractedJoin {
	leftTable: string
	rightTable: string
	leftColumn: string
	rightColumn: string
}

/**
 * Parse JOIN ON conditions from SQL.
 * Handles LEFT/RIGHT/INNER/CROSS JOIN and multiple ON conditions (AND).
 * Resolves aliases using FROM/JOIN alias map.
 */
export function extractJoinsFromSQL(sql: string): ExtractedJoin[] {
	const joins: ExtractedJoin[] = []
	const aliasMap = buildAliasMap(sql)

	// Match: JOIN ... ON table1.col1 = table2.col2 (possibly multiple conditions with AND)
	const joinOnPattern = /\bJOIN\s+\S+\s+(?:\S+\s+)?ON\s+([\s\S]*?)(?=\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|\bUNION\b|$)/gi
	let joinMatch: RegExpExecArray | null
	while ((joinMatch = joinOnPattern.exec(sql)) !== null) {
		const onClause = joinMatch[1]

		// Parse each condition in the ON clause
		const condPattern = /([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*=\s*([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)/g
		let condMatch: RegExpExecArray | null
		while ((condMatch = condPattern.exec(onClause)) !== null) {
			const leftAlias = condMatch[1].toLowerCase()
			const leftCol = condMatch[2].toLowerCase()
			const rightAlias = condMatch[3].toLowerCase()
			const rightCol = condMatch[4].toLowerCase()

			const leftTable = aliasMap.get(leftAlias) || leftAlias
			const rightTable = aliasMap.get(rightAlias) || rightAlias

			joins.push({
				leftTable,
				rightTable,
				leftColumn: leftCol,
				rightColumn: rightCol,
			})
		}
	}

	return joins
}

// ============================================================================
// Schema Adherence Scoring (3.2)
// ============================================================================

/**
 * Compute schema adherence: fraction of SQL tables/columns that exist in
 * the schema context. Checks both SchemaLinkBundle (linked columns) and
 * SchemaContextPacket (all retrieved tables/columns).
 */
export function computeSchemaAdherence(
	sql: string,
	bundle: SchemaLinkBundle | null,
	schemaContext: SchemaContextPacket | null,
): SchemaAdherenceResult {
	const noResult: SchemaAdherenceResult = {
		tableScore: 1.0, columnScore: 1.0, combined: 1.0,
		tablesFound: 0, tablesTotal: 0, columnsFound: 0, columnsTotal: 0,
	}
	if (!schemaContext && !bundle) return noResult

	// --- Table adherence ---
	const sqlTables = extractTableRefsFromSQL(sql)
	const knownTables = new Set<string>()
	if (schemaContext) {
		for (const t of schemaContext.tables) {
			knownTables.add(t.table_name.toLowerCase())
		}
	}
	if (bundle) {
		for (const t of bundle.linkedTables) {
			knownTables.add(t.table.toLowerCase())
		}
	}

	let tablesFound = 0
	for (const t of sqlTables) {
		if (knownTables.has(t)) tablesFound++
	}
	const tableScore = sqlTables.length > 0 ? tablesFound / sqlTables.length : 1.0

	// --- Column adherence ---
	const columnRefs = extractColumnRefsFromSQL(sql)
	const aliasMap = buildAliasMap(sql)

	// Build set of known columns from schema context (parse m_schema)
	const knownColumns = new Set<string>() // "table.column"
	const knownBareColumns = new Set<string>() // "column" only

	if (schemaContext) {
		for (const t of schemaContext.tables) {
			// Parse column names from m_schema
			// M-Schema format: "table_name [column1: type, column2: type, ...]"
			const colPattern = /\[([^\]]+)\]/
			const colMatch = t.m_schema.match(colPattern)
			if (colMatch) {
				const colList = colMatch[1].split(",")
				for (const colDef of colList) {
					const colName = colDef.trim().split(":")[0].split("(")[0].trim().toLowerCase()
					if (colName && !colName.includes(" ")) {
						knownColumns.add(`${t.table_name.toLowerCase()}.${colName}`)
						knownBareColumns.add(colName)
					}
				}
			}
		}
	}

	if (bundle) {
		for (const [table, cols] of Object.entries(bundle.linkedColumns)) {
			for (const col of cols) {
				knownColumns.add(`${table.toLowerCase()}.${col.column.toLowerCase()}`)
				knownBareColumns.add(col.column.toLowerCase())
			}
		}
	}

	let columnsFound = 0
	for (const ref of columnRefs) {
		if (ref.table) {
			// Resolve alias to table name
			const resolvedTable = aliasMap.get(ref.table) || ref.table
			if (knownColumns.has(`${resolvedTable}.${ref.column}`)) {
				columnsFound++
			} else if (knownBareColumns.has(ref.column)) {
				columnsFound++
			}
		} else {
			if (knownBareColumns.has(ref.column)) {
				columnsFound++
			}
		}
	}
	const columnScore = columnRefs.length > 0 ? columnsFound / columnRefs.length : 1.0

	const combined = tableScore * 0.4 + columnScore * 0.6

	return {
		tableScore,
		columnScore,
		combined,
		tablesFound,
		tablesTotal: sqlTables.length,
		columnsFound,
		columnsTotal: columnRefs.length,
	}
}

// ============================================================================
// Join Skeleton Matcher (3.3)
// ============================================================================

/**
 * Compare SQL joins against planned skeletons.
 * For each skeleton, counts how many extracted joins match a skeleton join.
 * Handles column order independence: a.id = b.fk ≡ b.fk = a.id
 */
export function computeJoinMatch(sql: string, plan: JoinPlan | null): JoinMatchResult {
	const noResult: JoinMatchResult = { matchedJoins: 0, totalJoins: 0, score: 1.0, bestSkeletonIndex: -1 }
	if (!plan || plan.skeletons.length === 0) return noResult

	const extractedJoins = extractJoinsFromSQL(sql)
	if (extractedJoins.length === 0) {
		// No joins in SQL — if skeletons expect joins, score = 0
		const hasPlannedJoins = plan.skeletons.some(s => s.joins.length > 0)
		return hasPlannedJoins
			? { matchedJoins: 0, totalJoins: 0, score: 0.0, bestSkeletonIndex: 0 }
			: noResult
	}

	let bestScore = 0
	let bestIdx = 0
	let bestMatched = 0
	let bestTotal = 0

	for (let i = 0; i < plan.skeletons.length; i++) {
		const skeleton = plan.skeletons[i]
		if (skeleton.joins.length === 0) continue

		let matched = 0
		for (const ej of extractedJoins) {
			for (const sj of skeleton.joins) {
				// Check both orderings
				const forwardMatch =
					ej.leftTable === sj.fromTable.toLowerCase() &&
					ej.rightTable === sj.toTable.toLowerCase() &&
					ej.leftColumn === sj.fromColumn.toLowerCase() &&
					ej.rightColumn === sj.toColumn.toLowerCase()

				const reverseMatch =
					ej.leftTable === sj.toTable.toLowerCase() &&
					ej.rightTable === sj.fromTable.toLowerCase() &&
					ej.leftColumn === sj.toColumn.toLowerCase() &&
					ej.rightColumn === sj.fromColumn.toLowerCase()

				if (forwardMatch || reverseMatch) {
					matched++
					break // Only count once per extracted join
				}
			}
		}

		const denom = Math.max(extractedJoins.length, skeleton.joins.length)
		const score = denom > 0 ? matched / denom : 1.0

		if (score > bestScore) {
			bestScore = score
			bestIdx = i
			bestMatched = matched
			bestTotal = denom
		}
	}

	return {
		matchedJoins: bestMatched,
		totalJoins: bestTotal,
		score: bestScore,
		bestSkeletonIndex: bestIdx,
	}
}

// ============================================================================
// Result Shape Checker (3.4)
// ============================================================================

/**
 * Detect expected aggregation type from question text.
 */
export function detectExpectedShape(question: string): {
	aggregation: AggregationType
	groupBy: boolean
	orderBy: boolean
} {
	const q = question.toLowerCase()

	// Aggregation detection
	let aggregation: AggregationType = "unknown"
	if (/\b(how many|count|number of)\b/.test(q)) {
		aggregation = "count"
	} else if (/\b(total|sum of|sum)\b/.test(q)) {
		aggregation = "sum"
	} else if (/\b(average|avg|mean)\b/.test(q)) {
		aggregation = "avg"
	} else if (/\b(minimum|min|lowest|smallest|least)\b/.test(q)) {
		aggregation = "min"
	} else if (/\b(maximum|max|highest|largest|greatest|most)\b/.test(q)) {
		aggregation = "max"
	} else if (/\b(list|show|display|all)\b/.test(q)) {
		aggregation = "list"
	}

	// Group By detection
	const groupBy = /\b(by|per|for each|grouped by|group by|breakdown)\b/.test(q)
		&& /\b(department|employee|customer|product|category|warehouse|project|vendor|month|year|quarter|region|status|type)\b/.test(q)

	// Order By detection
	const orderBy = /\b(top|bottom|highest|lowest|best|worst|most|least|rank|sort)\b/.test(q)

	return { aggregation, groupBy, orderBy }
}

/**
 * Detect actual aggregation functions and clauses in SQL.
 */
export function detectActualShape(sql: string): {
	aggregations: AggregationType[]
	hasGroupBy: boolean
	hasOrderBy: boolean
	hasLimit: boolean
} {
	const upper = sql.toUpperCase()
	const aggregations: AggregationType[] = []

	if (/\bCOUNT\s*\(/i.test(sql)) aggregations.push("count")
	if (/\bSUM\s*\(/i.test(sql)) aggregations.push("sum")
	if (/\bAVG\s*\(/i.test(sql)) aggregations.push("avg")
	if (/\bMIN\s*\(/i.test(sql)) aggregations.push("min")
	if (/\bMAX\s*\(/i.test(sql)) aggregations.push("max")
	if (aggregations.length === 0) aggregations.push("list")

	return {
		aggregations,
		hasGroupBy: /\bGROUP\s+BY\b/i.test(sql),
		hasOrderBy: /\bORDER\s+BY\b/i.test(sql),
		hasLimit: /\bLIMIT\b/i.test(sql),
	}
}

/**
 * Compare expected vs actual result shape.
 */
export function computeResultShape(question: string, sql: string): ResultShapeResult {
	const expected = detectExpectedShape(question)
	const actual = detectActualShape(sql)

	let score = 0.5 // neutral default

	// Aggregation match
	if (expected.aggregation !== "unknown") {
		if (actual.aggregations.includes(expected.aggregation)) {
			score = 1.0
		} else if (expected.aggregation === "list" && actual.aggregations.includes("list")) {
			score = 1.0
		} else if (expected.aggregation !== "list" && !actual.aggregations.includes("list")) {
			// Wrong aggregation but at least it's doing some aggregation
			score = 0.3
		} else {
			score = 0.0
		}
	}

	// Group By match (additive)
	if (expected.groupBy && actual.hasGroupBy) {
		score = Math.min(1.0, score + 0.1)
	} else if (expected.groupBy && !actual.hasGroupBy) {
		score = Math.max(0.0, score - 0.2)
	}

	// Order By match (additive)
	if (expected.orderBy && actual.hasOrderBy) {
		score = Math.min(1.0, score + 0.1)
	}

	return {
		expectedAgg: expected.aggregation,
		actualAgg: actual.aggregations,
		hasGroupBy: actual.hasGroupBy,
		expectedGroupBy: expected.groupBy,
		hasOrderBy: actual.hasOrderBy,
		expectedOrderBy: expected.orderBy,
		score,
	}
}

// ============================================================================
// Value Verification (3.5)
// ============================================================================

interface WhereValue {
	column: string
	table?: string
	value: string
	operator: "=" | "IN" | "LIKE"
}

/**
 * Extract WHERE clause string literal values from SQL.
 * Only extracts string literals (skips numbers, dates, NULLs).
 */
export function extractWhereValues(sql: string): WhereValue[] {
	const values: WhereValue[] = []

	// Match: column = 'value' or alias.column = 'value'
	const eqPattern = /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*=\s*'([^']+)'/g
	let match: RegExpExecArray | null
	while ((match = eqPattern.exec(sql)) !== null) {
		const ref = match[1]
		const value = match[2]
		const parts = ref.split(".")
		if (parts.length === 2) {
			values.push({ table: parts[0].toLowerCase(), column: parts[1].toLowerCase(), value, operator: "=" })
		} else {
			values.push({ column: parts[0].toLowerCase(), value, operator: "=" })
		}
	}

	// Match: column IN ('a', 'b', ...)
	const inPattern = /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s+IN\s*\(([^)]+)\)/gi
	while ((match = inPattern.exec(sql)) !== null) {
		const ref = match[1]
		const inList = match[2]
		const parts = ref.split(".")
		// Extract individual values
		const valPattern = /'([^']+)'/g
		let valMatch: RegExpExecArray | null
		while ((valMatch = valPattern.exec(inList)) !== null) {
			if (parts.length === 2) {
				values.push({ table: parts[0].toLowerCase(), column: parts[1].toLowerCase(), value: valMatch[1], operator: "IN" })
			} else {
				values.push({ column: parts[0].toLowerCase(), value: valMatch[1], operator: "IN" })
			}
		}
	}

	// Match: column LIKE '%pattern%'
	const likePattern = /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s+(?:I?LIKE)\s+'([^']+)'/gi
	while ((match = likePattern.exec(sql)) !== null) {
		const ref = match[1]
		const value = match[2]
		const parts = ref.split(".")
		if (parts.length === 2) {
			values.push({ table: parts[0].toLowerCase(), column: parts[1].toLowerCase(), value, operator: "LIKE" })
		} else {
			values.push({ column: parts[0].toLowerCase(), value, operator: "LIKE" })
		}
	}

	return values
}

/**
 * Verify WHERE clause values exist in the database.
 * Returns fraction of verified values.
 *
 * Only checks string literal equality values (= and IN).
 * LIKE patterns are skipped since they're partial matches.
 */
export async function verifyValues(
	values: WhereValue[],
	schemaContext: SchemaContextPacket | null,
	pool: Pool,
): Promise<ValueVerificationResult> {
	// Only check = and IN values, skip LIKE
	const checkable = values.filter(v => v.operator !== "LIKE")
	if (checkable.length === 0) return { verified: 0, total: 0, score: 1.0 }

	// Build alias → table mapping from schema context
	const tableNames = schemaContext
		? new Set(schemaContext.tables.map(t => t.table_name.toLowerCase()))
		: new Set<string>()

	let verified = 0
	const total = checkable.length

	// Check values in parallel with timeout
	const checks = checkable.map(async (wv) => {
		const tableName = wv.table || null
		// Only verify if we can resolve the table
		if (!tableName || !tableNames.has(tableName)) return false

		try {
			const client = await pool.connect()
			try {
				await client.query("SET statement_timeout = 1000") // 1s timeout
				const result = await client.query(
					`SELECT 1 FROM ${tableName} WHERE ${wv.column} = $1 LIMIT 1`,
					[wv.value],
				)
				return result.rows.length > 0
			} finally {
				client.release()
			}
		} catch {
			return false // On error, treat as unverified (not a penalty)
		}
	})

	const results = await Promise.all(checks)
	verified = results.filter(Boolean).length

	return {
		verified,
		total,
		score: total > 0 ? verified / total : 1.0,
	}
}

// ============================================================================
// Default Heuristic Reranker
// ============================================================================

/**
 * Heuristic reranker that applies schema adherence, join match, result shape,
 * and optional value verification as post-hoc bonuses.
 */
export class HeuristicReranker implements CandidateReranker {
	private schemaAdherenceBonus: number
	private joinMatchBonus: number
	private resultShapeBonus: number
	private valueVerificationBonus: number

	constructor(
		schemaAdherenceBonus = 15,
		joinMatchBonus = 20,
		resultShapeBonus = 10,
		valueVerificationBonus = 10,
	) {
		this.schemaAdherenceBonus = schemaAdherenceBonus
		this.joinMatchBonus = joinMatchBonus
		this.resultShapeBonus = resultShapeBonus
		this.valueVerificationBonus = valueVerificationBonus
	}

	async rerank(candidates: SQLCandidate[], context: RerankerContext): Promise<RerankerResult> {
		const rerankDetails: RerankerDetail[] = []

		const reranked = candidates.map((c, idx) => {
			const adherence = computeSchemaAdherence(c.sql, context.schemaLinkBundle, context.schemaContext)
			const joinMatch = computeJoinMatch(c.sql, context.joinPlan)
			const resultShape = computeResultShape(context.question, c.sql)

			const bonus =
				adherence.combined * this.schemaAdherenceBonus +
				joinMatch.score * this.joinMatchBonus +
				resultShape.score * this.resultShapeBonus

			rerankDetails.push({
				index: c.index,
				schemaAdherence: adherence,
				joinMatch,
				resultShape,
				totalBonus: bonus,
			})

			return {
				...c,
				score: c.score + bonus,
			}
		})

		// Value verification (optional, only top-2 candidates)
		if (VALUE_VERIFICATION_ENABLED && context.pool && context.schemaContext) {
			const sorted = [...reranked].sort((a, b) => b.score - a.score)
			const topCandidates = sorted.slice(0, 2)

			for (const tc of topCandidates) {
				const whereValues = extractWhereValues(tc.sql)
				if (whereValues.length > 0) {
					const vv = await verifyValues(whereValues, context.schemaContext, context.pool)
					const bonus = vv.score * this.valueVerificationBonus
					tc.score += bonus

					// Update detail
					const detail = rerankDetails.find(d => d.index === tc.index)
					if (detail) {
						detail.valueVerification = vv
						detail.totalBonus += bonus
					}
				}
			}
		}

		// Sort by score descending (deterministic tie-breaking)
		reranked.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score
			// Tie-breakers: prefer non-rejected
			if (a.rejected !== b.rejected) return a.rejected ? 1 : -1
			// Prefer EXPLAIN-passed
			const aExplain = a.explainPassed === true ? 1 : 0
			const bExplain = b.explainPassed === true ? 1 : 0
			if (bExplain !== aExplain) return bExplain - aExplain
			// Stable: lower index first
			return a.index - b.index
		})

		return {
			candidates: reranked,
			rerankDetails,
		}
	}
}

/**
 * Get the default reranker instance.
 */
export function getReranker(): CandidateReranker {
	return new HeuristicReranker()
}
