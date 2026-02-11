/**
 * Surgical Column Whitelist Module
 *
 * Provides table-scoped column whitelist for repairing 42703 (undefined column) errors.
 * Only activates when column errors are detected - does NOT add to base prompts.
 *
 * Two-Tier Gating Architecture:
 * - **Observe tier** (`evaluateStrictGating`): Logs what whitelist WOULD do. Used in
 *   shadow observation mode to measure precision without changing behavior.
 * - **Active tier** (`evaluateActiveGating`): Stricter gate that guarantees correctedSQL
 *   is present when passed=true. Bypasses `rewriteMinConfidence` — the active gate is
 *   the sole decision-maker in active mode. Includes score separation and risk blacklist.
 *
 * Risk Blacklist:
 * Prevents dangerous semantic flips (e.g. vendor_name → vendor_number). Uses token-diff
 * approach: computes refOnly/candOnly token sets and checks against configured pairs.
 * Only blocks in active mode by default (applyToObserve=false).
 *
 * To safely enable active mode:
 * 1. Run in observe mode and review shadow_whitelist_observations in exam logs
 * 2. Verify active_gating_passed precision is acceptable
 * 3. Switch mode from "observe" to "active"
 *
 * Note: `rewriteMinConfidence` is bypassed in active mode — `evaluateActiveGating` calls
 * `findColumnMatches` directly and applies its own gates, never going through
 * `attemptDeterministicRewrite`.
 *
 * Flow:
 * 1. EXPLAIN fails with 42703 -> extract failing alias.column
 * 2. Resolve alias to table using SQL parsing
 * 3. Build surgical whitelist (resolved table + optional FK neighbors)
 * 4. Attempt deterministic rewrite (conservative, high-confidence only)
 * 5. If rewrite fails, generate compact repair prompt with whitelist
 */

import type { SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Configuration
// ============================================================================

export interface SurgicalWhitelistConfig {
	/** Enable surgical whitelist feature */
	enabled: boolean

	/** Mode: "observe" logs what whitelist WOULD do; "active" applies rewrites */
	mode: "observe" | "active"

	/** When true, observe only in EXAM_MODE */
	observeInExamOnly: boolean

	/** Include 1-hop FK neighbor tables in whitelist */
	includeFkNeighbors: boolean

	/** Maximum FK neighbor tables to include */
	maxNeighborTables: number

	/** Maximum total tables in whitelist */
	maxTablesTotal: number

	/** Maximum columns per table (compression threshold) */
	maxColumnsPerTable: number

	/** Priority column keywords for compression (when over maxColumnsPerTable) */
	priorityKeywords: string[]

	/** Policy for ambiguous alias resolution */
	ambiguityPolicy: "addAllFromJoinTables" | "failFast"

	/** Minimum similarity score for deterministic rewrite */
	rewriteMinConfidence: number

	/** Reject rewrite if multiple candidates have similar scores (within this delta) */
	rewriteAmbiguityDelta: number

	/** Strict gating: all must pass before whitelist can act */
	strictGating: {
		requireUnambiguousAlias: boolean
		requireAutocorrectFailed: boolean
		/** Minimum dominance delta: best_score - second_best_score */
		minDominanceDelta: number
		/** Minimum lexical score floor (used with containment) */
		minLexicalFloor: number
		/** Require containment bonus for lexical-only matches */
		requireContainmentForLexical: boolean
		/** Minimum semantic score floor (future: embedding-based) */
		minSemanticFloor: number
		/** Enable semantic scoring via embeddings (default false) */
		enableSemanticScoring: boolean
	}

	/** Active rewrite gate: stricter tier that guarantees correctedSQL when passed */
	activeRewriteGate: {
		minScore: number
		minDominance: number
		requireContainmentOrExact: boolean
		requireAutocorrectFailed: boolean
		requireUnambiguousAlias: boolean
		requireScoreSeparation: boolean
		minScoreDelta: number
		minScoreRatio: number
	}

	/** Risk blacklist: blocks dangerous semantic flips */
	riskBlacklist: {
		enabled: boolean
		pairs: [string, string][]
		action: "block" | "penalize"
		penalty: number
		applyToObserve: boolean
	}
}

export const SURGICAL_WHITELIST_CONFIG: SurgicalWhitelistConfig = {
	enabled: true, // Observe mode: shadow-only, no behavior change
	mode: "observe",
	observeInExamOnly: true,
	includeFkNeighbors: true,
	maxNeighborTables: 3,
	maxTablesTotal: 4,
	maxColumnsPerTable: 60,
	priorityKeywords: ["id", "name", "amount", "qty", "quantity", "date", "status", "type", "total", "count"],
	ambiguityPolicy: "addAllFromJoinTables",
	rewriteMinConfidence: 0.75,
	rewriteAmbiguityDelta: 0.1,
	strictGating: {
		requireUnambiguousAlias: true,
		requireAutocorrectFailed: true,
		minDominanceDelta: 0.15,
		minLexicalFloor: 0.55,
		requireContainmentForLexical: true,
		minSemanticFloor: 0.75,
		enableSemanticScoring: false,
	},
	activeRewriteGate: {
		minScore: 0.80,
		minDominance: 0.60,
		requireContainmentOrExact: true,
		requireAutocorrectFailed: true,
		requireUnambiguousAlias: true,
		requireScoreSeparation: true,
		minScoreDelta: 0.10,
		minScoreRatio: 1.15,
	},
	riskBlacklist: {
		enabled: true,
		pairs: [["name", "number"], ["name", "id"], ["amount", "total"], ["date", "id"], ["vendor", "customer"]],
		action: "block" as const,
		penalty: 0.15,
		applyToObserve: false,
	},
}

// ============================================================================
// Keyword Rejection & Token Utilities
// ============================================================================

/** SQL functions/keywords that look like column names but aren't */
const SQL_KEYWORD_REFS = new Set([
	"year", "month", "day", "hour", "minute", "second",
	"date", "time", "timestamp", "interval",
	"extract", "count", "sum", "avg", "min", "max",
	"now", "current_date", "current_timestamp",
	"true", "false", "null", "coalesce", "cast",
])

/**
 * Check if a failing column reference is actually a SQL keyword/function,
 * not a real column name.
 */
export function isKeywordReference(column: string): boolean {
	return SQL_KEYWORD_REFS.has(column.toLowerCase())
}

/**
 * Split a column name into snake_case tokens.
 * "quantity_on_hand" -> ["quantity", "on", "hand"]
 * "gl_account_id" -> ["gl", "account", "id"]
 */
export function tokenize(name: string): string[] {
	return name.toLowerCase().split("_").filter(t => t.length > 0)
}

/**
 * Compute token-containment relationship between ref and candidate.
 * Returns: { refInCandidate, candidateInRef, tokenOverlap }
 */
export function computeContainment(
	refColumn: string,
	candidateColumn: string,
): { refInCandidate: boolean; candidateInRef: boolean; tokenOverlap: number } {
	const refTokens = tokenize(refColumn)
	const candTokens = tokenize(candidateColumn)

	if (refTokens.length === 0 || candTokens.length === 0) {
		return { refInCandidate: false, candidateInRef: false, tokenOverlap: 0 }
	}

	const refSet = new Set(refTokens)
	const candSet = new Set(candTokens)

	const overlap = [...refSet].filter(t => candSet.has(t)).length
	const refInCandidate = refTokens.every(t => candSet.has(t))
	const candidateInRef = candTokens.every(t => refSet.has(t))

	// Normalize overlap to [0,1] by Jaccard-style: overlap / union
	const union = new Set([...refTokens, ...candTokens]).size
	const tokenOverlap = union > 0 ? overlap / union : 0

	return { refInCandidate, candidateInRef, tokenOverlap }
}

// ============================================================================
// Telemetry Types
// ============================================================================

export interface WhitelistTelemetry {
	/** Whether whitelist logic was triggered */
	whitelist_triggered: boolean

	/** Number of tables in whitelist */
	whitelist_tables_count: number

	/** Total columns across all whitelist tables */
	whitelist_columns_total: number

	/** Alias resolution details */
	alias_resolution: {
		success: boolean
		alias: string | null
		resolved_table: string | null
		ambiguity: boolean
		all_from_join_tables?: string[]
	}

	/** Deterministic column rewrites attempted */
	deterministic_rewrites: Array<{
		from_column: string
		to_column: string
		table: string
		confidence: number
		applied: boolean
		rejection_reason?: string
	}>

	/** Whether LLM repair used whitelist */
	repair_used_whitelist: boolean

	/** Whitelist prompt size (characters) */
	whitelist_prompt_size?: number
}

// ============================================================================
// Shadow Observation Types
// ============================================================================

export interface WhitelistShadowObservation {
	attempt: number
	failing_reference: string | null
	alias_resolved: string | null
	alias_ambiguous: boolean
	would_rewrite: boolean
	rewrite_to_column?: string
	rewrite_confidence?: number
	rewrite_rejection_reason?: string
	candidate_count: number
	strict_gating_passed: boolean
	strict_gating_failures: string[]
	autocorrect_attempted: boolean
	autocorrect_succeeded: boolean
	pipeline_outcome?: "success" | "failure"
	would_have_helped?: boolean
	would_have_been_redundant?: boolean
	would_have_acted_on_success?: boolean
	// Composite scoring detail
	lexical_score?: number
	containment_bonus?: number
	has_containment?: boolean
	dominance_delta?: number
	is_keyword?: boolean
	top_candidates?: Array<{ column: string; score: number; containment_bonus: number }>
	// Active gating (action tier)
	active_gating_passed?: boolean
	active_gating_failures?: string[]
	rewrite_would_fire_in_active_mode?: boolean
	// Top-2 score info
	top1_score?: number
	top2_score?: number | null
	score_delta?: number | null
	score_ratio?: number | null
	// Risk blacklist info
	risk_blacklist_hit?: string
	risk_blacklist_action?: "block" | "penalize" | "none"
	// Candidate counts
	raw_candidate_count?: number
	eligible_candidate_count?: number
}

// ============================================================================
// Strict Gating Evaluation
// ============================================================================

/** Extended gating result with scoring detail for shadow observation logging */
export interface StrictGatingResult {
	passed: boolean
	failures: string[]
	bestScore: number
	bestLexicalScore: number
	bestContainmentBonus: number
	dominance: number
	hasContainment: boolean
	isKeyword: boolean
	topCandidates: Array<{ column: string; score: number; containment_bonus: number }>
}

export interface ActiveGatingResult {
	passed: boolean
	failures: string[]
	correctedSQL?: string
	bestScore: number
	dominance: number
	topCandidate?: { column: string; table: string; score: number }
	top2Score: number | null
	scoreDelta: number | null
	scoreRatio: number | null
	rawCandidateCount: number
	eligibleCandidateCount: number
	riskBlacklistHit?: string
	riskBlacklistAction?: "block" | "penalize" | "none"
}

/**
 * Evaluate strict gating criteria for the surgical whitelist.
 * Uses dominance + category rules instead of a single confidence threshold.
 *
 * Gates:
 * 1. Alias must resolve unambiguously (no ambiguous or unresolved aliases)
 * 2. Autocorrect must have been attempted and failed
 * 3. Failing reference must not be a SQL keyword
 * 4. Confidence floor: best score >= minLexicalFloor
 * 5. Containment requirement: if requireContainmentForLexical, best match needs containment
 * 6. Dominance: best_score - second_best >= minDominanceDelta (or sole candidate)
 */
export function evaluateStrictGating(
	surgicalResult: ReturnType<typeof processSurgicalWhitelist>,
	autocorrectAttempted: boolean,
	autocorrectSucceeded: boolean,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): StrictGatingResult {
	const failures: string[] = []

	// Extract candidate info from rewrite result
	const rewriteResult = surgicalResult.telemetry.deterministic_rewrites
	const candidates = (surgicalResult as any)._rewriteCandidates as ColumnMatch[] | undefined

	// Use the first telemetry entry for scoring detail
	const bestRewrite = rewriteResult[0]

	// Infer scoring from the best rewrite candidate (via processSurgicalWhitelist telemetry)
	const bestScore = bestRewrite?.confidence ?? 0
	// We need to re-derive containment info; recompute from failing reference
	const failingRef = surgicalResult.whitelistResult.debug.failing_reference
	const failingColumn = failingRef?.includes(".") ? failingRef.split(".")[1] : failingRef
	const bestColumn = bestRewrite?.to_column ?? ""

	const containmentInfo = failingColumn && bestColumn
		? computeContainment(failingColumn, bestColumn)
		: { refInCandidate: false, candidateInRef: false, tokenOverlap: 0 }
	const hasContainment = containmentInfo.refInCandidate || containmentInfo.candidateInRef
	const containmentBonus = containmentInfo.refInCandidate ? 0.30
		: containmentInfo.candidateInRef ? 0.20 : 0

	// Compute dominance from telemetry (top two candidates)
	let dominance = 0
	if (rewriteResult.length >= 2) {
		dominance = rewriteResult[0].confidence - rewriteResult[1].confidence
	} else if (rewriteResult.length === 1) {
		dominance = rewriteResult[0].confidence // sole candidate
	}

	// Lexical score = total score minus containment bonus
	const bestLexicalScore = Math.max(0, bestScore - containmentBonus)

	// Check if failing ref is a keyword
	const isKeyword = failingColumn ? isKeywordReference(failingColumn) : false

	// Build top candidates for logging
	const topCandidates = rewriteResult.slice(0, 2).map(r => ({
		column: r.to_column,
		score: r.confidence,
		containment_bonus: r.to_column && failingColumn
			? (computeContainment(failingColumn, r.to_column).refInCandidate ? 0.30
				: computeContainment(failingColumn, r.to_column).candidateInRef ? 0.20 : 0)
			: 0,
	}))

	// --- Gate 1: Alias must resolve unambiguously ---
	if (config.strictGating.requireUnambiguousAlias) {
		if (surgicalResult.telemetry.alias_resolution.ambiguity) {
			failures.push("ambiguous_alias")
		}
		if (!surgicalResult.telemetry.alias_resolution.resolved_table) {
			failures.push("no_resolved_table")
		}
	}

	// --- Gate 2: Autocorrect must have been attempted and failed ---
	if (config.strictGating.requireAutocorrectFailed) {
		if (!autocorrectAttempted) {
			failures.push("autocorrect_not_attempted")
		} else if (autocorrectSucceeded) {
			failures.push("autocorrect_already_succeeded")
		}
	}

	// --- Gate 3: Keyword rejection ---
	if (isKeyword) {
		failures.push(`keyword_reference_${failingColumn}`)
	}

	// --- Gate 4: Confidence floor ---
	if (bestScore < config.strictGating.minLexicalFloor) {
		failures.push(`score_${bestScore.toFixed(2)}_below_floor_${config.strictGating.minLexicalFloor}`)
	}

	// --- Gate 5: Containment requirement ---
	// Skip for high-confidence matches (>= 0.80 covers snake_normalized at 0.85+)
	// because character-identical-after-normalization is inherently strong signal
	if (config.strictGating.requireContainmentForLexical && !hasContainment && bestScore < 0.80) {
		// Only block if we're relying on lexical scoring (no semantic)
		if (!config.strictGating.enableSemanticScoring) {
			failures.push("no_containment")
		}
	}

	// --- Gate 6: Dominance ---
	if (rewriteResult.length >= 2 && dominance < config.strictGating.minDominanceDelta) {
		failures.push(`dominance_${dominance.toFixed(2)}_below_${config.strictGating.minDominanceDelta}`)
	}

	// --- Gate 7: No candidates at all ---
	if (rewriteResult.length === 0) {
		failures.push("no_candidates")
	}

	return {
		passed: failures.length === 0,
		failures,
		bestScore,
		bestLexicalScore,
		bestContainmentBonus: containmentBonus,
		dominance,
		hasContainment,
		isKeyword,
		topCandidates,
	}
}

// ============================================================================
// Risk Blacklist
// ============================================================================

/**
 * Check if a candidate column triggers the risk blacklist.
 * Uses token-diff approach: computes refOnly/candOnly token sets and checks
 * against configured dangerous pairs.
 *
 * Examples:
 *   vendor_name -> vendor_number: refOnly=["name"], candOnly=["number"] → BLOCKED
 *   actual_amount -> amount: refOnly=["actual"], candOnly=[] → OK
 *   order_date -> order_id: refOnly=["date"], candOnly=["id"] → BLOCKED
 */
export function checkRiskBlacklist(
	refColumn: string,
	candidateColumn: string,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): { hit: boolean; pair?: string; action: "block" | "penalize" | "none" } {
	if (!config.riskBlacklist.enabled) {
		return { hit: false, action: "none" }
	}

	const refTokens = new Set(tokenize(refColumn))
	const candTokens = new Set(tokenize(candidateColumn))

	const refOnly = new Set([...refTokens].filter(t => !candTokens.has(t)))
	const candOnly = new Set([...candTokens].filter(t => !refTokens.has(t)))

	for (const [a, b] of config.riskBlacklist.pairs) {
		if ((refOnly.has(a) && candOnly.has(b)) || (refOnly.has(b) && candOnly.has(a))) {
			return {
				hit: true,
				pair: `${a}:${b}`,
				action: config.riskBlacklist.action,
			}
		}
	}

	return { hit: false, action: "none" }
}

// ============================================================================
// Active Gating Evaluation
// ============================================================================

/**
 * Evaluate active gating criteria — the stricter tier that guarantees correctedSQL
 * is present when passed=true. Bypasses rewriteMinConfidence by calling
 * findColumnMatches directly.
 *
 * 9 gates (all must pass):
 * 1. Keyword rejection
 * 2. Alias unambiguous
 * 3. Autocorrect failed
 * 4. Has candidates
 * 5. Score floor (>= minScore)
 * 6. Dominance (best - second >= minDominance) — only if 2+ candidates
 * 7. Score separation (delta OR ratio) — only if 2+ candidates
 * 8. Containment OR exact match
 * 9. Risk blacklist
 *
 * Key invariant: passed === true guarantees correctedSQL is present.
 */
export function evaluateActiveGating(
	surgicalResult: ReturnType<typeof processSurgicalWhitelist>,
	autocorrectAttempted: boolean,
	autocorrectSucceeded: boolean,
	sql: string,
	errorMessage: string,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): ActiveGatingResult {
	const failures: string[] = []
	const gate = config.activeRewriteGate

	// Extract failing reference info
	const failingRef = extractFailingReference(errorMessage, sql)
	const failingColumn = failingRef?.column ?? ""

	// --- Gate 1: Keyword rejection ---
	if (failingColumn && isKeywordReference(failingColumn)) {
		failures.push(`keyword_reference_${failingColumn}`)
	}

	// --- Gate 2: Alias unambiguous ---
	if (gate.requireUnambiguousAlias) {
		if (surgicalResult.telemetry.alias_resolution.ambiguity) {
			failures.push("ambiguous_alias")
		}
		if (!surgicalResult.telemetry.alias_resolution.resolved_table) {
			failures.push("no_resolved_table")
		}
	}

	// --- Gate 3: Autocorrect failed ---
	if (gate.requireAutocorrectFailed) {
		if (!autocorrectAttempted) {
			failures.push("autocorrect_not_attempted")
		} else if (autocorrectSucceeded) {
			failures.push("autocorrect_already_succeeded")
		}
	}

	// --- Gate 4: Has candidates (call findColumnMatches directly) ---
	const resolvedTable = surgicalResult.telemetry.alias_resolution.resolved_table ?? undefined
	const matches = failingColumn
		? findColumnMatches(failingColumn, surgicalResult.whitelistResult.tables, resolvedTable)
		: []
	const rawCandidateCount = matches.length

	if (matches.length === 0) {
		failures.push("no_candidates")
		return {
			passed: false,
			failures,
			bestScore: 0,
			dominance: 0,
			top2Score: null,
			scoreDelta: null,
			scoreRatio: null,
			rawCandidateCount: 0,
			eligibleCandidateCount: 0,
		}
	}

	const best = matches[0]
	const second = matches.length >= 2 ? matches[1] : null
	const bestScore = best.score
	const top2Score = second?.score ?? null
	const scoreDelta = second ? bestScore - second.score : null
	const eps = 0.001
	const scoreRatio = second ? bestScore / Math.max(second.score, eps) : null

	// --- Gate 5: Score floor ---
	if (bestScore < gate.minScore) {
		failures.push(`score_${bestScore.toFixed(2)}_below_floor_${gate.minScore}`)
	}

	// --- Gate 6: Dominance ---
	let dominance = bestScore // sole candidate: fully dominant
	if (matches.length >= 2) {
		dominance = bestScore - matches[1].score
		if (dominance < gate.minDominance) {
			failures.push(`dominance_${dominance.toFixed(2)}_below_${gate.minDominance}`)
		}
	}

	// --- Gate 7: Score separation (prevents knife-edge rewrites) ---
	if (gate.requireScoreSeparation && matches.length >= 2) {
		const deltaOk = scoreDelta !== null && scoreDelta >= gate.minScoreDelta
		const ratioOk = scoreRatio !== null && scoreRatio >= gate.minScoreRatio
		if (!deltaOk && !ratioOk) {
			failures.push(`separation_delta_${scoreDelta?.toFixed(2)}_ratio_${scoreRatio?.toFixed(2)}`)
		}
	}

	// --- Gate 8: Containment OR exact ---
	if (gate.requireContainmentOrExact) {
		const containment = computeContainment(failingColumn, best.column)
		const snakeNormEq = failingColumn.replace(/_/g, "").toLowerCase() === best.column.replace(/_/g, "").toLowerCase()
		if (!containment.refInCandidate && !containment.candidateInRef && !snakeNormEq) {
			failures.push("no_containment_or_exact")
		}
	}

	// --- Gate 9: Risk blacklist ---
	const blacklistCheck = checkRiskBlacklist(failingColumn, best.column, config)
	let effectiveScore = bestScore
	if (blacklistCheck.hit) {
		if (blacklistCheck.action === "block") {
			failures.push(`risk_blacklist:${blacklistCheck.pair}`)
		} else if (blacklistCheck.action === "penalize") {
			effectiveScore -= config.riskBlacklist.penalty
			if (effectiveScore < gate.minScore) {
				failures.push(`risk_blacklist_penalized_score_${effectiveScore.toFixed(2)}_below_floor_${gate.minScore}`)
			}
		}
	}

	// Build base result
	const result: ActiveGatingResult = {
		passed: false,
		failures,
		bestScore,
		dominance,
		topCandidate: { column: best.column, table: best.table, score: best.score },
		top2Score,
		scoreDelta,
		scoreRatio,
		rawCandidateCount,
		eligibleCandidateCount: rawCandidateCount,
		riskBlacklistHit: blacklistCheck.hit ? blacklistCheck.pair : undefined,
		riskBlacklistAction: blacklistCheck.hit ? blacklistCheck.action : "none",
	}

	// If all gates passed, apply the SQL rewrite
	if (failures.length === 0 && failingRef) {
		let correctedSQL = sql
		if (failingRef.qualified && failingRef.alias) {
			const pattern = new RegExp(`\\b${escapeRegex(failingRef.alias)}\\.${escapeRegex(failingRef.column)}\\b`, "gi")
			correctedSQL = sql.replace(pattern, `${failingRef.alias}.${best.column}`)
		} else {
			const pattern = new RegExp(`\\b${escapeRegex(failingRef.column)}\\b`, "gi")
			correctedSQL = sql.replace(pattern, best.column)
		}

		if (correctedSQL !== sql) {
			result.passed = true
			result.correctedSQL = correctedSQL
		} else {
			result.failures.push("replacement_pattern_not_found")
		}
	}

	return result
}

// ============================================================================
// Result Types
// ============================================================================

export interface SurgicalWhitelistResult {
	/** The tables and columns in the whitelist */
	tables: Record<string, string[]>

	/** Primary table(s) implicated by the error */
	primaryTables: string[]

	/** FK neighbor tables included */
	neighborTables: string[]

	/** Why this scope was selected */
	scopeReason: string

	/** Debug info for troubleshooting */
	debug: {
		failing_reference: string | null
		alias_resolved: string | null
		alias_resolution_method: string | null
		compression_applied: boolean
		columns_before_compression?: number
		columns_after_compression?: number
	}
}

export interface DeterministicRewriteResult {
	/** Whether a rewrite was applied */
	applied: boolean

	/** The corrected SQL (or original if not applied) */
	sql: string

	/** Rewrites that were applied */
	rewrites: Array<{
		from_column: string
		to_column: string
		table: string
		confidence: number
	}>

	/** Why rewrite was rejected (if applicable) */
	rejection_reason?: string

	/** All candidates considered */
	candidates?: Array<{
		column: string
		table: string
		score: number
		match_type: string
		containment_bonus: number
		ref_in_candidate: boolean
		candidate_in_ref: boolean
	}>

	/** Dominance: best_score - second_best_score (undefined if < 2 candidates) */
	dominance?: number
}

// ============================================================================
// Alias Resolution (Robust FROM/JOIN Parsing)
// ============================================================================

interface FromJoinEntry {
	table: string
	alias: string | null
	source: "from" | "join"
}

/**
 * Extract all FROM and JOIN table references with their aliases
 * Supports: FROM table, FROM table alias, FROM table AS alias, FROM schema.table AS alias
 */
export function parseFromJoinClauses(sql: string): FromJoinEntry[] {
	const entries: FromJoinEntry[] = []
	const normalized = sql.replace(/\s+/g, " ").trim()

	// Pattern for FROM clause (may have multiple tables with commas)
	// FROM table1 [AS] alias1, table2 [AS] alias2
	// Note: Match full " [LEFT|RIGHT|...] JOIN" pattern to avoid capturing "LEFT" in FROM clause
	const fromMatch = normalized.match(/\bFROM\s+(.+?)(?:\bWHERE\b|\s(?:(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)\s+)?JOIN\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|;|$)/i)
	if (fromMatch) {
		const fromPart = fromMatch[1]
		// Split by comma for multiple FROM tables
		const fromTables = fromPart.split(/,/)
		for (const tablePart of fromTables) {
			const entry = parseTableReference(tablePart.trim(), "from")
			if (entry) entries.push(entry)
		}
	}

	// Pattern for JOIN clauses
	const joinPattern = /\b(?:LEFT\s+|RIGHT\s+|INNER\s+|OUTER\s+|CROSS\s+|FULL\s+)?JOIN\s+([^\s,]+(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?)\s+ON\b/gi
	let match
	while ((match = joinPattern.exec(normalized)) !== null) {
		const entry = parseTableReference(match[1], "join")
		if (entry) entries.push(entry)
	}

	return entries
}

/**
 * Parse a single table reference like "table", "table alias", "table AS alias", "schema.table AS alias"
 */
function parseTableReference(ref: string, source: "from" | "join"): FromJoinEntry | null {
	const trimmed = ref.trim()
	if (!trimmed) return null

	// Pattern: [schema.]table [AS] alias
	const pattern = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?$/i
	const match = trimmed.match(pattern)

	if (match) {
		const table = match[2].toLowerCase()
		const alias = match[3]?.toLowerCase() || null

		// Skip if "alias" is a keyword
		const keywords = ["on", "where", "group", "order", "limit", "having", "join", "left", "right", "inner", "outer", "and", "or", "as"]
		if (alias && keywords.includes(alias)) {
			return { table, alias: null, source }
		}

		return { table, alias, source }
	}

	return null
}

/**
 * Build a map of alias -> table from FROM/JOIN clauses
 * Also includes table -> table for direct references
 */
export function buildAliasMapRobust(sql: string): Map<string, string> {
	const aliasMap = new Map<string, string>()
	const entries = parseFromJoinClauses(sql)

	for (const entry of entries) {
		// Table name can always be used as a reference
		aliasMap.set(entry.table, entry.table)

		// If there's an alias, map it to the table
		if (entry.alias && entry.alias !== entry.table) {
			aliasMap.set(entry.alias, entry.table)
		}
	}

	return aliasMap
}

/**
 * Get all tables referenced in FROM/JOIN clauses
 */
export function getFromJoinTables(sql: string): string[] {
	const entries = parseFromJoinClauses(sql)
	return [...new Set(entries.map(e => e.table))]
}

/**
 * Extract the failing column reference from error message and SQL
 * Returns: { alias, column, qualified } where qualified indicates if alias.column was used
 */
export function extractFailingReference(
	errorMessage: string,
	sql: string,
): { alias: string | null; column: string; qualified: boolean } | null {
	// Pattern 1: column "alias.column" does not exist (quoted qualified)
	const quotedQualified = /column "([^"]+)\.([^"]+)" does not exist/i
	const match1 = quotedQualified.exec(errorMessage)
	if (match1) {
		return { alias: match1[1].toLowerCase(), column: match1[2].toLowerCase(), qualified: true }
	}

	// Pattern 2: column alias.column does not exist (unquoted qualified)
	const unquotedQualified = /column ([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*) does not exist/i
	const match2 = unquotedQualified.exec(errorMessage)
	if (match2) {
		return { alias: match2[1].toLowerCase(), column: match2[2].toLowerCase(), qualified: true }
	}

	// Pattern 3: column "column" of relation "table" does not exist
	const withRelation = /column "([^"]+)" of relation "([^"]+)" does not exist/i
	const match3 = withRelation.exec(errorMessage)
	if (match3) {
		return { alias: match3[2].toLowerCase(), column: match3[1].toLowerCase(), qualified: false }
	}

	// Pattern 4: column "column" does not exist (quoted simple)
	const quotedSimple = /column "([^"]+)" does not exist/i
	const match4 = quotedSimple.exec(errorMessage)
	if (match4) {
		const column = match4[1].toLowerCase()
		// Try to find this column in SQL with a qualifier
		const qualifierPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\.${escapeRegex(column)}\\b`, "i")
		const sqlMatch = qualifierPattern.exec(sql)
		if (sqlMatch) {
			return { alias: sqlMatch[1].toLowerCase(), column, qualified: true }
		}
		return { alias: null, column, qualified: false }
	}

	// Pattern 5: column column does not exist (unquoted simple)
	const unquotedSimple = /column (\w+) does not exist/i
	const match5 = unquotedSimple.exec(errorMessage)
	if (match5) {
		const column = match5[1].toLowerCase()
		const qualifierPattern = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_]*)\\.${escapeRegex(column)}\\b`, "i")
		const sqlMatch = qualifierPattern.exec(sql)
		if (sqlMatch) {
			return { alias: sqlMatch[1].toLowerCase(), column, qualified: true }
		}
		return { alias: null, column, qualified: false }
	}

	return null
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Resolve alias to table name
 * Returns: { table, method } where method describes how resolution was done
 */
export function resolveAliasToTableRobust(
	alias: string,
	sql: string,
	schemaContext: SchemaContextPacket,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): { table: string | null; method: string; ambiguous: boolean; candidates?: string[] } {
	const aliasLower = alias.toLowerCase()
	const aliasMap = buildAliasMapRobust(sql)

	// Direct lookup in alias map
	const resolved = aliasMap.get(aliasLower)
	if (resolved) {
		// Verify table exists in schema context
		const inSchema = schemaContext.tables.some(t => t.table_name.toLowerCase() === resolved)
		if (inSchema) {
			return { table: resolved, method: "alias_map", ambiguous: false }
		}
		return { table: resolved, method: "alias_map_unverified", ambiguous: false }
	}

	// Check if alias matches a table name directly in schema
	const directMatch = schemaContext.tables.find(t => t.table_name.toLowerCase() === aliasLower)
	if (directMatch) {
		return { table: directMatch.table_name.toLowerCase(), method: "direct_table_match", ambiguous: false }
	}

	// Ambiguous case: alias not found
	if (config.ambiguityPolicy === "addAllFromJoinTables") {
		const fromJoinTables = getFromJoinTables(sql)
		const validTables = fromJoinTables.filter(t =>
			schemaContext.tables.some(st => st.table_name.toLowerCase() === t)
		)
		if (validTables.length > 0) {
			return {
				table: null,
				method: "ambiguous_using_all_from_join",
				ambiguous: true,
				candidates: validTables,
			}
		}
	}

	return { table: null, method: "unresolved", ambiguous: true }
}

// ============================================================================
// Column Extraction from Schema
// ============================================================================

/**
 * Parse columns from M-Schema format
 * Format: table_name (col1 TYPE, col2 TYPE FK→target, ...)
 */
function parseColumnsFromMSchema(mSchema: string): string[] {
	const columns: string[] = []

	// Extract content between parentheses
	const match = mSchema.match(/\(([^)]+)\)/)
	if (!match) return columns

	const content = match[1]
	const parts = content.split(/,\s*/)

	for (const part of parts) {
		const colMatch = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)
		if (colMatch) {
			columns.push(colMatch[1].toLowerCase())
		}
	}

	return columns
}

/**
 * Get columns for a table from schema context
 */
export function getTableColumns(tableName: string, schemaContext: SchemaContextPacket): string[] {
	const table = schemaContext.tables.find(t => t.table_name.toLowerCase() === tableName.toLowerCase())
	if (!table) return []
	return parseColumnsFromMSchema(table.m_schema)
}

/**
 * Get 1-hop FK neighbor tables
 */
export function getFKNeighbors(
	tableName: string,
	schemaContext: SchemaContextPacket,
	maxNeighbors: number = SURGICAL_WHITELIST_CONFIG.maxNeighborTables,
): string[] {
	const neighbors = new Set<string>()
	const tableNameLower = tableName.toLowerCase()

	for (const edge of schemaContext.fk_edges || []) {
		const fromTable = edge.from_table.toLowerCase()
		const toTable = edge.to_table.toLowerCase()

		if (fromTable === tableNameLower && neighbors.size < maxNeighbors) {
			// Only include if table is in schema context
			if (schemaContext.tables.some(t => t.table_name.toLowerCase() === toTable)) {
				neighbors.add(toTable)
			}
		} else if (toTable === tableNameLower && neighbors.size < maxNeighbors) {
			if (schemaContext.tables.some(t => t.table_name.toLowerCase() === fromTable)) {
				neighbors.add(fromTable)
			}
		}
	}

	return Array.from(neighbors).slice(0, maxNeighbors)
}

// ============================================================================
// Column Compression
// ============================================================================

/**
 * Compress columns if over threshold, prioritizing key columns
 */
export function compressColumns(
	columns: string[],
	maxColumns: number,
	priorityKeywords: string[],
): { columns: string[]; compressed: boolean; originalCount: number } {
	if (columns.length <= maxColumns) {
		return { columns, compressed: false, originalCount: columns.length }
	}

	// Prioritize columns containing priority keywords
	const priority: string[] = []
	const other: string[] = []

	for (const col of columns) {
		const colLower = col.toLowerCase()
		if (priorityKeywords.some(kw => colLower.includes(kw))) {
			priority.push(col)
		} else {
			other.push(col)
		}
	}

	// Take priority columns first, then fill with others
	const result = [
		...priority.slice(0, maxColumns),
		...other.slice(0, maxColumns - Math.min(priority.length, maxColumns)),
	].slice(0, maxColumns)

	return { columns: result, compressed: true, originalCount: columns.length }
}

// ============================================================================
// Build Surgical Whitelist
// ============================================================================

/**
 * Build a surgical column whitelist scoped to the failing reference
 */
export function buildSurgicalColumnWhitelist(
	sql: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): SurgicalWhitelistResult {
	const result: SurgicalWhitelistResult = {
		tables: {},
		primaryTables: [],
		neighborTables: [],
		scopeReason: "",
		debug: {
			failing_reference: null,
			alias_resolved: null,
			alias_resolution_method: null,
			compression_applied: false,
		},
	}

	// Extract failing reference
	const failingRef = extractFailingReference(errorMessage, sql)
	if (!failingRef) {
		result.scopeReason = "could_not_extract_failing_reference"
		return result
	}

	result.debug.failing_reference = failingRef.alias
		? `${failingRef.alias}.${failingRef.column}`
		: failingRef.column

	// Resolve alias to table
	let resolvedTables: string[] = []

	if (failingRef.alias) {
		const resolution = resolveAliasToTableRobust(failingRef.alias, sql, schemaContext, config)
		result.debug.alias_resolved = resolution.table
		result.debug.alias_resolution_method = resolution.method

		if (resolution.table) {
			resolvedTables = [resolution.table]
		} else if (resolution.ambiguous && resolution.candidates) {
			resolvedTables = resolution.candidates
		}
	} else {
		// Unqualified column - search all FROM/JOIN tables
		const fromJoinTables = getFromJoinTables(sql)
		resolvedTables = fromJoinTables.filter(t =>
			schemaContext.tables.some(st => st.table_name.toLowerCase() === t)
		)
		result.debug.alias_resolution_method = "unqualified_all_from_join"
	}

	if (resolvedTables.length === 0) {
		result.scopeReason = "no_tables_resolved"
		return result
	}

	// Limit primary tables
	result.primaryTables = resolvedTables.slice(0, config.maxTablesTotal)

	// Add primary table columns
	let totalColumnsBeforeCompression = 0
	let totalColumnsAfterCompression = 0

	for (const table of result.primaryTables) {
		const columns = getTableColumns(table, schemaContext)
		totalColumnsBeforeCompression += columns.length

		const compressed = compressColumns(columns, config.maxColumnsPerTable, config.priorityKeywords)
		result.tables[table] = compressed.columns
		totalColumnsAfterCompression += compressed.columns.length

		if (compressed.compressed) {
			result.debug.compression_applied = true
		}
	}

	// Add FK neighbor tables if enabled and room allows
	if (config.includeFkNeighbors && result.primaryTables.length < config.maxTablesTotal) {
		const remainingSlots = config.maxTablesTotal - result.primaryTables.length
		const allNeighbors = new Set<string>()

		for (const primary of result.primaryTables) {
			const neighbors = getFKNeighbors(primary, schemaContext, config.maxNeighborTables)
			neighbors.forEach(n => {
				if (!result.primaryTables.includes(n)) {
					allNeighbors.add(n)
				}
			})
		}

		const neighborList = Array.from(allNeighbors).slice(0, remainingSlots)
		result.neighborTables = neighborList

		for (const neighbor of neighborList) {
			const columns = getTableColumns(neighbor, schemaContext)
			totalColumnsBeforeCompression += columns.length

			const compressed = compressColumns(columns, config.maxColumnsPerTable, config.priorityKeywords)
			result.tables[neighbor] = compressed.columns
			totalColumnsAfterCompression += compressed.columns.length

			if (compressed.compressed) {
				result.debug.compression_applied = true
			}
		}
	}

	if (result.debug.compression_applied) {
		result.debug.columns_before_compression = totalColumnsBeforeCompression
		result.debug.columns_after_compression = totalColumnsAfterCompression
	}

	result.scopeReason = result.neighborTables.length > 0
		? `primary_tables_plus_fk_neighbors`
		: `primary_tables_only`

	return result
}

// ============================================================================
// Deterministic Column Rewrite
// ============================================================================

interface ColumnMatch {
	column: string
	table: string
	score: number
	lexicalScore: number
	containmentBonus: number
	matchType: "exact_case" | "exact_lower" | "snake_normalized" | "containment" | "prefix" | "suffix" | "fuzzy"
	refInCandidate: boolean
	candidateInRef: boolean
	tokenOverlap: number
}

/**
 * Find matching columns for a missing column in the whitelist.
 *
 * Scoring: composite of lexical similarity + token-containment bonus.
 * - Lexical: exact, case-insensitive, snake_normalized, prefix, suffix, fuzzy
 * - Containment: ref tokens ⊂ candidate tokens (e.g. "quantity" in "quantity_on_hand")
 *   or candidate tokens ⊂ ref tokens (e.g. "amount" in "actual_amount")
 */
function findColumnMatches(
	missingColumn: string,
	whitelist: Record<string, string[]>,
	targetTable?: string,
): ColumnMatch[] {
	const matches: ColumnMatch[] = []
	const searchLower = missingColumn.toLowerCase()
	const searchNormalized = searchLower.replace(/_/g, "")

	const tablesToSearch = targetTable ? [targetTable] : Object.keys(whitelist)

	for (const table of tablesToSearch) {
		const columns = whitelist[table] || []

		for (const col of columns) {
			const colLower = col.toLowerCase()
			const colNormalized = colLower.replace(/_/g, "")

			let matchType: ColumnMatch["matchType"] | null = null
			let lexicalScore = 0

			// Exact match (shouldn't happen but handle it)
			if (col === missingColumn) {
				matchType = "exact_case"
				lexicalScore = 1.0
			}
			// Case-insensitive exact match
			else if (colLower === searchLower) {
				matchType = "exact_lower"
				lexicalScore = 0.95
			}
			// Snake case normalized match
			else if (colNormalized === searchNormalized) {
				matchType = "snake_normalized"
				lexicalScore = 0.85
			}
			// Prefix match
			else if (colLower.startsWith(searchLower) || searchLower.startsWith(colLower)) {
				const lenRatio = Math.min(searchLower.length, colLower.length) / Math.max(searchLower.length, colLower.length)
				matchType = "prefix"
				lexicalScore = 0.7 * lenRatio
			}
			// Suffix match
			else if (colLower.endsWith(searchLower) || searchLower.endsWith(colLower)) {
				const lenRatio = Math.min(searchLower.length, colLower.length) / Math.max(searchLower.length, colLower.length)
				matchType = "suffix"
				lexicalScore = 0.65 * lenRatio
			}
			// Fuzzy match (Levenshtein)
			else {
				const distance = levenshteinDistance(searchLower, colLower)
				const maxLen = Math.max(searchLower.length, colLower.length)
				const similarity = 1 - distance / maxLen

				if (similarity >= 0.5) {
					matchType = "fuzzy"
					lexicalScore = 0.6 * similarity
				}
			}

			// Compute token containment regardless of lexical match type
			const containment = computeContainment(searchLower, colLower)

			// Containment bonus: if ref tokens are a subset of candidate tokens
			// (e.g. "quantity" → "quantity_on_hand") or vice versa
			// (e.g. "actual_amount" → "amount"), award a bonus.
			let containmentBonus = 0
			if (containment.refInCandidate && searchLower !== colLower) {
				// ref is entirely contained in candidate: strong signal
				containmentBonus = 0.30
			} else if (containment.candidateInRef && searchLower !== colLower) {
				// candidate is entirely contained in ref: medium signal
				containmentBonus = 0.20
			} else if (containment.tokenOverlap >= 0.5 && !matchType) {
				// Significant token overlap but no lexical match yet
				containmentBonus = 0.15
			}

			// If no lexical match but containment found, create a containment-type match
			if (!matchType && containmentBonus > 0) {
				matchType = "containment"
				lexicalScore = containment.tokenOverlap * 0.5
			}

			if (matchType) {
				const score = Math.min(1.0, lexicalScore + containmentBonus)
				matches.push({
					column: col, table, score, lexicalScore, containmentBonus, matchType,
					refInCandidate: containment.refInCandidate,
					candidateInRef: containment.candidateInRef,
					tokenOverlap: containment.tokenOverlap,
				})
			}
		}
	}

	return matches.sort((a, b) => b.score - a.score)
}

/**
 * Levenshtein distance
 */
function levenshteinDistance(s1: string, s2: string): number {
	const m = s1.length
	const n = s2.length

	if (m === 0) return n
	if (n === 0) return m

	const d: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))

	for (let i = 0; i <= m; i++) d[i][0] = i
	for (let j = 0; j <= n; j++) d[0][j] = j

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
		}
	}

	return d[m][n]
}

/**
 * Attempt deterministic rewrite of SQL
 */
export function attemptDeterministicRewrite(
	sql: string,
	errorMessage: string,
	whitelist: Record<string, string[]>,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): DeterministicRewriteResult {
	const result: DeterministicRewriteResult = {
		applied: false,
		sql,
		rewrites: [],
	}

	// Extract failing reference
	const failingRef = extractFailingReference(errorMessage, sql)
	if (!failingRef) {
		result.rejection_reason = "could_not_extract_failing_reference"
		return result
	}

	// Find column matches
	const targetTable = failingRef.alias ? Object.keys(whitelist).find(t => {
		const aliasMap = buildAliasMapRobust(sql)
		return aliasMap.get(failingRef.alias!) === t
	}) : undefined

	// Reject keyword references early
	if (isKeywordReference(failingRef.column)) {
		result.rejection_reason = `keyword_reference_${failingRef.column}`
		return result
	}

	const matches = findColumnMatches(failingRef.column, whitelist, targetTable)
	result.candidates = matches.map(m => ({
		column: m.column,
		table: m.table,
		score: m.score,
		match_type: m.matchType,
		containment_bonus: m.containmentBonus,
		ref_in_candidate: m.refInCandidate,
		candidate_in_ref: m.candidateInRef,
	}))

	if (matches.length === 0) {
		result.rejection_reason = "no_candidates_found"
		return result
	}

	const bestMatch = matches[0]

	// Compute dominance
	if (matches.length >= 2) {
		result.dominance = bestMatch.score - matches[1].score
	} else {
		result.dominance = bestMatch.score // sole candidate: fully dominant
	}

	// Check confidence threshold
	if (bestMatch.score < config.rewriteMinConfidence) {
		result.rejection_reason = `best_candidate_score_${bestMatch.score.toFixed(2)}_below_threshold_${config.rewriteMinConfidence}`
		return result
	}

	// Check ambiguity - if second-best is too close, reject
	if (matches.length > 1) {
		const secondBest = matches[1]
		if (bestMatch.score - secondBest.score < config.rewriteAmbiguityDelta) {
			result.rejection_reason = `ambiguous_candidates_${bestMatch.column}_vs_${secondBest.column}_delta_${(bestMatch.score - secondBest.score).toFixed(2)}`
			return result
		}
	}

	// Apply the rewrite
	let correctedSQL = sql
	const missingColumn = failingRef.column

	if (failingRef.qualified && failingRef.alias) {
		// Replace qualified reference: alias.old_column -> alias.new_column
		const pattern = new RegExp(`\\b${escapeRegex(failingRef.alias)}\\.${escapeRegex(missingColumn)}\\b`, "gi")
		correctedSQL = sql.replace(pattern, `${failingRef.alias}.${bestMatch.column}`)
	} else {
		// Replace unqualified reference
		const pattern = new RegExp(`\\b${escapeRegex(missingColumn)}\\b`, "gi")
		correctedSQL = sql.replace(pattern, bestMatch.column)
	}

	if (correctedSQL === sql) {
		result.rejection_reason = "replacement_pattern_not_found"
		return result
	}

	result.applied = true
	result.sql = correctedSQL
	result.rewrites.push({
		from_column: missingColumn,
		to_column: bestMatch.column,
		table: bestMatch.table,
		confidence: bestMatch.score,
	})

	return result
}

// ============================================================================
// Compact Repair Prompt Generation
// ============================================================================

/**
 * Format surgical whitelist as a compact repair prompt delta
 * Target: < 2000 characters
 */
export function formatCompactRepairPrompt(
	whitelistResult: SurgicalWhitelistResult,
	failingReference: string,
): string {
	const lines: string[] = []

	lines.push(`## Column Error: ${failingReference}`)
	lines.push("")

	// Primary table columns (compact format)
	if (whitelistResult.primaryTables.length > 0) {
		lines.push("**Valid columns (use ONLY these):**")
		for (const table of whitelistResult.primaryTables) {
			const cols = whitelistResult.tables[table] || []
			lines.push(`${table}: ${cols.join(", ")}`)
		}
		lines.push("")
	}

	// Neighbor tables (if any)
	if (whitelistResult.neighborTables.length > 0) {
		lines.push("**Related tables (JOIN if needed):**")
		for (const table of whitelistResult.neighborTables) {
			const cols = whitelistResult.tables[table] || []
			lines.push(`${table}: ${cols.join(", ")}`)
		}
		lines.push("")
	}

	// Strict instructions (minimal)
	lines.push("Use ONLY columns listed above. Do not invent columns.")

	return lines.join("\n")
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Process a 42703 error with surgical whitelist
 *
 * Returns:
 * - Corrected SQL if deterministic rewrite succeeded
 * - Repair prompt delta if rewrite failed
 * - Telemetry for exam analysis
 */
export function processSurgicalWhitelist(
	sql: string,
	errorMessage: string,
	schemaContext: SchemaContextPacket,
	config: SurgicalWhitelistConfig = SURGICAL_WHITELIST_CONFIG,
): {
	success: boolean
	correctedSQL?: string
	repairPromptDelta?: string
	whitelistResult: SurgicalWhitelistResult
	telemetry: WhitelistTelemetry
} {
	// Initialize telemetry
	const telemetry: WhitelistTelemetry = {
		whitelist_triggered: true,
		whitelist_tables_count: 0,
		whitelist_columns_total: 0,
		alias_resolution: {
			success: false,
			alias: null,
			resolved_table: null,
			ambiguity: false,
		},
		deterministic_rewrites: [],
		repair_used_whitelist: false,
	}

	// Build surgical whitelist
	const whitelistResult = buildSurgicalColumnWhitelist(sql, errorMessage, schemaContext, config)

	// Update telemetry
	telemetry.whitelist_tables_count = Object.keys(whitelistResult.tables).length
	telemetry.whitelist_columns_total = Object.values(whitelistResult.tables).reduce((sum, cols) => sum + cols.length, 0)
	telemetry.alias_resolution = {
		success: !!whitelistResult.debug.alias_resolved,
		alias: whitelistResult.debug.failing_reference?.split(".")[0] || null,
		resolved_table: whitelistResult.debug.alias_resolved,
		ambiguity: whitelistResult.debug.alias_resolution_method?.includes("ambiguous") || false,
		all_from_join_tables: whitelistResult.primaryTables.length > 1 ? whitelistResult.primaryTables : undefined,
	}

	// Attempt deterministic rewrite
	const rewriteResult = attemptDeterministicRewrite(sql, errorMessage, whitelistResult.tables, config)

	telemetry.deterministic_rewrites = rewriteResult.rewrites.map(r => ({
		from_column: r.from_column,
		to_column: r.to_column,
		table: r.table,
		confidence: r.confidence,
		applied: true,
	}))

	if (!rewriteResult.applied && rewriteResult.candidates && rewriteResult.candidates.length > 0) {
		telemetry.deterministic_rewrites.push({
			from_column: rewriteResult.candidates[0].column,
			to_column: rewriteResult.candidates[0].column,
			table: rewriteResult.candidates[0].table,
			confidence: rewriteResult.candidates[0].score,
			applied: false,
			rejection_reason: rewriteResult.rejection_reason,
		})
	}

	if (rewriteResult.applied) {
		return {
			success: true,
			correctedSQL: rewriteResult.sql,
			whitelistResult,
			telemetry,
		}
	}

	// Generate compact repair prompt
	const failingRef = whitelistResult.debug.failing_reference || "unknown column"
	const repairPromptDelta = formatCompactRepairPrompt(whitelistResult, failingRef)

	telemetry.repair_used_whitelist = true
	telemetry.whitelist_prompt_size = repairPromptDelta.length

	return {
		success: false,
		repairPromptDelta,
		whitelistResult,
		telemetry,
	}
}

// ============================================================================
// Exports for Testing
// ============================================================================

// Additional helper exports for testing (main functions already exported above)
export {
	findColumnMatches,
	levenshteinDistance,
}
