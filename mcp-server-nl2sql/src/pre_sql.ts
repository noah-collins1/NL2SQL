/**
 * Pre-SQL Generation (Phase 3.1)
 *
 * Generates a "sketch" SQL with minimal schema context, extracts referenced
 * tables, and identifies tables missing from the current schema context.
 * Used to improve retrieval recall for medium/hard questions.
 *
 * Flow:
 * 1. Build minimal schema (table names + glosses only, no columns)
 * 2. Call sidecar /generate_sql with k=1, temp=0
 * 3. Extract table references from sketch SQL
 * 4. Compare against retrieved tables — find missing tables
 * 5. Re-retrieve missing tables via pgvector
 * 6. Merge into schema context
 *
 * Default: OFF (adds ~2s latency, intended for 2000-table scaling)
 */

import type { Pool, PoolClient } from "pg"
import type { SchemaContextPacket } from "./schema_types.js"
import type { SchemaGlosses } from "./schema_glosses.js"
import type { PythonClient } from "./python_client.js"
import { extractTableRefsFromSQL } from "./candidate_reranker.js"

// ============================================================================
// Feature Flag
// ============================================================================

import { getConfig } from "./config/loadConfig.js"

export const PRE_SQL_ENABLED = process.env.PRE_SQL_ENABLED !== undefined
	? process.env.PRE_SQL_ENABLED === "true"
	: getConfig().features.pre_sql

// ============================================================================
// Types
// ============================================================================

export interface PreSQLResult {
	sketchSQL: string
	referencedTables: string[]
	missingTables: string[]
	additionalTablesRetrieved: string[]
	latencyMs: number
}

// ============================================================================
// Minimal Schema Construction
// ============================================================================

/**
 * Build minimal schema context for sketch generation.
 * Includes: table_name, module, 1-line gloss, PK column only.
 * Excludes: all non-PK columns, FK edges, descriptions.
 */
function buildMinimalSchemaText(
	schemaContext: SchemaContextPacket,
	glosses: SchemaGlosses | null,
): string {
	const lines: string[] = ["Available tables:"]

	for (const t of schemaContext.tables) {
		let gloss = t.gloss
		// Try to get a more descriptive gloss from SchemaGlosses if available
		if (glosses) {
			const tableGlosses = glosses.get(t.table_name)
			if (tableGlosses) {
				// Use table-level gloss from first entry if available
				const firstEntry = tableGlosses.values().next().value
				if (firstEntry) {
					gloss = t.gloss || gloss
				}
			}
		}

		// Extract PK column from m_schema if present
		const pkMatch = t.m_schema.match(/(\w+)\s*\(PK\)/)
		const pkCol = pkMatch ? pkMatch[1] : "id"

		lines.push(`- ${t.table_name} (${t.module}): ${gloss} [PK: ${pkCol}]`)
	}

	return lines.join("\n")
}

// ============================================================================
// Sketch SQL Generation
// ============================================================================

/**
 * Generate a sketch SQL using minimal schema.
 * Uses k=1, low max_tokens for speed.
 */
async function generateSketchSQL(
	question: string,
	minimalSchemaText: string,
	pythonClient: PythonClient,
	databaseId: string,
): Promise<string | null> {
	try {
		const response = await pythonClient.generateSQL({
			question,
			database_id: databaseId,
			schema_context: {
				query_id: "pre-sql-sketch",
				database_id: databaseId,
				question,
				tables: [], // No full tables — use schema_link_text for minimal schema
				fk_edges: [],
				modules: [],
			},
			schema_link_text: minimalSchemaText,
			multi_candidate_k: 1,
			max_rows: 100,
			timeout_seconds: 10,
		})

		return response.sql_generated || null
	} catch {
		return null
	}
}

// ============================================================================
// Re-Retrieval
// ============================================================================

/**
 * Re-retrieve missing tables by embedding table names and querying pgvector.
 */
async function reRetrieveTables(
	missingTables: string[],
	existingTableNames: Set<string>,
	pool: Pool,
	pythonClient: PythonClient,
): Promise<Array<{
	table_name: string
	table_schema: string
	module: string
	gloss: string
	m_schema: string
	similarity: number
	source: "retrieval"
}>> {
	const results: Array<{
		table_name: string
		table_schema: string
		module: string
		gloss: string
		m_schema: string
		similarity: number
		source: "retrieval"
	}> = []

	let client: PoolClient | null = null
	try {
		client = await pool.connect()

		for (const tableName of missingTables) {
			// Embed the missing table name as a query
			const embedding = await pythonClient.embedText(tableName)

			// Query pgvector for closest match
			const result = await client.query(
				`SELECT
					table_schema,
					table_name,
					COALESCE(module, 'unknown') as module,
					COALESCE(inferred_gloss, table_name) as gloss,
					m_schema_compact,
					1 - (description_embedding <=> $1::vector) as similarity
				FROM rag.schema_tables
				WHERE 1 - (description_embedding <=> $1::vector) > 0.20
				ORDER BY description_embedding <=> $1::vector
				LIMIT 3`,
				[`[${embedding.join(",")}]`],
			)

			for (const row of result.rows) {
				if (!existingTableNames.has(row.table_name)) {
					results.push({
						table_name: row.table_name,
						table_schema: row.table_schema,
						module: row.module,
						gloss: row.gloss,
						m_schema: row.m_schema_compact,
						similarity: row.similarity,
						source: "retrieval",
					})
					existingTableNames.add(row.table_name)
				}
			}
		}
	} finally {
		if (client) client.release()
	}

	return results
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run pre-SQL sketch generation and re-retrieval.
 *
 * @param question - User's natural language question
 * @param schemaContext - Current schema context from retrieval
 * @param glosses - Schema glosses (if available)
 * @param pythonClient - Python sidecar client
 * @param pool - Database pool
 * @param difficulty - Question difficulty classification
 * @returns PreSQLResult or null if skipped/failed
 */
export async function runPreSQL(
	question: string,
	schemaContext: SchemaContextPacket,
	glosses: SchemaGlosses | null,
	pythonClient: PythonClient,
	pool: Pool,
	difficulty: "easy" | "medium" | "hard",
): Promise<PreSQLResult | null> {
	const startTime = Date.now()

	// Skip easy questions — overhead not worth it
	if (difficulty === "easy") return null

	// Build minimal schema for sketch
	const minimalText = buildMinimalSchemaText(schemaContext, glosses)

	// Generate sketch SQL
	const sketchSQL = await generateSketchSQL(question, minimalText, pythonClient, schemaContext.database_id)
	if (!sketchSQL) {
		return null
	}

	// Extract table references from sketch
	const referencedTables = extractTableRefsFromSQL(sketchSQL)

	// Find tables that are in the sketch but not in current schema context
	const existingTableNames = new Set(schemaContext.tables.map(t => t.table_name.toLowerCase()))
	const missingTables = referencedTables.filter(t => !existingTableNames.has(t))

	if (missingTables.length === 0) {
		return {
			sketchSQL,
			referencedTables,
			missingTables: [],
			additionalTablesRetrieved: [],
			latencyMs: Date.now() - startTime,
		}
	}

	// Re-retrieve missing tables
	const additionalTables = await reRetrieveTables(missingTables, existingTableNames, pool, pythonClient)

	// Merge into schema context
	for (const newTable of additionalTables) {
		schemaContext.tables.push({
			table_name: newTable.table_name,
			table_schema: newTable.table_schema,
			module: newTable.module,
			gloss: newTable.gloss,
			m_schema: newTable.m_schema,
			similarity: newTable.similarity,
			source: newTable.source,
		})
	}

	return {
		sketchSQL,
		referencedTables,
		missingTables,
		additionalTablesRetrieved: additionalTables.map(t => t.table_name),
		latencyMs: Date.now() - startTime,
	}
}
