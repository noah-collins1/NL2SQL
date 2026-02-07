/**
 * Multi-Run Exam Runner with Statistical Analysis
 *
 * Runs the exam multiple times to account for LLM non-determinism,
 * then reports mean, min, max, std dev, and identifies stable vs flaky questions.
 *
 * Usage:
 *   npx tsx scripts/run_exam_multi.ts [num_runs]
 *   npx tsx scripts/run_exam_multi.ts 5  # Run 5 times
 */

import pg from "pg"
import { executeNLQuery } from "../src/nl_query_tool.js"
import fs from "fs"
import path from "path"

const { Pool } = pg

// Load test questions
const testQuestionsPath = path.join(process.cwd(), "../enterprise-erp/003_test_questions.json")
const testData = JSON.parse(fs.readFileSync(testQuestionsPath, "utf-8"))
const EXAM_QUESTIONS = testData.questions

interface ExamResult {
	id: number
	difficulty: string
	module: string
	question: string
	tables_needed: string[]
	retrieved_tables: string[]
	sql_generated: string
	success: boolean
	error_type?: string
	error_message?: string
	sqlstate?: string
	latency_ms: number
	retrieval_miss: string[]
	extra_tables: string[]
}

interface RunSummary {
	run_number: number
	success_rate: number
	successes: number
	failures: number[]
	by_difficulty: Record<string, { pass: number; fail: number }>
	by_module: Record<string, { pass: number; fail: number }>
	failure_counts: Record<string, number>
	duration_ms: number
}

interface MultiRunReport {
	num_runs: number
	timestamp: string
	statistics: {
		mean: number
		median: number
		min: number
		max: number
		std_dev: number
		range: number
	}
	question_analysis: {
		always_pass: number[]
		always_fail: number[]
		flaky: number[]
		flaky_details: Array<{
			id: number
			question: string
			pass_rate: number
			pass_count: number
			fail_count: number
		}>
	}
	runs: RunSummary[]
	recommendations: string[]
}

async function runSingleExam(pool: pg.Pool, runNumber: number, totalRuns: number): Promise<{ results: ExamResult[], summary: RunSummary }> {
	const logger = {
		info: () => {},
		debug: () => {},
		warn: () => {},
		error: (msg: string) => console.error(`[ERROR] ${msg}`),
	}

	const results: ExamResult[] = []
	const failures: number[] = []
	const failureCounts: Record<string, number> = {
		retrieval_miss: 0,
		join_path_miss: 0,
		column_miss: 0,
		value_miss: 0,
		llm_reasoning: 0,
		execution_error: 0,
		success: 0,
	}

	const byDifficulty: Record<string, { pass: number; fail: number }> = {
		easy: { pass: 0, fail: 0 },
		medium: { pass: 0, fail: 0 },
		hard: { pass: 0, fail: 0 },
	}

	const byModule: Record<string, { pass: number; fail: number }> = {}

	console.log(`\n${"─".repeat(60)}`)
	console.log(`RUN ${runNumber}/${totalRuns}`)
	console.log(`${"─".repeat(60)}`)

	const runStart = Date.now()

	for (let i = 0; i < EXAM_QUESTIONS.length; i++) {
		const q = EXAM_QUESTIONS[i]
		const startTime = Date.now()

		if (!byModule[q.module]) {
			byModule[q.module] = { pass: 0, fail: 0 }
		}

		// Progress indicator
		const progress = Math.floor((i / EXAM_QUESTIONS.length) * 20)
		const bar = "█".repeat(progress) + "░".repeat(20 - progress)
		process.stdout.write(`\r  [${bar}] ${i + 1}/${EXAM_QUESTIONS.length}`)

		try {
			const response = await executeNLQuery(
				{ question: q.question, max_rows: 10, trace: true },
				{ pool, logger }
			)

			const latency = Date.now() - startTime
			const retrieved = response.tables_used || []
			const needed = q.tables_needed || []
			const missing = needed.filter((t: string) => !retrieved.some((r: string) => r.toLowerCase() === t.toLowerCase()))
			const extra = retrieved.filter((t: string) => !needed.some((e: string) => e.toLowerCase() === t.toLowerCase()))

			const result: ExamResult = {
				id: q.id,
				difficulty: q.difficulty,
				module: q.module,
				question: q.question,
				tables_needed: needed,
				retrieved_tables: retrieved,
				sql_generated: response.sql_generated,
				success: response.executed && !response.error,
				error_type: response.error?.type,
				error_message: response.error?.message,
				sqlstate: (response.error?.context as any)?.postgres_error?.sqlstate,
				latency_ms: latency,
				retrieval_miss: missing,
				extra_tables: extra,
			}

			results.push(result)

			if (result.success) {
				failureCounts.success++
				byDifficulty[q.difficulty].pass++
				byModule[q.module].pass++
			} else {
				failures.push(q.id)
				byDifficulty[q.difficulty].fail++
				byModule[q.module].fail++

				if (result.sqlstate === "42703") failureCounts.column_miss++
				else if (result.sqlstate === "42P01") failureCounts.join_path_miss++
				else if (result.error_message?.includes("MISSING_ENTITY") || result.error_message?.includes("HALLUCINATED")) failureCounts.value_miss++
				else if (result.sqlstate?.startsWith("42")) failureCounts.llm_reasoning++
				else if (result.error_type === "validation") failureCounts.llm_reasoning++
				else failureCounts.execution_error++
			}
		} catch (err) {
			const latency = Date.now() - startTime
			results.push({
				id: q.id,
				difficulty: q.difficulty,
				module: q.module,
				question: q.question,
				tables_needed: q.tables_needed || [],
				retrieved_tables: [],
				sql_generated: "",
				success: false,
				error_type: "execution_error",
				error_message: String(err),
				latency_ms: latency,
				retrieval_miss: q.tables_needed || [],
				extra_tables: [],
			})
			failures.push(q.id)
			failureCounts.execution_error++
			byDifficulty[q.difficulty].fail++
			byModule[q.module].fail++
		}
	}

	const duration = Date.now() - runStart
	const successRate = (failureCounts.success / EXAM_QUESTIONS.length) * 100

	console.log(`\r  [████████████████████] ${EXAM_QUESTIONS.length}/${EXAM_QUESTIONS.length} - ${successRate.toFixed(1)}% (${(duration / 1000).toFixed(1)}s)`)

	return {
		results,
		summary: {
			run_number: runNumber,
			success_rate: successRate,
			successes: failureCounts.success,
			failures: failures.sort((a, b) => a - b),
			by_difficulty: byDifficulty,
			by_module: byModule,
			failure_counts: failureCounts,
			duration_ms: duration,
		}
	}
}

function calculateStatistics(rates: number[]): MultiRunReport["statistics"] {
	const sorted = [...rates].sort((a, b) => a - b)
	const n = rates.length

	const mean = rates.reduce((a, b) => a + b, 0) / n
	const median = n % 2 === 0
		? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
		: sorted[Math.floor(n / 2)]
	const min = sorted[0]
	const max = sorted[n - 1]
	const variance = rates.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / n
	const std_dev = Math.sqrt(variance)

	return {
		mean: Math.round(mean * 10) / 10,
		median: Math.round(median * 10) / 10,
		min: Math.round(min * 10) / 10,
		max: Math.round(max * 10) / 10,
		std_dev: Math.round(std_dev * 10) / 10,
		range: Math.round((max - min) * 10) / 10,
	}
}

function analyzeQuestions(runs: RunSummary[]): MultiRunReport["question_analysis"] {
	const numRuns = runs.length
	const questionIds = EXAM_QUESTIONS.map((q: any) => q.id)

	// Count failures per question
	const failureCounts: Map<number, number> = new Map()
	for (const id of questionIds) {
		failureCounts.set(id, 0)
	}
	for (const run of runs) {
		for (const failedId of run.failures) {
			failureCounts.set(failedId, (failureCounts.get(failedId) || 0) + 1)
		}
	}

	const always_pass: number[] = []
	const always_fail: number[] = []
	const flaky: number[] = []
	const flaky_details: MultiRunReport["question_analysis"]["flaky_details"] = []

	for (const [id, failCount] of failureCounts.entries()) {
		if (failCount === 0) {
			always_pass.push(id)
		} else if (failCount === numRuns) {
			always_fail.push(id)
		} else {
			flaky.push(id)
			const question = EXAM_QUESTIONS.find((q: any) => q.id === id)
			flaky_details.push({
				id,
				question: question?.question || "Unknown",
				pass_rate: Math.round(((numRuns - failCount) / numRuns) * 100),
				pass_count: numRuns - failCount,
				fail_count: failCount,
			})
		}
	}

	// Sort flaky by pass rate (most flaky first - closest to 50%)
	flaky_details.sort((a, b) => Math.abs(50 - a.pass_rate) - Math.abs(50 - b.pass_rate))

	return {
		always_pass: always_pass.sort((a, b) => a - b),
		always_fail: always_fail.sort((a, b) => a - b),
		flaky: flaky.sort((a, b) => a - b),
		flaky_details,
	}
}

function generateRecommendations(stats: MultiRunReport["statistics"], analysis: MultiRunReport["question_analysis"]): string[] {
	const recommendations: string[] = []

	if (stats.std_dev > 5) {
		recommendations.push(`High variance (±${stats.std_dev}%) - consider investigating flaky questions`)
	}

	if (analysis.always_fail.length > 10) {
		recommendations.push(`${analysis.always_fail.length} questions always fail - these are priority fixes`)
	}

	if (analysis.flaky.length > 5) {
		recommendations.push(`${analysis.flaky.length} flaky questions - borderline cases that flip between runs`)
	}

	if (stats.mean < 70) {
		recommendations.push(`Mean success rate below 70% - significant improvements needed`)
	} else if (stats.mean >= 75) {
		recommendations.push(`Mean success rate ≥75% - system performing well`)
	}

	return recommendations
}

async function runMultiExam(numRuns: number = 3) {
	const connectionString = process.env.DATABASE_URL || "postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp"
	const pool = new Pool({ connectionString })

	console.log("\n" + "═".repeat(60))
	console.log("MULTI-RUN EXAM WITH STATISTICAL ANALYSIS")
	console.log("═".repeat(60))
	console.log(`\nRuns: ${numRuns}`)
	console.log(`Questions: ${EXAM_QUESTIONS.length}`)
	console.log(`Started: ${new Date().toISOString()}`)

	const allRuns: RunSummary[] = []
	const allResults: ExamResult[][] = []

	for (let i = 1; i <= numRuns; i++) {
		const { results, summary } = await runSingleExam(pool, i, numRuns)
		allRuns.push(summary)
		allResults.push(results)
	}

	// Calculate statistics
	const rates = allRuns.map(r => r.success_rate)
	const stats = calculateStatistics(rates)
	const analysis = analyzeQuestions(allRuns)
	const recommendations = generateRecommendations(stats, analysis)

	// Build report
	const report: MultiRunReport = {
		num_runs: numRuns,
		timestamp: new Date().toISOString(),
		statistics: stats,
		question_analysis: analysis,
		runs: allRuns,
		recommendations,
	}

	// Print summary
	console.log("\n" + "═".repeat(60))
	console.log("STATISTICAL SUMMARY")
	console.log("═".repeat(60))

	console.log(`\n  Success Rate: ${stats.mean}% ± ${stats.std_dev}%`)
	console.log(`  Range: ${stats.min}% - ${stats.max}% (${stats.range}% spread)`)
	console.log(`  Median: ${stats.median}%`)

	console.log("\n" + "─".repeat(60))
	console.log("QUESTION STABILITY ANALYSIS")
	console.log("─".repeat(60))

	console.log(`\n  Always Pass:  ${analysis.always_pass.length} questions`)
	console.log(`  Always Fail:  ${analysis.always_fail.length} questions`)
	console.log(`  Flaky:        ${analysis.flaky.length} questions`)

	if (analysis.always_fail.length > 0) {
		console.log(`\n  Always Fail IDs: ${analysis.always_fail.join(", ")}`)
	}

	if (analysis.flaky_details.length > 0) {
		console.log(`\n  Flaky Questions (most unstable first):`)
		for (const f of analysis.flaky_details.slice(0, 10)) {
			const passBar = "●".repeat(f.pass_count) + "○".repeat(f.fail_count)
			console.log(`    Q${f.id}: ${passBar} (${f.pass_rate}% pass)`)
		}
	}

	console.log("\n" + "─".repeat(60))
	console.log("PER-RUN BREAKDOWN")
	console.log("─".repeat(60))

	for (const run of allRuns) {
		const e = run.by_difficulty.easy
		const m = run.by_difficulty.medium
		const h = run.by_difficulty.hard
		console.log(`\n  Run ${run.run_number}: ${run.success_rate.toFixed(1)}%  E:${e.pass}/${e.pass + e.fail} M:${m.pass}/${m.pass + m.fail} H:${h.pass}/${h.pass + h.fail}`)
	}

	if (recommendations.length > 0) {
		console.log("\n" + "─".repeat(60))
		console.log("RECOMMENDATIONS")
		console.log("─".repeat(60))
		for (const rec of recommendations) {
			console.log(`\n  → ${rec}`)
		}
	}

	// Save report
	const reportFile = `./exam_logs/exam_multi_${new Date().toISOString().split("T")[0]}.json`
	try {
		if (!fs.existsSync("./exam_logs")) {
			fs.mkdirSync("./exam_logs", { recursive: true })
		}
		fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
		console.log(`\n\nReport saved: ${reportFile}`)
	} catch (err) {
		console.error("Failed to write report:", err)
	}

	console.log("\n" + "═".repeat(60))

	await pool.end()

	return report
}

// Main
const numRuns = parseInt(process.argv[2] || "3", 10)
runMultiExam(numRuns).catch(console.error)
