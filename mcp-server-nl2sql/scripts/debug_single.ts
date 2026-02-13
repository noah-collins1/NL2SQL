import pg from "pg"
const { Pool } = pg
import { executeNLQuery } from "../src/nl_query_tool.js"

async function main() {
	const pool = new Pool({
		connectionString:
			process.env.DATABASE_URL || `postgresql://postgres:${process.env.DB_PASSWORD || "1219"}@localhost:5432/enterprise_erp_2000`,
		max: 5,
	})
	const origConnect = pool.connect.bind(pool)
	pool.connect = async function (): Promise<any> {
		const client = await origConnect()
		await client.query("SET search_path TO div_06, public, rag")
		return client
	} as any

	const logger = {
		info: (msg: string, data?: any) => {
			if (
				msg.includes("EXPLAIN") ||
				msg.includes("repair") ||
				msg.includes("Validation") ||
				msg.includes("Lint") ||
				msg.includes("lint") ||
				msg.includes("column") ||
				msg.includes("42") ||
				msg.includes("retriev") ||
				msg.includes("UNKNOWN") ||
				msg.includes("allowed") ||
				msg.includes("tables") ||
				msg.includes("Schema RAG")
			)
				console.log(
					"[INFO]",
					msg,
					data ? JSON.stringify(data).substring(0, 500) : ""
				)
		},
		debug: (msg: string, data?: any) => {
			if (msg.includes("EXPLAIN") || msg.includes("Running"))
				console.log(
					"[DBG]",
					msg,
					data ? JSON.stringify(data).substring(0, 300) : ""
				)
		},
		warn: (msg: string, data?: any) =>
			console.log(
				"[WARN]",
				msg,
				data ? JSON.stringify(data).substring(0, 200) : ""
			),
		error: (msg: string, data?: any) =>
			console.log(
				"[ERR]",
				msg,
				data ? JSON.stringify(data).substring(0, 200) : ""
			),
	}

	const result = await executeNLQuery(
		{
			question: "List open AR invoices over 5000 in 2023.",
			max_rows: 10,
			trace: true,
		},
		{ pool, logger }
	)

	console.log("\n=== RESULT ===")
	console.log("Success:", result.executed && !result.error)
	console.log("Error:", result.error?.message?.substring(0, 200))
	console.log("SQL:", result.sql_generated?.substring(0, 300))

	await pool.end()
}

main().catch(console.error)
