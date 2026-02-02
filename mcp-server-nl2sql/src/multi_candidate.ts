/**
 * Multi-Candidate SQL Generation Module
 *
 * Generates K SQL candidates per question, gates them with fast validation,
 * and selects the best candidate for execution.
 *
 * Design Goals:
 * - Generalizable: Works across any schema
 * - Configurable: K, timeouts, scoring weights all configurable
 * - Low latency: Parallel EXPLAIN where possible, strict time budgets
 *
 * Scoring is deterministic (no LLM judge):
 * - Hard rejects: fails structural validator, violates allowlist, non-SELECT, multi-statement
 * - Big penalty: EXPLAIN fails
 * - Penalties: lint issues count, pre-exec validation issues count
 * - Bonuses: matches query-shape heuristics
 */

import { Pool, PoolClient } from "pg"
import { validateSQL, ValidationResult } from "./sql_validator.js"
import { lintSQL, LintResult, LintIssue } from "./sql_lint.js"
import { SchemaContextPacket } from "./schema_types.js"
import { REPAIR_CONFIG } from "./config.js"

// ============================================================================
// Configuration
// ============================================================================

export interface MultiCandidateConfig {
	/** Enable multi-candidate generation */
	enabled: boolean

	/** Default number of candidates to generate */
	k_default: number

	/** Candidates for easy questions (simple lookups) */
	k_easy: number

	/** Candidates for hard questions (complex joins) */
	k_hard: number

	/** Max candidates to run EXPLAIN on (default = k) */
	max_candidates_to_explain: number

	/** Max candidates to execute (default 1; optionally 2 for hard) */
	max_candidates_to_execute: number

	/** Generation mode: single LLM call with delimited output vs parallel calls */
	generation_mode: "single_call_multi_sql" | "parallel_calls"

	/** Per-query time budget in ms */
	per_query_time_budget_ms: number

	/** EXPLAIN timeout per candidate in ms */
	explain_timeout_ms: number

	/** Execute timeout (uses existing statement_timeout if not specified) */
	execute_timeout_ms: number | null

	/** Delimiter for multi-SQL output */
	sql_delimiter: string

	/** Scoring weights */
	scoring: {
		/** Base score for a valid candidate */
		base_score: number

		/** Penalty per lint error */
		lint_error_penalty: number

		/** Penalty per lint warning */
		lint_warning_penalty: number

		/** Penalty if EXPLAIN fails */
		explain_fail_penalty: number

		/** Penalty per pre-exec validation error */
		pre_exec_error_penalty: number

		/** Bonus for matching GROUP BY heuristic */
		group_by_bonus: number

		/** Bonus for matching ORDER BY + LIMIT heuristic */
		order_limit_bonus: number

		/** Bonus for matching DISTINCT heuristic */
		distinct_bonus: number

		/** Bonus for matching JOIN heuristic */
		join_bonus: number
	}

	/** Question patterns for difficulty classification */
	difficulty_patterns: {
		easy: RegExp[]
		hard: RegExp[]
	}
}

export const MULTI_CANDIDATE_CONFIG: MultiCandidateConfig = {
	enabled: process.env.MULTI_CANDIDATE_ENABLED !== "false",
	k_default: parseInt(process.env.MULTI_CANDIDATE_K || "4", 10),
	k_easy: parseInt(process.env.MULTI_CANDIDATE_K_EASY || "2", 10),
	k_hard: parseInt(process.env.MULTI_CANDIDATE_K_HARD || "6", 10),
	max_candidates_to_explain: parseInt(process.env.MULTI_CANDIDATE_MAX_EXPLAIN || "4", 10),
	max_candidates_to_execute: parseInt(process.env.MULTI_CANDIDATE_MAX_EXECUTE || "1", 10),
	generation_mode: "single_call_multi_sql",
	per_query_time_budget_ms: parseInt(process.env.MULTI_CANDIDATE_TIME_BUDGET_MS || "10000", 10),
	explain_timeout_ms: parseInt(process.env.MULTI_CANDIDATE_EXPLAIN_TIMEOUT_MS || "2000", 10),
	execute_timeout_ms: null, // Use existing statement_timeout
	sql_delimiter: "---SQL_CANDIDATE---",

	scoring: {
		base_score: 100,
		lint_error_penalty: 25,
		lint_warning_penalty: 5,
		explain_fail_penalty: 50,
		pre_exec_error_penalty: 20,
		group_by_bonus: 10,
		order_limit_bonus: 10,
		distinct_bonus: 5,
		join_bonus: 5,
	},

	difficulty_patterns: {
		easy: [
			/^(what|which|who)\s+is\b/i,
			/^show\s+(me\s+)?the\s+\w+$/i,
			/^list\s+(all\s+)?\w+$/i,
			/\bcount\b.*\bwhere\b.*=\s*['"]/i,
		],
		hard: [
			/\b(per|by|for each)\s+(department|employee|project|customer|year|month)\b/i,
			/\b(compare|comparing|difference|between)\b/i,
			/\b(trend|growth|change|over time)\b/i,
			/\b(ratio|percentage|percent|proportion)\b/i,
			/\b(and|or)\b.*\b(and|or)\b/i, // Multiple conditions
			/\b(top|bottom|highest|lowest)\s+\d+\b/i,
			/\bjoin\b.*\bjoin\b/i, // Multiple joins mentioned
		],
	},
}

// ============================================================================
// Types
// ============================================================================

export interface SQLCandidate {
	/** The SQL query */
	sql: string

	/** Index in the candidate list (1-based for logging) */
	index: number

	/** Score (higher is better) */
	score: number

	/** Score breakdown for debugging */
	scoreBreakdown: {
		base: number
		lintErrors: number
		lintWarnings: number
		explainResult: "pass" | "fail" | "skipped"
		explainPenalty: number
		preExecErrors: number
		heuristicBonuses: string[]
		totalBonus: number
		finalScore: number
	}

	/** Validation results */
	structuralValid: boolean
	structuralIssues: string[]

	/** Lint results */
	lintResult: LintResult | null

	/** EXPLAIN results */
	explainPassed: boolean | null
	explainError: string | null
	explainSqlstate: string | null

	/** Whether candidate is rejected (cannot execute) */
	rejected: boolean
	rejectionReason: string | null
}

export interface MultiCandidateResult {
	/** Selected candidate for execution */
	selectedCandidate: SQLCandidate | null

	/** All candidates with scores */
	allCandidates: SQLCandidate[]

	/** Number of candidates generated */
	candidatesGenerated: number

	/** Number of candidates that passed EXPLAIN */
	candidatesPassedExplain: number

	/** Number of candidates rejected (structural/lint failures) */
	candidatesRejected: number

	/** K value used */
	kUsed: number

	/** Question difficulty classification */
	difficulty: "easy" | "medium" | "hard"

	/** Total time spent on candidate evaluation (ms) */
	evaluationTimeMs: number

	/** Whether we ran out of time budget */
	timedOut: boolean
}

export interface CandidateExamLog {
	candidates_generated: number
	k_used: number
	difficulty: string
	candidate_scores: Array<{
		index: number
		score: number
		explain_result: string
		lint_errors: number
		rejected: boolean
		rejection_reason: string | null
	}>
	selected_candidate_index: number | null
	evaluation_time_ms: number
	timed_out: boolean
}

// ============================================================================
// Multi-Candidate Prompt Template
// ============================================================================

/**
 * Prompt template for generating K SQL candidates in a single LLM call.
 *
 * The LLM is instructed to generate K different valid SQL approaches,
 * separated by a strict delimiter.
 */
export function buildMultiCandidatePrompt(
	basePrompt: string,
	k: number,
	delimiter: string = MULTI_CANDIDATE_CONFIG.sql_delimiter,
): string {
	const multiCandidateInstructions = `
## Multi-Candidate SQL Generation

Generate exactly ${k} different valid SQL queries that answer the question.
Each query should be a complete, executable SELECT statement.
Separate each SQL candidate with exactly this delimiter on its own line:
${delimiter}

**Variation Guidelines:**
- Candidate 1: Most straightforward approach (simple JOINs, minimal subqueries)
- Candidate 2: Alternative table ordering or JOIN strategy
${k >= 3 ? "- Candidate 3: Different column selection or grouping approach" : ""}
${k >= 4 ? "- Candidate 4: Alternative aggregation or filtering strategy" : ""}
${k >= 5 ? "- Candidate 5: More complex but potentially more accurate approach" : ""}
${k >= 6 ? "- Candidate 6: Edge case handling (NULLs, empty results)" : ""}

**Rules for each candidate:**
- Must be a valid PostgreSQL SELECT statement
- Must use only tables/columns from the schema
- Must return data that answers the question
- Each candidate should be DIFFERENT (not just whitespace/formatting changes)

**Output Format Example:**
\`\`\`sql
SELECT a, b FROM table1 WHERE c = 'value';
${delimiter}
SELECT x, y FROM table2 JOIN table1 ON ... WHERE z = 'value';
${delimiter}
SELECT ... (more candidates)
\`\`\`

Generate ${k} SQL candidates now:
`

	// Insert multi-candidate instructions before "## SQL Query" or at the end
	const sqlQueryMarker = "## SQL Query"
	if (basePrompt.includes(sqlQueryMarker)) {
		return basePrompt.replace(sqlQueryMarker, multiCandidateInstructions + "\n\n" + sqlQueryMarker)
	} else {
		return basePrompt + "\n\n" + multiCandidateInstructions
	}
}

// ============================================================================
// Candidate Parser
// ============================================================================

/**
 * Parse multiple SQL candidates from LLM output.
 *
 * Handles various output formats:
 * - Delimiter-separated SQL statements
 * - SQL in code blocks
 * - Mixed formats
 *
 * @param rawOutput - Raw LLM output containing multiple SQL statements
 * @param delimiter - Delimiter used to separate candidates
 * @param maxCandidates - Maximum candidates to return
 * @returns Array of SQL candidate strings
 */
export function parseCandidates(
	rawOutput: string,
	delimiter: string = MULTI_CANDIDATE_CONFIG.sql_delimiter,
	maxCandidates: number = MULTI_CANDIDATE_CONFIG.k_default,
): string[] {
	const candidates: string[] = []

	// Normalize line endings
	let output = rawOutput.replace(/\r\n/g, "\n").trim()

	// Split by delimiter
	const parts = output.split(delimiter)

	for (const part of parts) {
		if (candidates.length >= maxCandidates) break

		let sql = extractSQLFromBlock(part.trim())

		// Skip empty or obviously invalid entries
		if (!sql || sql.length < 10) continue

		// Skip if it doesn't look like SQL
		if (!sql.toUpperCase().includes("SELECT")) continue

		// Clean up the SQL
		sql = cleanSQL(sql)

		if (sql) {
			candidates.push(sql)
		}
	}

	// If delimiter parsing failed, try to extract from code blocks
	if (candidates.length === 0) {
		const codeBlockPattern = /```(?:sql)?\s*([\s\S]*?)```/gi
		let match
		while ((match = codeBlockPattern.exec(output)) !== null) {
			if (candidates.length >= maxCandidates) break

			let sql = match[1].trim()
			sql = cleanSQL(sql)

			if (sql && sql.toUpperCase().includes("SELECT")) {
				candidates.push(sql)
			}
		}
	}

	// Last resort: treat entire output as single candidate
	if (candidates.length === 0) {
		const sql = cleanSQL(output)
		if (sql && sql.toUpperCase().includes("SELECT")) {
			candidates.push(sql)
		}
	}

	return candidates
}

/**
 * Extract SQL from a code block or raw text
 */
function extractSQLFromBlock(block: string): string {
	// Remove markdown code blocks
	let sql = block.replace(/```(?:sql)?\s*/gi, "").replace(/```/g, "")

	// Remove leading/trailing whitespace
	sql = sql.trim()

	return sql
}

/**
 * Clean and normalize SQL
 */
function cleanSQL(sql: string): string {
	// Remove leading/trailing whitespace
	sql = sql.trim()

	// Remove trailing semicolons (we'll add them if needed)
	sql = sql.replace(/;\s*$/, "")

	// Remove SQL comments at the start
	sql = sql.replace(/^--.*\n/gm, "")

	// Normalize whitespace
	sql = sql.replace(/\s+/g, " ").trim()

	// Skip if too short
	if (sql.length < 10) return ""

	// Ensure starts with SELECT
	if (!sql.toUpperCase().startsWith("SELECT")) {
		// Try to find SELECT in the output
		const selectIndex = sql.toUpperCase().indexOf("SELECT")
		if (selectIndex > 0) {
			sql = sql.substring(selectIndex)
		} else {
			return ""
		}
	}

	return sql
}

// ============================================================================
// Candidate Scoring
// ============================================================================

/**
 * Score a SQL candidate based on deterministic criteria.
 *
 * Scoring is schema-agnostic and based on:
 * - Structural validity
 * - Lint results
 * - EXPLAIN success/failure
 * - Query shape heuristics matching the question
 *
 * @param sql - SQL candidate
 * @param question - Original question (for heuristic matching)
 * @param lintResult - Lint analysis result
 * @param explainPassed - Whether EXPLAIN succeeded
 * @param config - Scoring configuration
 * @returns Score and breakdown
 */
export function scoreCandidate(
	sql: string,
	question: string,
	lintResult: LintResult | null,
	explainPassed: boolean | null,
	config: MultiCandidateConfig["scoring"] = MULTI_CANDIDATE_CONFIG.scoring,
): SQLCandidate["scoreBreakdown"] {
	let score = config.base_score
	const heuristicBonuses: string[] = []
	let totalBonus = 0

	// Lint penalties
	let lintErrors = 0
	let lintWarnings = 0
	if (lintResult) {
		lintErrors = lintResult.issues.filter((i) => i.severity === "error").length
		lintWarnings = lintResult.issues.filter((i) => i.severity === "warn").length
		score -= lintErrors * config.lint_error_penalty
		score -= lintWarnings * config.lint_warning_penalty
	}

	// EXPLAIN penalty
	let explainResult: "pass" | "fail" | "skipped" = "skipped"
	let explainPenalty = 0
	if (explainPassed === false) {
		explainResult = "fail"
		explainPenalty = config.explain_fail_penalty
		score -= explainPenalty
	} else if (explainPassed === true) {
		explainResult = "pass"
	}

	// Query shape heuristics
	const upperSQL = sql.toUpperCase()
	const lowerQuestion = question.toLowerCase()

	// GROUP BY bonus for "by/per/for each" questions
	if (/\b(by|per|for each|group)\b/i.test(lowerQuestion) && upperSQL.includes("GROUP BY")) {
		totalBonus += config.group_by_bonus
		heuristicBonuses.push("GROUP_BY")
	}

	// ORDER BY + LIMIT bonus for "top/highest/lowest" questions
	if (
		/\b(top|highest|lowest|most|least|best|worst)\b/i.test(lowerQuestion) &&
		upperSQL.includes("ORDER BY") &&
		upperSQL.includes("LIMIT")
	) {
		totalBonus += config.order_limit_bonus
		heuristicBonuses.push("ORDER_LIMIT")
	}

	// DISTINCT bonus for "distinct/unique/different" questions
	if (/\b(distinct|unique|different)\b/i.test(lowerQuestion) && upperSQL.includes("DISTINCT")) {
		totalBonus += config.distinct_bonus
		heuristicBonuses.push("DISTINCT")
	}

	// JOIN bonus when question implies relationships
	if (
		/\b(with|and|related|associated|for|by)\b/i.test(lowerQuestion) &&
		/\b(their|its|whose)\b/i.test(lowerQuestion) &&
		upperSQL.includes("JOIN")
	) {
		totalBonus += config.join_bonus
		heuristicBonuses.push("JOIN")
	}

	score += totalBonus
	const finalScore = Math.max(0, score)

	return {
		base: config.base_score,
		lintErrors,
		lintWarnings,
		explainResult,
		explainPenalty,
		preExecErrors: 0,
		heuristicBonuses,
		totalBonus,
		finalScore,
	}
}

// ============================================================================
// Difficulty Classification
// ============================================================================

/**
 * Classify question difficulty to determine K value.
 */
export function classifyDifficulty(
	question: string,
	schemaContext: SchemaContextPacket | null,
): "easy" | "medium" | "hard" {
	const patterns = MULTI_CANDIDATE_CONFIG.difficulty_patterns

	// Check for easy patterns
	for (const pattern of patterns.easy) {
		if (pattern.test(question)) {
			return "easy"
		}
	}

	// Check for hard patterns
	for (const pattern of patterns.hard) {
		if (pattern.test(question)) {
			return "hard"
		}
	}

	// Use table count as a heuristic
	if (schemaContext) {
		const tableCount = schemaContext.tables.length
		if (tableCount >= 5) return "hard"
		if (tableCount <= 2) return "easy"
	}

	return "medium"
}

/**
 * Get K value based on difficulty
 */
export function getKForDifficulty(difficulty: "easy" | "medium" | "hard"): number {
	switch (difficulty) {
		case "easy":
			return MULTI_CANDIDATE_CONFIG.k_easy
		case "hard":
			return MULTI_CANDIDATE_CONFIG.k_hard
		default:
			return MULTI_CANDIDATE_CONFIG.k_default
	}
}

// ============================================================================
// Candidate Gating (Structural + Lint + EXPLAIN)
// ============================================================================

/**
 * Run structural validation on a candidate
 */
export function runStructuralValidation(
	sql: string,
	allowedTables: string[],
	maxLimit: number,
	requireLimit: boolean,
): { valid: boolean; issues: string[] } {
	const result = validateSQL(sql, {
		allowedTables,
		maxLimit,
		requireLimit,
	})

	const issues: string[] = []

	// Check for fail-fast issues
	if (result.issues) {
		for (const issue of result.issues) {
			if (issue.action === "fail_fast") {
				issues.push(`[FAIL_FAST] ${issue.code}: ${issue.message}`)
			} else if (issue.severity === "error") {
				issues.push(`[ERROR] ${issue.code}: ${issue.message}`)
			}
		}
	}

	// Additional checks
	const upperSQL = sql.toUpperCase().trim()

	// Must start with SELECT
	if (!upperSQL.startsWith("SELECT")) {
		issues.push("[FAIL_FAST] NOT_SELECT: Query must start with SELECT")
	}

	// No multi-statement
	if (sql.includes(";") && sql.indexOf(";") < sql.length - 1) {
		issues.push("[FAIL_FAST] MULTI_STATEMENT: Only single statement allowed")
	}

	return {
		valid: issues.length === 0,
		issues,
	}
}

/**
 * Run EXPLAIN on a candidate with timeout
 */
export async function runExplain(
	sql: string,
	pool: Pool,
	timeoutMs: number = MULTI_CANDIDATE_CONFIG.explain_timeout_ms,
): Promise<{ passed: boolean; error: string | null; sqlstate: string | null }> {
	let client: PoolClient | null = null

	try {
		client = await pool.connect()
		await client.query(`SET statement_timeout = ${timeoutMs}`)

		await client.query(`EXPLAIN (FORMAT JSON) ${sql}`)

		return { passed: true, error: null, sqlstate: null }
	} catch (error) {
		const pgError = error as { code?: string; message?: string }
		return {
			passed: false,
			error: pgError.message || String(error),
			sqlstate: pgError.code || "UNKNOWN",
		}
	} finally {
		if (client) {
			client.release()
		}
	}
}

// ============================================================================
// Main Orchestration
// ============================================================================

/**
 * Evaluate multiple SQL candidates and select the best one.
 *
 * Flow:
 * 1. Parse candidates from LLM output
 * 2. Run structural validation (fail-fast rejects)
 * 3. Run lint analysis
 * 4. Run EXPLAIN on non-rejected candidates (parallel with timeout)
 * 5. Score all candidates
 * 6. Select best candidate
 *
 * @param rawOutput - Raw LLM output containing multiple SQL statements
 * @param question - Original question
 * @param allowedTables - Tables allowed in the query
 * @param pool - Database connection pool
 * @param schemaContext - Schema context (optional)
 * @param maxLimit - Max LIMIT value
 * @param requireLimit - Whether LIMIT is required
 * @param logger - Logger instance
 * @returns Best candidate and evaluation results
 */
export async function evaluateCandidates(
	rawOutput: string,
	question: string,
	allowedTables: string[],
	pool: Pool,
	schemaContext: SchemaContextPacket | null,
	maxLimit: number,
	requireLimit: boolean,
	logger: { info: Function; warn: Function; debug: Function },
): Promise<MultiCandidateResult> {
	const startTime = Date.now()
	const config = MULTI_CANDIDATE_CONFIG

	// Classify difficulty and get K
	const difficulty = classifyDifficulty(question, schemaContext)
	const kUsed = getKForDifficulty(difficulty)

	// Parse candidates
	const sqlStrings = parseCandidates(rawOutput, config.sql_delimiter, kUsed)

	logger.info("Multi-candidate: parsed candidates", {
		count: sqlStrings.length,
		difficulty,
		k_used: kUsed,
	})

	const candidates: SQLCandidate[] = []
	let candidatesRejected = 0

	// Step 1: Structural validation and lint analysis
	for (let i = 0; i < sqlStrings.length; i++) {
		const sql = sqlStrings[i]

		// Structural validation
		const structural = runStructuralValidation(sql, allowedTables, maxLimit, requireLimit)

		// Lint analysis
		const lintResult = lintSQL(sql)

		const candidate: SQLCandidate = {
			sql,
			index: i + 1,
			score: 0,
			scoreBreakdown: {
				base: config.scoring.base_score,
				lintErrors: 0,
				lintWarnings: 0,
				explainResult: "skipped",
				explainPenalty: 0,
				preExecErrors: 0,
				heuristicBonuses: [],
				totalBonus: 0,
				finalScore: 0,
			},
			structuralValid: structural.valid,
			structuralIssues: structural.issues,
			lintResult,
			explainPassed: null,
			explainError: null,
			explainSqlstate: null,
			rejected: false,
			rejectionReason: null,
		}

		// Hard reject if structural validation failed with fail-fast issues
		const hasFailFast = structural.issues.some((i) => i.includes("[FAIL_FAST]"))
		if (hasFailFast) {
			candidate.rejected = true
			candidate.rejectionReason = structural.issues.find((i) => i.includes("[FAIL_FAST]")) || "Structural validation failed"
			candidatesRejected++
		}

		// Hard reject if lint has errors
		if (lintResult.hasErrors) {
			candidate.rejected = true
			candidate.rejectionReason = `Lint errors: ${lintResult.issues
				.filter((i) => i.severity === "error")
				.map((i) => i.code)
				.join(", ")}`
			candidatesRejected++
		}

		candidates.push(candidate)
	}

	// Step 2: Run EXPLAIN on non-rejected candidates (in parallel)
	const nonRejected = candidates.filter((c) => !c.rejected)
	const toExplain = nonRejected.slice(0, config.max_candidates_to_explain)

	logger.debug("Multi-candidate: running EXPLAIN", {
		non_rejected: nonRejected.length,
		to_explain: toExplain.length,
	})

	// Check time budget
	const elapsed = Date.now() - startTime
	const remainingBudget = config.per_query_time_budget_ms - elapsed

	if (remainingBudget > config.explain_timeout_ms && toExplain.length > 0) {
		// Run EXPLAIN in parallel with individual timeouts
		const explainPromises = toExplain.map((c) =>
			runExplain(c.sql, pool, config.explain_timeout_ms).then((result) => ({
				candidate: c,
				result,
			})),
		)

		// Wait with overall timeout
		const results = await Promise.race([
			Promise.all(explainPromises),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingBudget)),
		])

		if (results) {
			for (const { candidate, result } of results) {
				candidate.explainPassed = result.passed
				candidate.explainError = result.error
				candidate.explainSqlstate = result.sqlstate

				if (!result.passed) {
					// Don't reject, just penalize in scoring
					logger.debug("Multi-candidate: EXPLAIN failed", {
						index: candidate.index,
						sqlstate: result.sqlstate,
						error: result.error?.substring(0, 100),
					})
				}
			}
		}
	}

	// Step 3: Score all candidates
	let candidatesPassedExplain = 0
	for (const candidate of candidates) {
		if (candidate.rejected) continue

		const breakdown = scoreCandidate(
			candidate.sql,
			question,
			candidate.lintResult,
			candidate.explainPassed,
			config.scoring,
		)

		candidate.score = breakdown.finalScore
		candidate.scoreBreakdown = breakdown

		if (candidate.explainPassed === true) {
			candidatesPassedExplain++
		}
	}

	// Step 4: Sort by score and select best
	candidates.sort((a, b) => {
		// Non-rejected first
		if (a.rejected !== b.rejected) return a.rejected ? 1 : -1
		// Then by score
		return b.score - a.score
	})

	// Select best candidate
	let selectedCandidate: SQLCandidate | null = null

	// Prefer candidates that passed EXPLAIN
	const passedExplain = candidates.filter((c) => !c.rejected && c.explainPassed === true)
	if (passedExplain.length > 0) {
		selectedCandidate = passedExplain[0]
	} else {
		// Fall back to best non-rejected candidate (will need repair)
		const nonRejectedFinal = candidates.filter((c) => !c.rejected)
		if (nonRejectedFinal.length > 0) {
			selectedCandidate = nonRejectedFinal[0]
		}
	}

	const evaluationTimeMs = Date.now() - startTime

	logger.info("Multi-candidate: evaluation complete", {
		total_candidates: candidates.length,
		rejected: candidatesRejected,
		passed_explain: candidatesPassedExplain,
		selected_index: selectedCandidate?.index || null,
		selected_score: selectedCandidate?.score || null,
		evaluation_time_ms: evaluationTimeMs,
	})

	return {
		selectedCandidate,
		allCandidates: candidates,
		candidatesGenerated: candidates.length,
		candidatesPassedExplain,
		candidatesRejected,
		kUsed,
		difficulty,
		evaluationTimeMs,
		timedOut: evaluationTimeMs > config.per_query_time_budget_ms,
	}
}

/**
 * Build exam log entry for multi-candidate evaluation
 */
export function buildCandidateExamLog(result: MultiCandidateResult): CandidateExamLog {
	return {
		candidates_generated: result.candidatesGenerated,
		k_used: result.kUsed,
		difficulty: result.difficulty,
		candidate_scores: result.allCandidates.map((c) => ({
			index: c.index,
			score: c.score,
			explain_result: c.explainPassed === true ? "pass" : c.explainPassed === false ? "fail" : "skipped",
			lint_errors: c.scoreBreakdown.lintErrors,
			rejected: c.rejected,
			rejection_reason: c.rejectionReason,
		})),
		selected_candidate_index: result.selectedCandidate?.index || null,
		evaluation_time_ms: result.evaluationTimeMs,
		timed_out: result.timedOut,
	}
}

// ============================================================================
// Exports
// ============================================================================

export {
	MULTI_CANDIDATE_CONFIG as config,
}
