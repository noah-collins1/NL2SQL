/**
 * Exam Runner for Schema RAG V2
 *
 * Runs the 60-question Enterprise ERP test suite through the full NL2SQL pipeline.
 *
 * Usage:
 *   EXAM_MODE=true npx tsx scripts/run_exam.ts
 */

import pg from "pg"
import { executeNLQuery } from "../src/nl_query_tool.js"
import fs from "fs"
import path from "path"

const { Pool } = pg

// Load test questions from JSON file
const testQuestionsPath = path.join(process.cwd(), "../demo/enterprise-erp/003_test_questions.json")
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
	retrieval_recall: number
	retrieval_precision: number
}

async function runExam() {
	const connectionString = process.env.DATABASE_URL || "postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp"
	const pool = new Pool({ connectionString })

	const logger = {
		info: (msg: string, data?: any) => {
			if (msg.startsWith("EXAM_RETRIEVAL") || msg.startsWith("AUDIT_LOG")) {
				return // Quiet logging
			}
			if (!msg.includes("Starting") && !msg.includes("complete")) {
				console.log(`[INFO] ${msg}`)
			}
		},
		debug: () => {},
		warn: (msg: string, data?: any) => {
			if (!msg.includes("Validation errors")) {
				console.warn(`[WARN] ${msg}`)
			}
		},
		error: (msg: string, data?: any) => console.error(`[ERROR] ${msg}`),
	}

	const results: ExamResult[] = []
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

	console.log("\n" + "=".repeat(80))
	console.log("ENTERPRISE ERP SCHEMA RAG V2 EXAM")
	console.log("=".repeat(80))
	console.log(`\nQuestions: ${EXAM_QUESTIONS.length}`)
	console.log(`Exam Mode: ${process.env.EXAM_MODE === "true"}`)
	console.log(`Difficulty: Easy=${testData.difficulty_distribution.easy}, Medium=${testData.difficulty_distribution.medium}, Hard=${testData.difficulty_distribution.hard}`)
	console.log("\n" + "-".repeat(80))

	for (let i = 0; i < EXAM_QUESTIONS.length; i++) {
		const q = EXAM_QUESTIONS[i]
		const startTime = Date.now()

		// Initialize module tracking
		if (!byModule[q.module]) {
			byModule[q.module] = { pass: 0, fail: 0 }
		}

		const qNum = `[${i + 1}/${EXAM_QUESTIONS.length}]`
		const qInfo = `${q.difficulty.toUpperCase().charAt(0)} ${q.module.padEnd(12)}`
		process.stdout.write(`${qNum} ${qInfo} ${q.question.substring(0, 45).padEnd(45)}...`)

		try {
			const response = await executeNLQuery(
				{
					question: q.question,
					max_rows: 10,
					trace: true,
				},
				{ pool, logger }
			)

			const latency = Date.now() - startTime
			const retrieved = response.tables_used || []
			const needed = q.tables_needed || []
			const missing = needed.filter((t: string) => !retrieved.some((r: string) => r.toLowerCase() === t.toLowerCase()))
			const extra = retrieved.filter((t: string) => !needed.some((e: string) => e.toLowerCase() === t.toLowerCase()))

			// Compute retrieval recall & precision
			const intersection = needed.filter((t: string) => retrieved.some((r: string) => r.toLowerCase() === t.toLowerCase()))
			const recall = needed.length > 0 ? intersection.length / needed.length : 1.0
			const precision = retrieved.length > 0 ? intersection.length / retrieved.length : 1.0

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
				retrieval_recall: recall,
				retrieval_precision: precision,
			}

			results.push(result)

			// Classify and count
			if (result.success) {
				failureCounts.success++
				byDifficulty[q.difficulty].pass++
				byModule[q.module].pass++
				console.log(` ✓ (${(latency/1000).toFixed(1)}s)`)
			} else {
				byDifficulty[q.difficulty].fail++
				byModule[q.module].fail++

				// Classify based on SQLSTATE
				if (result.sqlstate === "42703") {
					failureCounts.column_miss++
					console.log(` ✗ column_miss`)
				} else if (result.sqlstate === "42P01") {
					failureCounts.join_path_miss++
					console.log(` ✗ join_path_miss`)
				} else if (result.error_message?.includes("MISSING_ENTITY") || result.error_message?.includes("HALLUCINATED")) {
					failureCounts.value_miss++
					console.log(` ✗ value_miss`)
				} else if (result.sqlstate?.startsWith("42")) {
					failureCounts.llm_reasoning++
					console.log(` ✗ llm_reasoning [${result.sqlstate}]`)
				} else if (result.error_type === "validation") {
					failureCounts.llm_reasoning++
					console.log(` ✗ validation`)
				} else {
					failureCounts.execution_error++
					console.log(` ✗ error`)
				}
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
				retrieval_recall: 0,
				retrieval_precision: 1.0,
			})
			failureCounts.execution_error++
			byDifficulty[q.difficulty].fail++
			byModule[q.module].fail++
			console.log(` ✗ exception`)
		}
	}

	// Summary
	console.log("\n" + "=".repeat(80))
	console.log("EXAM SUMMARY")
	console.log("=".repeat(80))

	const total = EXAM_QUESTIONS.length
	const successRate = ((failureCounts.success / total) * 100).toFixed(1)

	console.log(`\nTotal Questions: ${total}`)
	console.log(`Success Rate: ${successRate}% (${failureCounts.success}/${total})`)

	console.log("\n--- By Difficulty ---")
	for (const [diff, counts] of Object.entries(byDifficulty)) {
		const rate = ((counts.pass / (counts.pass + counts.fail)) * 100).toFixed(1)
		console.log(`  ${diff.padEnd(8)}: ${rate}% (${counts.pass}/${counts.pass + counts.fail})`)
	}

	console.log("\n--- By Module ---")
	for (const [mod, counts] of Object.entries(byModule).sort((a, b) => b[1].pass - a[1].pass)) {
		const rate = ((counts.pass / (counts.pass + counts.fail)) * 100).toFixed(1)
		console.log(`  ${mod.padEnd(12)}: ${rate}% (${counts.pass}/${counts.pass + counts.fail})`)
	}

	console.log("\n--- Failure Breakdown ---")
	console.log(`  success:         ${failureCounts.success} (${((failureCounts.success / total) * 100).toFixed(1)}%)`)
	console.log(`  column_miss:     ${failureCounts.column_miss} (${((failureCounts.column_miss / total) * 100).toFixed(1)}%)`)
	console.log(`  llm_reasoning:   ${failureCounts.llm_reasoning} (${((failureCounts.llm_reasoning / total) * 100).toFixed(1)}%)`)
	console.log(`  join_path_miss:  ${failureCounts.join_path_miss} (${((failureCounts.join_path_miss / total) * 100).toFixed(1)}%)`)
	console.log(`  value_miss:      ${failureCounts.value_miss} (${((failureCounts.value_miss / total) * 100).toFixed(1)}%)`)
	console.log(`  execution_error: ${failureCounts.execution_error} (${((failureCounts.execution_error / total) * 100).toFixed(1)}%)`)

	// Retrieval quality metrics
	const meanRecall = results.reduce((sum, r) => sum + r.retrieval_recall, 0) / total
	const meanPrecision = results.reduce((sum, r) => sum + r.retrieval_precision, 0) / total
	const perfectRecallCount = results.filter(r => r.retrieval_recall === 1.0).length
	const questionsWithMisses = results.filter(r => r.retrieval_recall < 1.0).map(r => ({
		id: r.id,
		question: r.question.substring(0, 50),
		recall: r.retrieval_recall,
		missing: r.retrieval_miss,
	}))

	console.log("\n--- Retrieval Quality ---")
	console.log(`  Mean Recall:    ${(meanRecall * 100).toFixed(1)}% (${perfectRecallCount}/${total} questions with perfect recall)`)
	console.log(`  Mean Precision: ${(meanPrecision * 100).toFixed(1)}%`)
	if (questionsWithMisses.length > 0) {
		console.log(`  Retrieval Misses: ${questionsWithMisses.length} questions missing >=1 table`)
		for (const miss of questionsWithMisses) {
			console.log(`    Q${miss.id}: recall=${(miss.recall * 100).toFixed(0)}% missing=[${miss.missing.join(", ")}]`)
		}
	}

	// Write detailed results
	const resultsFile = `./exam_logs/exam_results_full_${new Date().toISOString().split("T")[0]}.json`
	try {
		if (!fs.existsSync("./exam_logs")) {
			fs.mkdirSync("./exam_logs", { recursive: true })
		}
		fs.writeFileSync(resultsFile, JSON.stringify({
			summary: {
				total,
				success_rate: successRate,
				by_difficulty: byDifficulty,
				by_module: byModule,
				failure_counts: failureCounts,
				retrieval: {
					mean_recall: parseFloat((meanRecall * 100).toFixed(1)),
					mean_precision: parseFloat((meanPrecision * 100).toFixed(1)),
					perfect_recall_count: perfectRecallCount,
					questions_with_misses: questionsWithMisses,
				},
			},
			results
		}, null, 2))
		console.log(`\nDetailed results: ${resultsFile}`)
	} catch (err) {
		console.error("Failed to write results:", err)
	}

	// Tuning recommendations
	console.log("\n" + "-".repeat(80))
	console.log("ANALYSIS & RECOMMENDATIONS")
	console.log("-".repeat(80))

	const columnMissRate = failureCounts.column_miss / total
	const llmReasoningRate = failureCounts.llm_reasoning / total
	const joinPathMissRate = failureCounts.join_path_miss / total

	if (columnMissRate > 0.15) {
		console.log("\n⚠️  High column_miss rate (>15%)")
		console.log("   → LLM is using wrong column names")
		console.log("   → Review column glosses in embed_text")
		console.log("   → Check column candidates are in repair prompts")
	}

	if (llmReasoningRate > 0.2) {
		console.log("\n⚠️  High llm_reasoning error rate (>20%)")
		console.log("   → LLM generating syntactically invalid SQL")
		console.log("   → Improve prompt examples")
		console.log("   → Consider adding more JOINs / aggregation examples")
	}

	if (joinPathMissRate > 0.1) {
		console.log("\n⚠️  High join_path_miss rate (>10%)")
		console.log("   → LLM referencing undefined table aliases")
		console.log("   → Check FK edges are being passed to prompt")
	}

	const easyRate = byDifficulty.easy.pass / (byDifficulty.easy.pass + byDifficulty.easy.fail)
	const hardRate = byDifficulty.hard.pass / (byDifficulty.hard.pass + byDifficulty.hard.fail)

	if (easyRate < 0.7) {
		console.log("\n⚠️  Low easy question success rate (<70%)")
		console.log("   → Check schema retrieval for single-table queries")
	}

	if (easyRate >= 0.8 && hardRate < 0.3) {
		console.log("\n📊 Pattern: Easy queries work, hard queries fail")
		console.log("   → Likely prompt engineering issue, not retrieval")
		console.log("   → Add complex query examples to base prompt")
	}

	if (parseFloat(successRate) >= 70) {
		console.log("\n✓ Success rate ≥70% - Schema RAG V2 is performing well!")
	}

	console.log("\n" + "=".repeat(80))

	await pool.end()
}

runExam().catch(console.error)
