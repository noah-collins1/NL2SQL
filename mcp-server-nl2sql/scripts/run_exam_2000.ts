/**
 * Exam Runner for enterprise_erp_2000 (CSV-based exams)
 *
 * Reads exam CSV, extracts target schema from gold_sql, sets search_path
 * per question, runs through full NL2SQL pipeline.
 *
 * Supports both v1 (with evidence) and v2 (no evidence, ambiguity grading).
 *
 * Usage:
 *   EXAM_MODE=true DATABASE_URL=postgresql://postgres:1219@localhost:5432/enterprise_erp_2000 \
 *     npx tsx scripts/run_exam_2000.ts --exam ../exam/exam_full_300.csv
 *
 *   # v2 exam with ambiguity grading:
 *   EXAM_MODE=true npx tsx scripts/run_exam_2000.ts --exam ../demo/exam/exam_v2_500.csv
 */

import pg from "pg"
import { executeNLQuery } from "../src/nl_query_tool.js"
import fs from "fs"
import path from "path"

const { Pool } = pg

// ============================================================================
// CSV Parser (no external deps)
// ============================================================================
function parseCSV(content: string): Record<string, string>[] {
	const lines = content.split("\n")
	if (lines.length < 2) return []

	// Parse header
	const headers = parseCSVLine(lines[0])
	const rows: Record<string, string>[] = []

	let currentLine = ""
	for (let i = 1; i < lines.length; i++) {
		currentLine += (currentLine ? "\n" : "") + lines[i]
		// Check if we have balanced quotes
		const quoteCount = (currentLine.match(/"/g) || []).length
		if (quoteCount % 2 === 0) {
			if (currentLine.trim()) {
				const values = parseCSVLine(currentLine)
				const row: Record<string, string> = {}
				headers.forEach((h, idx) => {
					row[h] = values[idx] || ""
				})
				rows.push(row)
			}
			currentLine = ""
		}
	}
	return rows
}

function parseCSVLine(line: string): string[] {
	const result: string[] = []
	let current = ""
	let inQuotes = false

	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (ch === '"') {
			if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
				current += '"'
				i++
			} else {
				inQuotes = !inQuotes
			}
		} else if (ch === "," && !inQuotes) {
			result.push(current)
			current = ""
		} else {
			current += ch
		}
	}
	result.push(current)
	return result
}

// ============================================================================
// Schema extraction from gold SQL
// ============================================================================
function extractSchema(goldSql: string): string {
	// Match first schema reference like "div_01.table_name"
	const match = goldSql.match(/\b(div_\d{2})\./i)
	return match ? match[1] : "div_01"
}

// ============================================================================
// Ambiguity detection
// ============================================================================
function isAmbiguousQuestion(q: Record<string, string>): boolean {
	return (
		q.difficulty === "ambiguous" ||
		q.gold_sql?.trim() === "AMBIGUOUS" ||
		q.family?.startsWith("A")
	)
}

// ============================================================================
// Main
// ============================================================================
interface ExamResult {
	qid: string
	difficulty: string
	template_id: string
	family: string
	question: string
	target_schema: string
	sql_generated: string
	gold_sql: string
	success: boolean
	is_ambiguous: boolean
	error_type?: string
	error_message?: string
	sqlstate?: string
	latency_ms: number
	tags: string
}

async function runExam() {
	// Parse args
	const args = process.argv.slice(2)
	let examPath = "../demo/exam/exam_full_300.csv"
	let maxQuestions = 0

	for (const arg of args) {
		if (arg.startsWith("--exam=")) {
			examPath = arg.split("=")[1]
		} else if (arg.startsWith("--exam")) {
			const idx = args.indexOf(arg)
			if (idx + 1 < args.length) examPath = args[idx + 1]
		} else if (arg.startsWith("--max=")) {
			maxQuestions = parseInt(arg.split("=")[1])
		}
	}

	// Load exam
	const fullPath = path.resolve(process.cwd(), examPath)
	const content = fs.readFileSync(fullPath, "utf-8")
	const questions = parseCSV(content)

	if (maxQuestions > 0) {
		questions.splice(maxQuestions)
	}

	// Detect exam version based on presence of evidence column and ambiguous questions
	const hasEvidence = questions.length > 0 && "evidence" in questions[0]
	const hasAmbiguous = questions.some((q) => isAmbiguousQuestion(q))
	const examVersion = hasAmbiguous ? "v2" : "v1"

	const connectionString =
		process.env.DATABASE_URL ||
		`postgresql://postgres:${process.env.DB_PASSWORD || "1219"}@localhost:5432/enterprise_erp_2000`

	const logger = {
		info: (msg: string, _data?: any) => {
			if (
				msg.startsWith("EXAM_RETRIEVAL") ||
				msg.startsWith("AUDIT_LOG")
			)
				return
			if (!msg.includes("Starting") && !msg.includes("complete")) {
				// Quiet
			}
		},
		debug: () => {},
		warn: (_msg: string, _data?: any) => {},
		error: (msg: string, _data?: any) =>
			console.error(`[ERROR] ${msg}`),
	}

	const results: ExamResult[] = []
	const failureCounts: Record<string, number> = {
		success: 0,
		column_miss: 0,
		join_path_miss: 0,
		value_miss: 0,
		llm_reasoning: 0,
		execution_error: 0,
		// v2 ambiguity categories
		correct_abstain: 0,
		false_positive_on_ambiguous: 0,
	}

	const byDifficulty: Record<string, { pass: number; fail: number }> = {}

	const byTag: Record<string, { pass: number; fail: number }> = {}
	const byFamily: Record<string, { pass: number; fail: number }> = {}

	console.log("\n" + "=".repeat(80))
	console.log("ENTERPRISE ERP 2000-TABLE EXAM")
	console.log("=".repeat(80))
	console.log(`\nExam: ${fullPath}`)
	console.log(`Questions: ${questions.length}`)
	console.log(`Version: ${examVersion}`)
	console.log(`Evidence: ${hasEvidence ? "yes" : "no"}`)
	console.log(`Ambiguous questions: ${questions.filter((q) => isAmbiguousQuestion(q)).length}`)
	console.log(`Database: enterprise_erp_2000`)
	console.log(`Model: ${process.env.OLLAMA_MODEL || "default"}`)
	console.log("\n" + "-".repeat(80))

	// Use a single pool; set search_path per question via pool event
	const pool = new Pool({ connectionString, max: 5 })

	// Override pool.connect to set search_path
	const originalConnect = pool.connect.bind(pool)
	let activeSchema = "div_01"

	pool.connect = async function (): Promise<any> {
		const client = await originalConnect()
		const origQuery = client.query.bind(client)
		// Set search_path on first use
		await origQuery(`SET search_path TO ${activeSchema}, public, rag`)
		return client
	} as any

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]
		const qid = q.qid
		const difficulty = q.difficulty || "moderate"
		const question = q.question
		const goldSql = q.gold_sql
		const tags = q.tags || ""
		const templateId = q.template_id || "?"
		const family = q.family || ""
		const ambiguous = isAmbiguousQuestion(q)

		// For ambiguous questions, use a random schema (they have no real gold_sql)
		const targetSchema = ambiguous ? "div_01" : extractSchema(goldSql)

		// Update active schema for pool connections
		activeSchema = targetSchema

		// Include evidence in question for better results (v1 only)
		const evidence = q.evidence || ""
		const fullQuestion = evidence
			? `${question}\nEvidence: ${evidence}`
			: question

		const qNum = `[${i + 1}/${questions.length}]`
		const diffChar = ambiguous ? "?" : difficulty.charAt(0).toUpperCase()
		const schemaTag = targetSchema.padEnd(6)
		process.stdout.write(
			`${qNum} ${diffChar} ${schemaTag} ${question.substring(0, 42).padEnd(42)}...`
		)

		// Initialize difficulty tracking
		if (!byDifficulty[difficulty]) {
			byDifficulty[difficulty] = { pass: 0, fail: 0 }
		}

		// Track by tag
		for (const tag of tags.split(",").map((t: string) => t.trim())) {
			if (tag && !byTag[tag]) {
				byTag[tag] = { pass: 0, fail: 0 }
			}
		}

		// Track by family
		if (family && !byFamily[family]) {
			byFamily[family] = { pass: 0, fail: 0 }
		}

		const startTime = Date.now()

		// Handle ambiguous questions differently
		if (ambiguous) {
			try {
				const response = await executeNLQuery(
					{
						question: fullQuestion,
						max_rows: 10,
						trace: false,
					},
					{ pool: pool!, logger }
				)

				const latency = Date.now() - startTime
				const producedSQL = response.executed && !response.error

				// For ambiguous questions: NOT producing SQL = correct behavior
				const result: ExamResult = {
					qid,
					difficulty,
					template_id: templateId,
					family,
					question,
					target_schema: targetSchema,
					sql_generated: response.sql_generated || "",
					gold_sql: goldSql,
					success: !producedSQL, // Correct = did NOT produce SQL
					is_ambiguous: true,
					error_type: producedSQL ? "false_positive_on_ambiguous" : undefined,
					error_message: producedSQL
						? "System produced SQL for an ambiguous question"
						: undefined,
					latency_ms: latency,
					tags,
				}

				results.push(result)

				if (!producedSQL) {
					// Correct: system abstained or errored on ambiguous question
					failureCounts.correct_abstain++
					byDifficulty[difficulty].pass++
					for (const tag of tags.split(",").map((t: string) => t.trim())) {
						if (tag && byTag[tag]) byTag[tag].pass++
					}
					if (family && byFamily[family]) byFamily[family].pass++
					console.log(` ✓ abstain (${(latency / 1000).toFixed(1)}s)`)
				} else {
					// Wrong: system produced SQL for ambiguous question
					failureCounts.false_positive_on_ambiguous++
					byDifficulty[difficulty].fail++
					for (const tag of tags.split(",").map((t: string) => t.trim())) {
						if (tag && byTag[tag]) byTag[tag].fail++
					}
					if (family && byFamily[family]) byFamily[family].fail++
					console.log(` ✗ false_positive (produced SQL)`)
				}
			} catch (err) {
				const latency = Date.now() - startTime
				// Exception on ambiguous question = correct (it abstained)
				results.push({
					qid,
					difficulty,
					template_id: templateId,
					family,
					question,
					target_schema: targetSchema,
					sql_generated: "",
					gold_sql: goldSql,
					success: true,
					is_ambiguous: true,
					latency_ms: latency,
					tags,
				})
				failureCounts.correct_abstain++
				byDifficulty[difficulty].pass++
				if (family && byFamily[family]) byFamily[family].pass++
				console.log(` ✓ abstain/exception (${(latency / 1000).toFixed(1)}s)`)
			}
			continue
		}

		// Non-ambiguous question: normal grading
		try {
			const response = await executeNLQuery(
				{
					question: fullQuestion,
					max_rows: 10,
					trace: false,
				},
				{ pool: pool!, logger }
			)

			const latency = Date.now() - startTime
			const result: ExamResult = {
				qid,
				difficulty,
				template_id: templateId,
				family,
				question,
				target_schema: targetSchema,
				sql_generated: response.sql_generated || "",
				gold_sql: goldSql,
				success: response.executed && !response.error,
				is_ambiguous: false,
				error_type: response.error?.type,
				error_message: response.error?.message,
				sqlstate: (response.error?.context as any)?.postgres_error
					?.sqlstate,
				latency_ms: latency,
				tags,
			}

			results.push(result)

			if (result.success) {
				failureCounts.success++
				byDifficulty[difficulty].pass++
				for (const tag of tags
					.split(",")
					.map((t: string) => t.trim())) {
					if (tag && byTag[tag]) byTag[tag].pass++
				}
				if (family && byFamily[family]) byFamily[family].pass++
				console.log(` ✓ (${(latency / 1000).toFixed(1)}s)`)
			} else {
				byDifficulty[difficulty].fail++
				for (const tag of tags
					.split(",")
					.map((t: string) => t.trim())) {
					if (tag && byTag[tag]) byTag[tag].fail++
				}
				if (family && byFamily[family]) byFamily[family].fail++

				// Classify failure
				if (result.sqlstate === "42703") {
					failureCounts.column_miss++
					console.log(` ✗ column_miss`)
				} else if (result.sqlstate === "42P01") {
					failureCounts.join_path_miss++
					console.log(` ✗ join_path_miss`)
				} else if (
					result.error_message?.includes("MISSING_ENTITY") ||
					result.error_message?.includes("HALLUCINATED")
				) {
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
					console.log(
						` ✗ error${result.sqlstate ? ` [${result.sqlstate}]` : ""}`
					)
				}
			}
		} catch (err) {
			const latency = Date.now() - startTime
			results.push({
				qid,
				difficulty,
				template_id: templateId,
				family,
				question,
				target_schema: targetSchema,
				sql_generated: "",
				gold_sql: goldSql,
				success: false,
				is_ambiguous: false,
				error_type: "exception",
				error_message: String(err),
				latency_ms: latency,
				tags,
			})
			failureCounts.execution_error++
			byDifficulty[difficulty].fail++
			if (family && byFamily[family]) byFamily[family].fail++
			console.log(` ✗ exception`)
		}
	}

	await pool.end()

	// ========================================================================
	// Summary
	// ========================================================================
	console.log("\n" + "=".repeat(80))
	console.log("EXAM SUMMARY")
	console.log("=".repeat(80))

	const total = questions.length
	const ambiguousTotal = results.filter((r) => r.is_ambiguous).length
	const nonAmbiguousTotal = total - ambiguousTotal

	// Non-ambiguous success rate
	const nonAmbiguousSuccess = failureCounts.success
	const nonAmbiguousRate = nonAmbiguousTotal > 0
		? ((nonAmbiguousSuccess / nonAmbiguousTotal) * 100).toFixed(1)
		: "N/A"

	// Overall success (includes correct abstains)
	const overallSuccess = failureCounts.success + failureCounts.correct_abstain
	const overallRate = ((overallSuccess / total) * 100).toFixed(1)

	console.log(`\nTotal Questions: ${total}`)
	if (ambiguousTotal > 0) {
		console.log(`  Non-Ambiguous: ${nonAmbiguousTotal} (SQL questions)`)
		console.log(`  Ambiguous: ${ambiguousTotal} (abstain/clarify questions)`)
		console.log(`\nSQL Success Rate: ${nonAmbiguousRate}% (${nonAmbiguousSuccess}/${nonAmbiguousTotal})`)
		console.log(`Ambiguity Correct: ${((failureCounts.correct_abstain / ambiguousTotal) * 100).toFixed(1)}% (${failureCounts.correct_abstain}/${ambiguousTotal})`)
		console.log(`Overall (incl. ambiguity): ${overallRate}% (${overallSuccess}/${total})`)
	} else {
		console.log(`Success Rate: ${overallRate}% (${overallSuccess}/${total})`)
	}

	console.log("\n--- By Difficulty ---")
	// Sort: easy, medium, hard, extra_hard, ambiguous (then any others)
	const diffOrder = ["easy", "simple", "medium", "moderate", "hard", "challenging", "extra_hard", "ambiguous"]
	const sortedDiffs = Object.entries(byDifficulty).sort((a, b) => {
		const ai = diffOrder.indexOf(a[0])
		const bi = diffOrder.indexOf(b[0])
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
	})
	for (const [diff, counts] of sortedDiffs) {
		const t = counts.pass + counts.fail
		if (t === 0) continue
		const rate = ((counts.pass / t) * 100).toFixed(1)
		console.log(`  ${diff.padEnd(12)}: ${rate}% (${counts.pass}/${t})`)
	}

	console.log("\n--- Failure Breakdown ---")
	console.log(
		`  success:         ${failureCounts.success} (${((failureCounts.success / total) * 100).toFixed(1)}%)`
	)
	console.log(
		`  column_miss:     ${failureCounts.column_miss} (${((failureCounts.column_miss / total) * 100).toFixed(1)}%)`
	)
	console.log(
		`  llm_reasoning:   ${failureCounts.llm_reasoning} (${((failureCounts.llm_reasoning / total) * 100).toFixed(1)}%)`
	)
	console.log(
		`  join_path_miss:  ${failureCounts.join_path_miss} (${((failureCounts.join_path_miss / total) * 100).toFixed(1)}%)`
	)
	console.log(
		`  value_miss:      ${failureCounts.value_miss} (${((failureCounts.value_miss / total) * 100).toFixed(1)}%)`
	)
	console.log(
		`  execution_error: ${failureCounts.execution_error} (${((failureCounts.execution_error / total) * 100).toFixed(1)}%)`
	)
	if (ambiguousTotal > 0) {
		console.log(
			`  correct_abstain: ${failureCounts.correct_abstain} (${((failureCounts.correct_abstain / total) * 100).toFixed(1)}%)`
		)
		console.log(
			`  false_positive:  ${failureCounts.false_positive_on_ambiguous} (${((failureCounts.false_positive_on_ambiguous / total) * 100).toFixed(1)}%)`
		)
	}

	// By family (if v2)
	if (Object.keys(byFamily).length > 1) {
		console.log("\n--- By Family ---")
		const familyEntries = Object.entries(byFamily)
			.filter(([_, c]) => c.pass + c.fail > 0)
			.sort((a, b) => {
				// Sort numerically, then alphabetically
				const an = parseInt(a[0]) || 999
				const bn = parseInt(b[0]) || 999
				return an - bn || a[0].localeCompare(b[0])
			})
		for (const [fam, counts] of familyEntries) {
			const t = counts.pass + counts.fail
			const rate = ((counts.pass / t) * 100).toFixed(1)
			console.log(`  F${fam.padEnd(4)}: ${rate}% (${counts.pass}/${t})`)
		}
	}

	// Top failure tags
	console.log("\n--- By Tag (top 15) ---")
	const tagEntries = Object.entries(byTag)
		.filter(([_, c]) => c.pass + c.fail > 0)
		.sort((a, b) => b[1].pass + b[1].fail - (a[1].pass + a[1].fail))
		.slice(0, 15)
	for (const [tag, counts] of tagEntries) {
		const t = counts.pass + counts.fail
		const rate = ((counts.pass / t) * 100).toFixed(1)
		console.log(`  ${tag.padEnd(20)}: ${rate}% (${counts.pass}/${t})`)
	}

	// Latency stats
	const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b)
	if (latencies.length > 0) {
		const p50 = latencies[Math.floor(latencies.length * 0.5)]
		const p95 = latencies[Math.floor(latencies.length * 0.95)]
		const max = latencies[latencies.length - 1]
		console.log(`\n--- Latency ---`)
		console.log(`  P50: ${(p50 / 1000).toFixed(1)}s`)
		console.log(`  P95: ${(p95 / 1000).toFixed(1)}s`)
		console.log(`  Max: ${(max / 1000).toFixed(1)}s`)
	}

	// Write detailed results
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
	const resultsFile = `./exam_logs/exam_2000_${timestamp}.json`
	try {
		if (!fs.existsSync("./exam_logs")) {
			fs.mkdirSync("./exam_logs", { recursive: true })
		}
		fs.writeFileSync(
			resultsFile,
			JSON.stringify(
				{
					exam_file: fullPath,
					exam_version: examVersion,
					timestamp: new Date().toISOString(),
					model: process.env.OLLAMA_MODEL || "default",
					summary: {
						total,
						non_ambiguous_total: nonAmbiguousTotal,
						ambiguous_total: ambiguousTotal,
						success_rate: parseFloat(nonAmbiguousRate !== "N/A" ? nonAmbiguousRate : "0"),
						overall_rate: parseFloat(overallRate),
						ambiguity_correct_rate: ambiguousTotal > 0
							? parseFloat(((failureCounts.correct_abstain / ambiguousTotal) * 100).toFixed(1))
							: null,
						by_difficulty: byDifficulty,
						failure_counts: failureCounts,
						by_tag: byTag,
						by_family: byFamily,
					},
					results,
				},
				null,
				2
			)
		)
		console.log(`\nDetailed results: ${resultsFile}`)
	} catch (err) {
		console.error("Failed to write results:", err)
	}

	console.log("\n" + "=".repeat(80))
}

runExam().catch(console.error)
