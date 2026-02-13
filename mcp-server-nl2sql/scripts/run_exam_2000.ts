/**
 * Exam Runner for enterprise_erp_2000 (CSV-based exams)
 *
 * Reads exam CSV, extracts target schema from gold_sql, sets search_path
 * per question, runs through full NL2SQL pipeline.
 *
 * Usage:
 *   EXAM_MODE=true DATABASE_URL=postgresql://postgres:1219@localhost:5432/enterprise_erp_2000 \
 *     npx tsx scripts/run_exam_2000.ts --exam ../exam/exam_full_300.csv
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
// Main
// ============================================================================
interface ExamResult {
	qid: string
	difficulty: string
	template_id: string
	question: string
	target_schema: string
	sql_generated: string
	gold_sql: string
	success: boolean
	error_type?: string
	error_message?: string
	sqlstate?: string
	latency_ms: number
	tags: string
}

async function runExam() {
	// Parse args
	const args = process.argv.slice(2)
	let examPath = "../exam/exam_full_300.csv"
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
	}

	const byDifficulty: Record<string, { pass: number; fail: number }> = {
		simple: { pass: 0, fail: 0 },
		moderate: { pass: 0, fail: 0 },
		challenging: { pass: 0, fail: 0 },
	}

	const byTag: Record<string, { pass: number; fail: number }> = {}

	console.log("\n" + "=".repeat(80))
	console.log("ENTERPRISE ERP 2000-TABLE EXAM")
	console.log("=".repeat(80))
	console.log(`\nExam: ${fullPath}`)
	console.log(`Questions: ${questions.length}`)
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
		const targetSchema = extractSchema(goldSql)
		const tags = q.tags || ""
		const templateId = q.template_id || "?"

		// Update active schema for pool connections
		activeSchema = targetSchema

		// Include evidence in question for better results
		const evidence = q.evidence || ""
		const fullQuestion = evidence
			? `${question}\nEvidence: ${evidence}`
			: question

		const qNum = `[${i + 1}/${questions.length}]`
		const diffChar = difficulty.charAt(0).toUpperCase()
		const schemaTag = targetSchema.padEnd(6)
		process.stdout.write(
			`${qNum} ${diffChar} ${schemaTag} ${question.substring(0, 42).padEnd(42)}...`
		)

		const startTime = Date.now()

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
				question,
				target_schema: targetSchema,
				sql_generated: response.sql_generated || "",
				gold_sql: goldSql,
				success: response.executed && !response.error,
				error_type: response.error?.type,
				error_message: response.error?.message,
				sqlstate: (response.error?.context as any)?.postgres_error
					?.sqlstate,
				latency_ms: latency,
				tags,
			}

			results.push(result)

			// Initialize difficulty tracking
			if (!byDifficulty[difficulty]) {
				byDifficulty[difficulty] = { pass: 0, fail: 0 }
			}

			// Track by tag
			for (const tag of tags.split(",").map((t: string) => t.trim())) {
				if (tag) {
					if (!byTag[tag]) byTag[tag] = { pass: 0, fail: 0 }
				}
			}

			if (result.success) {
				failureCounts.success++
				byDifficulty[difficulty].pass++
				for (const tag of tags
					.split(",")
					.map((t: string) => t.trim())) {
					if (tag && byTag[tag]) byTag[tag].pass++
				}
				console.log(` ✓ (${(latency / 1000).toFixed(1)}s)`)
			} else {
				byDifficulty[difficulty].fail++
				for (const tag of tags
					.split(",")
					.map((t: string) => t.trim())) {
					if (tag && byTag[tag]) byTag[tag].fail++
				}

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
				question,
				target_schema: targetSchema,
				sql_generated: "",
				gold_sql: goldSql,
				success: false,
				error_type: "exception",
				error_message: String(err),
				latency_ms: latency,
				tags,
			})
			failureCounts.execution_error++
			byDifficulty[difficulty].fail++
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
	const successRate = ((failureCounts.success / total) * 100).toFixed(1)

	console.log(`\nTotal Questions: ${total}`)
	console.log(
		`Success Rate: ${successRate}% (${failureCounts.success}/${total})`
	)

	console.log("\n--- By Difficulty ---")
	for (const [diff, counts] of Object.entries(byDifficulty)) {
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

	// Top failure tags
	console.log("\n--- By Tag (top 10) ---")
	const tagEntries = Object.entries(byTag)
		.filter(([_, c]) => c.pass + c.fail > 0)
		.sort((a, b) => b[1].pass + b[1].fail - (a[1].pass + a[1].fail))
		.slice(0, 10)
	for (const [tag, counts] of tagEntries) {
		const t = counts.pass + counts.fail
		const rate = ((counts.pass / t) * 100).toFixed(1)
		console.log(`  ${tag.padEnd(16)}: ${rate}% (${counts.pass}/${t})`)
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
					timestamp: new Date().toISOString(),
					model: process.env.OLLAMA_MODEL || "default",
					summary: {
						total,
						success_rate: parseFloat(successRate),
						by_difficulty: byDifficulty,
						failure_counts: failureCounts,
						by_tag: byTag,
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
