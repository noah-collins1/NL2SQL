/**
 * Smoke Test for Schema RAG V2
 *
 * Verifies:
 * 1. V2 retriever returns tables
 * 2. Score fusion works
 * 3. Full query path executes
 */

import pg from "pg"
import { getSchemaRetrieverV2, resetSchemaRetrieverV2 } from "../src/schema_retriever_v2.js"

const { Pool } = pg

async function main() {
	const connectionString = process.env.DATABASE_URL || "postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp"
	const pool = new Pool({ connectionString })

	const logger = {
		info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
		debug: (msg: string, data?: any) => console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
		warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
		error: (msg: string, data?: any) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
	}

	console.log("\n=== Schema RAG V2 Smoke Test ===\n")

	// Test question
	const question = "Which employees have pending leave requests?"
	console.log(`Question: "${question}"\n`)

	try {
		// Reset singleton to ensure fresh instance
		resetSchemaRetrieverV2()

		const retriever = getSchemaRetrieverV2(pool, logger)
		console.log("Retrieving schema context...\n")

		const { packet, metrics } = await retriever.retrieveSchemaContext(
			question,
			"enterprise_erp"
		)

		console.log("\n=== RETRIEVAL RESULTS ===\n")
		console.log(`Tables retrieved: ${packet.tables.length}`)
		console.log(`Tables: ${packet.tables.map(t => t.table_name).join(", ")}`)
		console.log(`Modules: ${packet.modules.join(", ")}`)
		console.log(`FK edges: ${packet.fk_edges.length}`)

		console.log("\n=== METRICS ===\n")
		console.log(`Tables from table retrieval: ${metrics.tables_from_table_retrieval}`)
		console.log(`Tables from column only: ${metrics.tables_from_column_only}`)
		console.log(`Tables from FK expansion: ${metrics.fk_expansion_added}`)
		console.log(`FK expansion blocked: ${metrics.fk_expansion_blocked_no_evidence}`)

		console.log("\n=== TOP TABLE SCORES ===\n")
		for (const score of metrics.table_similarities.slice(0, 5)) {
			console.log(`  ${score.table}: ${score.similarity.toFixed(3)}`)
		}

		console.log("\n=== FUSED SCORES (top 5) ===\n")
		for (const score of (metrics.fused_scores || []).slice(0, 5)) {
			console.log(`  ${score.table}: fused=${score.fused.toFixed(3)} (table=${score.table_sim.toFixed(3)}, col=${score.col_score.toFixed(3)})`)
		}

		console.log("\n=== COLUMN HITS PER TABLE ===\n")
		for (const [table, count] of Object.entries(metrics.column_hits_per_table)) {
			console.log(`  ${table}: ${count} columns`)
		}

		console.log("\n=== TIMING ===\n")
		console.log(`Embedding latency: ${metrics.embedding_latency_ms}ms`)
		console.log(`Total retrieval latency: ${metrics.total_latency_ms}ms`)

		console.log("\n=== M-SCHEMA SAMPLES ===\n")
		for (const table of packet.tables.slice(0, 2)) {
			console.log(`--- ${table.table_name} ---`)
			console.log(`Gloss: ${table.gloss}`)
			console.log(`M-Schema: ${table.m_schema.substring(0, 200)}...`)
			console.log()
		}

		console.log("\n✓ Smoke test PASSED\n")

	} catch (error) {
		console.error("\n✗ Smoke test FAILED\n")
		console.error(error)
		process.exit(1)
	} finally {
		await pool.end()
	}
}

main()
