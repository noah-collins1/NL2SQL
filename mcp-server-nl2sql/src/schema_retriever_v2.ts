/**
 * Schema RAG Retriever V2
 *
 * Dual retrieval (table + column) with score fusion for improved accuracy.
 *
 * Flow:
 * 1. Embed user question via Python sidecar
 * 2. Query pgvector for top-K tables (entity_type='table')
 * 3. Query pgvector for top-K columns (entity_type='column')
 * 4. Aggregate column hits per table: colScore = top1 + 0.5*top2
 * 5. Apply generic column downweight (0.7x)
 * 6. Fuse scores: finalScore = 0.6*tableScore + 0.4*colScore
 * 7. Select top 10 tables by fused score
 * 8. FK expansion (relevance-gated): add FK neighbors only if in evidence set
 * 9. Build SchemaContextPacket
 */

import { Pool, PoolClient } from "pg"
import { v4 as uuidv4 } from "uuid"
import { getPythonClient, PythonClient } from "./python_client.js"
import {
	SchemaContextPacket,
	TableRetrievalHit,
	ColumnRetrievalHit,
	TableColumnScore,
	FusedTableScore,
	EvidenceSet,
	RetrievalConfigV2,
	DEFAULT_RETRIEVAL_CONFIG_V2,
	RetrievalMetrics,
	FKBlockedEntry,
	JoinHint,
	JoinPath,
} from "./schema_types.js"

// ============================================================================
// Schema Retriever V2
// ============================================================================

export class SchemaRetrieverV2 {
	private pool: Pool
	private pythonClient: PythonClient
	private config: RetrievalConfigV2
	private logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}

	constructor(
		pool: Pool,
		logger: { info: Function; error: Function; warn: Function; debug: Function },
		config?: Partial<RetrievalConfigV2>,
	) {
		this.pool = pool
		this.pythonClient = getPythonClient()
		this.config = { ...DEFAULT_RETRIEVAL_CONFIG_V2, ...config }
		this.logger = logger
	}

	/**
	 * Retrieve schema context with dual retrieval + score fusion
	 */
	async retrieveSchemaContext(
		question: string,
		databaseId: string,
	): Promise<{ packet: SchemaContextPacket; metrics: RetrievalMetrics }> {
		const queryId = uuidv4()
		const startTime = Date.now()

		this.logger.info("Starting V2 schema retrieval", {
			query_id: queryId,
			question,
			database_id: databaseId,
		})

		let client: PoolClient | null = null
		const metrics: RetrievalMetrics = {
			query_id: queryId,
			question_length: question.length,
			embedding_latency_ms: 0,
			table_retrieval_count: 0,
			table_threshold_used: this.config.tableThreshold,
			table_similarities: [],
			column_retrieval_count: 0,
			column_threshold_used: this.config.columnThreshold,
			column_hits_per_table: {},
			top_columns_per_table: {},
			tables_from_table_retrieval: 0,
			tables_from_column_only: 0,
			fusion_weights: { table: this.config.tableWeight, column: this.config.columnWeight },
			fused_scores: [],
			fk_expansion_candidates: 0,
			fk_expansion_added: 0,
			fk_expansion_blocked_no_evidence: 0,
			fk_expansion_blocked: [],
			final_table_count: 0,
			final_tables: [],
			total_latency_ms: 0,
		}

		try {
			// Step 1: Embed the question
			const embedStart = Date.now()
			const embedding = await this.pythonClient.embedText(question)
			metrics.embedding_latency_ms = Date.now() - embedStart

			this.logger.debug("Question embedded", {
				query_id: queryId,
				dimensions: embedding.length,
				latency_ms: metrics.embedding_latency_ms,
			})

			client = await this.pool.connect()

			// Step 2: Retrieve similar tables
			const tableHits = await this.retrieveTables(
				client,
				databaseId,
				embedding,
			)
			metrics.table_retrieval_count = tableHits.length
			metrics.table_similarities = tableHits.map((t) => ({
				table: t.table_name,
				similarity: t.similarity,
			}))

			this.logger.debug("Table retrieval complete", {
				query_id: queryId,
				count: tableHits.length,
				top_tables: tableHits.slice(0, 5).map((t) => `${t.table_name}:${t.similarity.toFixed(3)}`),
			})

			// Step 3: Retrieve similar columns
			const columnHits = await this.retrieveColumns(
				client,
				databaseId,
				embedding,
			)
			metrics.column_retrieval_count = columnHits.length

			// Group column hits by table
			const columnsByTable = this.groupColumnsByTable(columnHits)
			for (const [table, cols] of columnsByTable) {
				metrics.column_hits_per_table[table] = cols.length
				// Record top 3 columns per table for diagnostics
				metrics.top_columns_per_table![table] = cols.slice(0, 3).map((c) => ({
					column: c.column_name,
					similarity: c.similarity,
				}))
			}

			this.logger.debug("Column retrieval complete", {
				query_id: queryId,
				count: columnHits.length,
				tables_with_hits: columnsByTable.size,
			})

			// Step 4: Aggregate column scores per table
			const columnScores = this.aggregateColumnScores(columnsByTable)

			// Step 5: Fuse table + column scores
			const fusedScores = this.fuseScores(tableHits, columnScores)

			// Count sources
			metrics.tables_from_table_retrieval = fusedScores.filter(
				(t) => t.table_similarity > 0,
			).length
			metrics.tables_from_column_only = fusedScores.filter(
				(t) => t.table_similarity === 0 && t.column_score > 0,
			).length

			// Record fused scores for diagnostics (top 15)
			metrics.fused_scores = fusedScores
				.sort((a, b) => b.fused_score - a.fused_score)
				.slice(0, 15)
				.map((t) => ({
					table: t.table_name,
					fused: t.fused_score,
					table_sim: t.table_similarity,
					col_score: t.column_score,
				}))

			this.logger.debug("Score fusion complete", {
				query_id: queryId,
				total_tables: fusedScores.length,
				from_table_retrieval: metrics.tables_from_table_retrieval,
				from_column_only: metrics.tables_from_column_only,
			})

			// Step 6: Select top N tables by fused score
			const topTables = fusedScores
				.sort((a, b) => b.fused_score - a.fused_score)
				.slice(0, this.config.maxTables)

			// Step 7: Build evidence set for FK gating
			const evidenceSet = this.buildEvidenceSet(fusedScores)

			// Step 8: FK expansion (relevance-gated)
			const expandedTables = await this.expandFKWithEvidence(
				client,
				databaseId,
				topTables,
				evidenceSet,
				metrics,
			)

			// Step 9: Get FK edges between selected tables
			const tableNames = expandedTables.map((t) => t.table_name)
			const fkEdges = await this.getFKEdges(client, tableNames)

			// Build SchemaContextPacket
			const packet = this.buildSchemaContextPacket(
				queryId,
				databaseId,
				question,
				embedding,
				expandedTables,
				fkEdges,
				metrics,
			)

			metrics.final_table_count = packet.tables.length
			metrics.final_tables = packet.tables.map((t) => t.table_name)
			metrics.total_latency_ms = Date.now() - startTime

			this.logger.info("V2 schema retrieval complete", {
				query_id: queryId,
				final_tables: metrics.final_table_count,
				modules: packet.modules,
				latency_ms: metrics.total_latency_ms,
			})

			return { packet, metrics }
		} finally {
			if (client) {
				client.release()
			}
		}
	}

	/**
	 * Retrieve similar tables from pgvector
	 */
	private async retrieveTables(
		client: PoolClient,
		databaseId: string,
		embedding: number[],
	): Promise<TableRetrievalHit[]> {
		const vectorLiteral = `[${embedding.join(",")}]`

		const query = `
			SELECT
				table_schema,
				table_name,
				module,
				gloss,
				m_schema_compact,
				1 - (embedding <=> $1::vector) AS similarity
			FROM rag.schema_embeddings
			WHERE database_id = $2
				AND entity_type = 'table'
				AND 1 - (embedding <=> $1::vector) >= $3
			ORDER BY embedding <=> $1::vector
			LIMIT $4
		`

		const result = await client.query(query, [
			vectorLiteral,
			databaseId,
			this.config.tableThreshold,
			this.config.tableTopK,
		])

		return result.rows.map((row) => ({
			table_schema: row.table_schema,
			table_name: row.table_name,
			module: row.module,
			gloss: row.gloss,
			m_schema_compact: row.m_schema_compact,
			similarity: parseFloat(row.similarity),
		}))
	}

	/**
	 * Retrieve similar columns from pgvector
	 */
	private async retrieveColumns(
		client: PoolClient,
		databaseId: string,
		embedding: number[],
	): Promise<ColumnRetrievalHit[]> {
		const vectorLiteral = `[${embedding.join(",")}]`

		const query = `
			SELECT
				table_schema,
				table_name,
				column_name,
				module,
				gloss,
				data_type,
				is_pk,
				is_fk,
				fk_target,
				is_generic,
				1 - (embedding <=> $1::vector) AS similarity
			FROM rag.schema_embeddings
			WHERE database_id = $2
				AND entity_type = 'column'
				AND 1 - (embedding <=> $1::vector) >= $3
			ORDER BY embedding <=> $1::vector
			LIMIT $4
		`

		const result = await client.query(query, [
			vectorLiteral,
			databaseId,
			this.config.columnThreshold,
			this.config.columnTopK,
		])

		return result.rows.map((row) => ({
			table_schema: row.table_schema,
			table_name: row.table_name,
			column_name: row.column_name,
			module: row.module,
			gloss: row.gloss,
			data_type: row.data_type,
			is_pk: row.is_pk,
			is_fk: row.is_fk,
			fk_target: row.fk_target,
			is_generic: row.is_generic,
			similarity: parseFloat(row.similarity),
		}))
	}

	/**
	 * Group column hits by table
	 */
	private groupColumnsByTable(
		columnHits: ColumnRetrievalHit[],
	): Map<string, ColumnRetrievalHit[]> {
		const byTable = new Map<string, ColumnRetrievalHit[]>()

		for (const col of columnHits) {
			const existing = byTable.get(col.table_name) || []
			existing.push(col)
			byTable.set(col.table_name, existing)
		}

		// Sort each table's columns by similarity descending
		for (const [table, cols] of byTable) {
			cols.sort((a, b) => b.similarity - a.similarity)
		}

		return byTable
	}

	/**
	 * Aggregate column scores per table
	 *
	 * Formula: colScore = top1 + 0.5*top2, with generic downweight
	 */
	private aggregateColumnScores(
		columnsByTable: Map<string, ColumnRetrievalHit[]>,
	): Map<string, TableColumnScore> {
		const scores = new Map<string, TableColumnScore>()

		for (const [tableName, columns] of columnsByTable) {
			// Apply generic downweight
			const weightedColumns = columns.map((col) => ({
				...col,
				weighted_similarity: col.is_generic
					? col.similarity * this.config.genericDownweight
					: col.similarity,
			}))

			// Sort by weighted similarity
			weightedColumns.sort((a, b) => b.weighted_similarity - a.weighted_similarity)

			const top1 = weightedColumns[0]?.weighted_similarity || 0
			const top2 = weightedColumns[1]?.weighted_similarity || 0

			const aggregatedScore = top1 + 0.5 * top2

			scores.set(tableName, {
				table_name: tableName,
				top1_similarity: top1,
				top2_similarity: top2,
				column_hits: columns,
				aggregated_score: aggregatedScore,
			})
		}

		return scores
	}

	/**
	 * Fuse table retrieval scores with column aggregation scores
	 *
	 * Formula: fusedScore = 0.6*tableScore + 0.4*colScore
	 */
	private fuseScores(
		tableHits: TableRetrievalHit[],
		columnScores: Map<string, TableColumnScore>,
	): FusedTableScore[] {
		const fusedMap = new Map<string, FusedTableScore>()

		// Add all tables from table retrieval
		for (const table of tableHits) {
			const colScore = columnScores.get(table.table_name)

			fusedMap.set(table.table_name, {
				table_name: table.table_name,
				table_schema: table.table_schema,
				module: table.module,
				gloss: table.gloss,
				m_schema_compact: table.m_schema_compact,
				table_similarity: table.similarity,
				column_score: colScore?.aggregated_score || 0,
				fused_score:
					this.config.tableWeight * table.similarity +
					this.config.columnWeight * (colScore?.aggregated_score || 0),
				source: "retrieval",
				column_hits: colScore?.column_hits || [],
			})
		}

		// Add tables that only have column hits (not in table retrieval)
		for (const [tableName, colScore] of columnScores) {
			if (!fusedMap.has(tableName)) {
				// Need to get table metadata from column hits
				const firstCol = colScore.column_hits[0]
				if (firstCol) {
					fusedMap.set(tableName, {
						table_name: tableName,
						table_schema: firstCol.table_schema,
						module: firstCol.module,
						gloss: `Table with relevant columns: ${colScore.column_hits.slice(0, 3).map((c) => c.column_name).join(", ")}`,
						m_schema_compact: "", // Will need to fetch this
						table_similarity: 0,
						column_score: colScore.aggregated_score,
						fused_score: this.config.columnWeight * colScore.aggregated_score,
						source: "column_only",
						column_hits: colScore.column_hits,
					})
				}
			}
		}

		return Array.from(fusedMap.values())
	}

	/**
	 * Build evidence set for FK gating
	 *
	 * Tables in evidence set have retrieval signal and can receive FK expansions.
	 */
	private buildEvidenceSet(fusedScores: FusedTableScore[]): EvidenceSet {
		const tables = new Set<string>()

		// Sort by fused score and take top K
		const sorted = [...fusedScores].sort((a, b) => b.fused_score - a.fused_score)
		const topK = sorted.slice(0, this.config.fkEvidenceTopK)

		for (const table of topK) {
			if (table.fused_score >= this.config.fkEvidenceThreshold) {
				tables.add(table.table_name)
			}
		}

		return {
			tables,
			minScore: this.config.fkEvidenceThreshold,
		}
	}

	/**
	 * FK expansion with relevance gating
	 *
	 * Only adds FK neighbors if they have retrieval evidence.
	 */
	private async expandFKWithEvidence(
		client: PoolClient,
		databaseId: string,
		selectedTables: FusedTableScore[],
		evidenceSet: EvidenceSet,
		metrics: RetrievalMetrics,
	): Promise<FusedTableScore[]> {
		const selectedNames = new Set(selectedTables.map((t) => t.table_name))
		const expandedTables = [...selectedTables]
		let addedCount = 0

		// Get FK relationships for selected tables
		const tableNames = selectedTables.map((t) => t.table_name)
		const fkQuery = `
			SELECT DISTINCT
				CASE
					WHEN fk.table_name = ANY($1) THEN fk.ref_table_name
					ELSE fk.table_name
				END AS related_table,
				se.table_schema,
				se.module,
				se.gloss,
				se.m_schema_compact
			FROM rag.schema_fks fk
			LEFT JOIN rag.schema_embeddings se
				ON se.table_name = (
					CASE
						WHEN fk.table_name = ANY($1) THEN fk.ref_table_name
						ELSE fk.table_name
					END
				)
				AND se.database_id = $2
				AND se.entity_type = 'table'
			WHERE (fk.table_name = ANY($1) OR fk.ref_table_name = ANY($1))
				AND NOT (fk.table_name = ANY($1) AND fk.ref_table_name = ANY($1))
		`

		const fkResult = await client.query(fkQuery, [tableNames, databaseId])
		metrics.fk_expansion_candidates = fkResult.rows.length

		for (const row of fkResult.rows) {
			const relatedTable = row.related_table

			// Skip if already selected
			if (selectedNames.has(relatedTable)) {
				metrics.fk_expansion_blocked.push({
					table: relatedTable,
					reason: "already_selected",
				})
				continue
			}

			// Check evidence gate
			if (!evidenceSet.tables.has(relatedTable)) {
				metrics.fk_expansion_blocked_no_evidence++
				metrics.fk_expansion_blocked.push({
					table: relatedTable,
					reason: "no_evidence",
				})
				this.logger.debug("FK expansion blocked (no evidence)", {
					table: relatedTable,
				})
				continue
			}

			// Check expansion cap
			if (addedCount >= this.config.fkExpansionCap) {
				metrics.fk_expansion_blocked.push({
					table: relatedTable,
					reason: "cap_reached",
				})
				continue
			}

			// Check final max
			if (expandedTables.length >= this.config.finalMaxTables) {
				metrics.fk_expansion_blocked.push({
					table: relatedTable,
					reason: "max_tables",
				})
				continue
			}

			// Add to expanded tables
			selectedNames.add(relatedTable)
			expandedTables.push({
				table_name: relatedTable,
				table_schema: row.table_schema || "public",
				module: row.module,
				gloss: row.gloss || "",
				m_schema_compact: row.m_schema_compact || "",
				table_similarity: 0,
				column_score: 0,
				fused_score: 0, // FK expansion has no direct score
				source: "fk_expansion",
				column_hits: [],
			})
			addedCount++
			metrics.fk_expansion_added++
		}

		return expandedTables
	}

	/**
	 * Get FK edges between selected tables
	 */
	private async getFKEdges(
		client: PoolClient,
		tableNames: string[],
	): Promise<
		Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>
	> {
		if (tableNames.length < 2) {
			return []
		}

		const query = `
			SELECT
				table_name AS from_table,
				column_name AS from_column,
				ref_table_name AS to_table,
				ref_column_name AS to_column
			FROM rag.schema_fks
			WHERE table_name = ANY($1)
				AND ref_table_name = ANY($1)
		`

		const result = await client.query(query, [tableNames])
		return result.rows
	}

	/**
	 * Build join hints from FK edges
	 * Format: "schemaA.tableA.colA → schemaB.tableB.colB"
	 */
	private buildJoinHints(
		fkEdges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>,
		tables: FusedTableScore[],
	): JoinHint[] {
		const hints: JoinHint[] = []
		const tableSchemas = new Map<string, string>()

		// Build table -> schema lookup
		for (const table of tables) {
			tableSchemas.set(table.table_name, table.table_schema)
		}

		// Convert FK edges to join hints (max 15)
		for (const edge of fkEdges.slice(0, 15)) {
			const fromSchema = tableSchemas.get(edge.from_table) || "public"
			const toSchema = tableSchemas.get(edge.to_table) || "public"

			hints.push({
				from: `${fromSchema}.${edge.from_table}.${edge.from_column}`,
				to: `${toSchema}.${edge.to_table}.${edge.to_column}`,
				description: `Join ${edge.from_table} to ${edge.to_table}`,
			})
		}

		return hints
	}

	/**
	 * Compute suggested join paths for common multi-hop scenarios
	 * Finds bridge tables connecting selected tables
	 */
	private computeJoinPaths(
		fkEdges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>,
		tables: FusedTableScore[],
	): JoinPath[] {
		const paths: JoinPath[] = []
		const tableNames = new Set(tables.map((t) => t.table_name))

		// Build adjacency for FK graph
		const outgoing = new Map<string, Array<{ table: string; from_col: string; to_col: string }>>()
		const incoming = new Map<string, Array<{ table: string; from_col: string; to_col: string }>>()

		for (const edge of fkEdges) {
			// from_table has FK pointing to to_table
			if (!outgoing.has(edge.from_table)) {
				outgoing.set(edge.from_table, [])
			}
			outgoing.get(edge.from_table)!.push({
				table: edge.to_table,
				from_col: edge.from_column,
				to_col: edge.to_column,
			})

			if (!incoming.has(edge.to_table)) {
				incoming.set(edge.to_table, [])
			}
			incoming.get(edge.to_table)!.push({
				table: edge.from_table,
				from_col: edge.from_column,
				to_col: edge.to_column,
			})
		}

		// Find 2-hop paths through bridge tables
		// Pattern: A → B → C where B is a junction/bridge table
		const addedPaths = new Set<string>()

		for (const tableA of tableNames) {
			const aOutgoing = outgoing.get(tableA) || []

			for (const linkAB of aOutgoing) {
				const tableB = linkAB.table
				if (!tableNames.has(tableB)) continue

				const bOutgoing = outgoing.get(tableB) || []
				for (const linkBC of bOutgoing) {
					const tableC = linkBC.table
					if (!tableNames.has(tableC) || tableC === tableA) continue

					const pathKey = `${tableA}-${tableB}-${tableC}`
					if (addedPaths.has(pathKey)) continue
					addedPaths.add(pathKey)

					paths.push({
						path: `${tableA} → ${tableB} → ${tableC}`,
						tables: [tableA, tableB, tableC],
						conditions: [
							`${tableA}.${linkAB.from_col} = ${tableB}.${linkAB.to_col}`,
							`${tableB}.${linkBC.from_col} = ${tableC}.${linkBC.to_col}`,
						],
					})
				}
			}
		}

		// Return max 3 join paths
		return paths.slice(0, 3)
	}

	/**
	 * Build SchemaContextPacket from retrieval results
	 */
	private buildSchemaContextPacket(
		queryId: string,
		databaseId: string,
		question: string,
		embedding: number[],
		tables: FusedTableScore[],
		fkEdges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>,
		metrics: RetrievalMetrics,
	): SchemaContextPacket {
		// Build table entries for packet
		const packetTables = tables.map((t) => ({
			table_name: t.table_name,
			table_schema: t.table_schema,
			module: t.module || "default",
			gloss: t.gloss,
			m_schema: t.m_schema_compact, // Use m_schema_compact as m_schema for backward compat
			similarity: t.fused_score,
			source: t.source === "fk_expansion" ? "fk_expansion" as const : "retrieval" as const,
			is_hub: false, // TODO: Add hub detection
		}))

		// Extract unique modules
		const modules = [...new Set(packetTables.map((t) => t.module))]

		// Build join hints from FK edges (V2)
		const joinHints = this.buildJoinHints(fkEdges, tables)

		// Compute suggested join paths (V2)
		const joinPaths = this.computeJoinPaths(fkEdges, tables)

		this.logger.debug("Built join hints and paths", {
			query_id: queryId,
			join_hints_count: joinHints.length,
			join_paths_count: joinPaths.length,
		})

		return {
			query_id: queryId,
			database_id: databaseId,
			question,
			question_embedding: embedding,
			tables: packetTables,
			fk_edges: fkEdges,
			join_hints: joinHints,
			join_paths: joinPaths,
			modules,
			retrieval_meta: {
				total_candidates: metrics.table_retrieval_count + metrics.tables_from_column_only,
				threshold_used: this.config.tableThreshold,
				tables_from_retrieval: metrics.tables_from_table_retrieval,
				tables_from_fk_expansion: metrics.fk_expansion_added,
				hub_tables_capped: [],
			},
			created_at: new Date().toISOString(),
		}
	}

	/**
	 * Fetch m_schema_compact for tables that only had column hits
	 */
	async fetchMissingMSchema(
		client: PoolClient,
		databaseId: string,
		tableNames: string[],
	): Promise<Map<string, string>> {
		if (tableNames.length === 0) {
			return new Map()
		}

		const query = `
			SELECT table_name, m_schema_compact
			FROM rag.schema_embeddings
			WHERE database_id = $1
				AND entity_type = 'table'
				AND table_name = ANY($2)
		`

		const result = await client.query(query, [databaseId, tableNames])
		const mSchemaMap = new Map<string, string>()

		for (const row of result.rows) {
			mSchemaMap.set(row.table_name, row.m_schema_compact)
		}

		return mSchemaMap
	}
}

// ============================================================================
// Singleton
// ============================================================================

let defaultRetrieverV2: SchemaRetrieverV2 | null = null

export function getSchemaRetrieverV2(
	pool: Pool,
	logger: { info: Function; error: Function; warn: Function; debug: Function },
	config?: Partial<RetrievalConfigV2>,
): SchemaRetrieverV2 {
	if (!defaultRetrieverV2) {
		defaultRetrieverV2 = new SchemaRetrieverV2(pool, logger, config)
	}
	return defaultRetrieverV2
}

export function resetSchemaRetrieverV2(): void {
	defaultRetrieverV2 = null
}

// ============================================================================
// Utility: Get allowed table names from schema context
// ============================================================================

export function getAllowedTablesV2(packet: SchemaContextPacket): string[] {
	return packet.tables.map((t) => t.table_name)
}
