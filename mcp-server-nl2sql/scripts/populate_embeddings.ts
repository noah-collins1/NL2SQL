#!/usr/bin/env npx tsx
/**
 * Populate Schema Embeddings Script
 *
 * Introspects a connected PostgreSQL database and populates the
 * rag.schema_embeddings table with table and column embeddings.
 *
 * Usage:
 *   npx tsx scripts/populate_embeddings.ts --database-id=enterprise_erp
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 *   PYTHON_SIDECAR_URL - URL of Python sidecar (default: http://localhost:8001)
 *
 * Options:
 *   --database-id    Identifier for this database (required)
 *   --schemas        Comma-separated schemas to introspect (default: public)
 *   --exclude        Comma-separated tables to exclude
 *   --module-file    JSON file with table->module mapping
 *   --batch-size     Batch size for embedding (default: 50)
 *   --dry-run        Generate records but don't write to DB
 */

import { Pool } from "pg"
import fs from "fs"
import path from "path"
import { getSchemaEmbedder, EmbeddingRecord } from "../src/schema_embedder.js"

// ============================================================================
// Configuration
// ============================================================================

interface Config {
	databaseId: string
	schemas: string[]
	excludeTables: string[]
	moduleMapping: Map<string, string>
	batchSize: number
	dryRun: boolean
}

function parseArgs(): Config {
	const args = process.argv.slice(2)
	const config: Config = {
		databaseId: "",
		schemas: ["public"],
		excludeTables: [],
		moduleMapping: new Map(),
		batchSize: 50,
		dryRun: false,
	}

	for (const arg of args) {
		if (arg.startsWith("--database-id=")) {
			config.databaseId = arg.split("=")[1]
		} else if (arg.startsWith("--schemas=")) {
			config.schemas = arg.split("=")[1].split(",")
		} else if (arg.startsWith("--exclude=")) {
			config.excludeTables = arg.split("=")[1].split(",")
		} else if (arg.startsWith("--module-file=")) {
			const filePath = arg.split("=")[1]
			const content = fs.readFileSync(filePath, "utf-8")
			const mapping = JSON.parse(content) as Record<string, string>
			config.moduleMapping = new Map(Object.entries(mapping))
		} else if (arg.startsWith("--batch-size=")) {
			config.batchSize = parseInt(arg.split("=")[1], 10)
		} else if (arg === "--dry-run") {
			config.dryRun = true
		}
	}

	if (!config.databaseId) {
		console.error("Error: --database-id is required")
		process.exit(1)
	}

	return config
}

// ============================================================================
// Logger
// ============================================================================

const logger = {
	info: (msg: string, data?: any) => {
		console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : "")
	},
	error: (msg: string, data?: any) => {
		console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : "")
	},
	warn: (msg: string, data?: any) => {
		console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : "")
	},
	debug: (msg: string, data?: any) => {
		if (process.env.DEBUG) {
			console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : "")
		}
	},
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const config = parseArgs()

	logger.info("Starting embedding population", {
		database_id: config.databaseId,
		schemas: config.schemas,
		exclude_tables: config.excludeTables,
		batch_size: config.batchSize,
		dry_run: config.dryRun,
	})

	// Connect to database
	const connectionString = process.env.DATABASE_URL
	if (!connectionString) {
		logger.error("DATABASE_URL environment variable is required")
		process.exit(1)
	}

	const pool = new Pool({ connectionString })

	try {
		// Test connection
		const client = await pool.connect()
		const { rows } = await client.query("SELECT current_database() as db")
		logger.info(`Connected to database: ${rows[0].db}`)
		client.release()

		// Initialize embedder
		const embedder = getSchemaEmbedder(pool, logger)

		// Generate embedding records
		logger.info("Introspecting schema and generating embedding records...")
		const records = await embedder.generateEmbeddingRecords(
			config.databaseId,
			config.moduleMapping,
			config.schemas,
			config.excludeTables,
		)

		logger.info("Embedding records generated", {
			total: records.length,
			tables: records.filter((r) => r.entity_type === "table").length,
			columns: records.filter((r) => r.entity_type === "column").length,
		})

		if (config.dryRun) {
			// Output sample records
			logger.info("Dry run - sample records:")

			const tableRecords = records.filter((r) => r.entity_type === "table").slice(0, 2)
			for (const record of tableRecords) {
				console.log("\n--- TABLE RECORD ---")
				console.log(`Table: ${record.table_schema}.${record.table_name}`)
				console.log(`Module: ${record.module}`)
				console.log(`Gloss: ${record.gloss}`)
				console.log(`Synonyms: ${record.synonyms.join(", ")}`)
				console.log("\nEmbed Text:")
				console.log(record.embed_text)
				console.log("\nM-Schema Compact:")
				console.log((record as any).m_schema_compact)
			}

			const columnRecords = records.filter((r) => r.entity_type === "column").slice(0, 3)
			for (const record of columnRecords) {
				console.log("\n--- COLUMN RECORD ---")
				console.log(`Column: ${record.table_schema}.${record.table_name}.${record.column_name}`)
				console.log(`Type: ${(record as any).data_type}`)
				console.log(`Gloss: ${record.gloss}`)
				console.log(`Is Generic: ${(record as any).is_generic}`)
				console.log("\nEmbed Text:")
				console.log(record.embed_text)
			}

			logger.info("Dry run complete - no records written to database")
		} else {
			// Populate embeddings
			logger.info("Populating embeddings (this may take a while)...")
			const result = await embedder.populateEmbeddings(
				config.databaseId,
				records,
				config.batchSize,
			)

			logger.info("Embedding population complete", result)
		}
	} catch (error) {
		logger.error("Population failed", { error: String(error) })
		process.exit(1)
	} finally {
		await pool.end()
	}
}

main().catch((error) => {
	console.error("Unhandled error:", error)
	process.exit(1)
})
