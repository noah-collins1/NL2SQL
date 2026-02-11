/**
 * Candidate Reranker (Phase 3 Stub)
 *
 * Interface for optional reranking of SQL candidates using schema adherence
 * and join plausibility scoring. Default implementation is a no-op until
 * explicitly enabled.
 */

import type { SQLCandidate } from "./multi_candidate.js"
import type { SchemaLinkBundle } from "./schema_linker.js"
import type { JoinPlan } from "./join_planner.js"

// ============================================================================
// Feature Flag
// ============================================================================

export const CANDIDATE_RERANKER_ENABLED = process.env.CANDIDATE_RERANKER_ENABLED === "true"

// ============================================================================
// Types
// ============================================================================

export interface RerankerContext {
	question: string
	schemaLinkBundle: SchemaLinkBundle | null
	joinPlan: JoinPlan | null
}

export interface CandidateReranker {
	rerank(candidates: SQLCandidate[], context: RerankerContext): Promise<SQLCandidate[]>
}

// ============================================================================
// Schema Adherence Scoring
// ============================================================================

/**
 * Compute schema adherence: fraction of columns used in SQL
 * that appear in the schema link bundle.
 *
 * @param sql - SQL query
 * @param bundle - Schema link bundle
 * @returns Score between 0 and 1
 */
export function computeSchemaAdherence(sql: string, bundle: SchemaLinkBundle | null): number {
	if (!bundle) return 1.0 // No bundle = no penalty

	// Extract column-like references from SQL (simple heuristic)
	const columnRefs = extractColumnRefsFromSQL(sql)
	if (columnRefs.length === 0) return 1.0

	// Build set of all known columns from the bundle
	const knownColumns = new Set<string>()
	for (const [table, cols] of Object.entries(bundle.linkedColumns)) {
		for (const col of cols) {
			knownColumns.add(col.column.toLowerCase())
			knownColumns.add(`${table}.${col.column}`.toLowerCase())
		}
	}

	// Also include all table names as known (for FROM/JOIN)
	for (const t of bundle.linkedTables) {
		knownColumns.add(t.table.toLowerCase())
	}

	// Count how many SQL column refs are in the known set
	let matched = 0
	for (const ref of columnRefs) {
		if (knownColumns.has(ref.toLowerCase())) {
			matched++
		}
	}

	return columnRefs.length > 0 ? matched / columnRefs.length : 1.0
}

/**
 * Check if SQL joins match one of the planned skeletons.
 *
 * @param sql - SQL query
 * @param plan - Join plan
 * @returns Score between 0 and 1
 */
export function computeJoinMatch(sql: string, plan: JoinPlan | null): number {
	if (!plan || plan.skeletons.length === 0) return 1.0 // No plan = no penalty

	const upperSQL = sql.toUpperCase()

	// Check if any skeleton's join columns appear in the SQL
	for (const skeleton of plan.skeletons) {
		let matchedJoins = 0
		for (const join of skeleton.joins) {
			const condition = `${join.fromColumn}`.toUpperCase()
			if (upperSQL.includes(condition)) {
				matchedJoins++
			}
		}

		if (skeleton.joins.length === 0) return 1.0
		const score = matchedJoins / skeleton.joins.length
		if (score > 0.5) return score
	}

	return 0.0
}

/**
 * Extract column-like references from SQL (simple heuristic).
 * Looks for identifiers after SELECT, WHERE, ON, GROUP BY, ORDER BY, etc.
 */
function extractColumnRefsFromSQL(sql: string): string[] {
	const refs: string[] = []

	// Match table.column or standalone column patterns
	const pattern = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\b/g
	let match: RegExpExecArray | null
	const sqlKeywords = new Set([
		"SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
		"ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "GROUP", "BY",
		"ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "HAVING", "UNION", "ALL",
		"DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "BETWEEN", "LIKE",
		"EXISTS", "ANY", "SOME", "TRUE", "FALSE", "COUNT", "SUM", "AVG",
		"MAX", "MIN", "COALESCE", "EXTRACT", "YEAR", "MONTH", "DAY",
		"CAST", "INTERVAL", "DATE", "TEXT", "INTEGER", "NUMERIC", "BOOLEAN",
		"VARCHAR", "TIMESTAMP", "CROSS", "FULL", "SET", "OVER", "PARTITION",
		"ROW", "ROWS", "RANGE", "WINDOW", "LATERAL", "WITH", "RECURSIVE",
	])

	while ((match = pattern.exec(sql)) !== null) {
		const ref = match[1]
		if (!sqlKeywords.has(ref.toUpperCase())) {
			refs.push(ref)
		}
	}

	return refs
}

// ============================================================================
// Default Heuristic Reranker
// ============================================================================

/**
 * Default heuristic reranker that applies schema adherence and join match scoring.
 * Only active when CANDIDATE_RERANKER_ENABLED is true.
 */
export class HeuristicReranker implements CandidateReranker {
	private schemaAdherenceBonus: number
	private joinMatchBonus: number

	constructor(schemaAdherenceBonus = 15, joinMatchBonus = 20) {
		this.schemaAdherenceBonus = schemaAdherenceBonus
		this.joinMatchBonus = joinMatchBonus
	}

	async rerank(candidates: SQLCandidate[], context: RerankerContext): Promise<SQLCandidate[]> {
		if (!CANDIDATE_RERANKER_ENABLED) return candidates

		const reranked = candidates.map(c => {
			const adherence = computeSchemaAdherence(c.sql, context.schemaLinkBundle)
			const joinMatch = computeJoinMatch(c.sql, context.joinPlan)

			const bonus = adherence * this.schemaAdherenceBonus + joinMatch * this.joinMatchBonus
			return {
				...c,
				score: c.score + bonus,
			}
		})

		return reranked.sort((a, b) => b.score - a.score)
	}
}

/**
 * Get the default reranker instance.
 */
export function getReranker(): CandidateReranker {
	return new HeuristicReranker()
}
