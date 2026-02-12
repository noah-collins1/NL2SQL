/**
 * Schema RAG Retriever
 *
 * Phase C + Phase 1: Retrieval integration for enterprise ERP database.
 *
 * Flow:
 * 1. Embed user question via Python sidecar
 * 2. Query pgvector for top-K similar tables (cosine)
 * 3. Query BM25 full-text search (tsvector)
 * 4. Fuse results with Reciprocal Rank Fusion (RRF)
 * 5. Expand FK relationships (bounded for hub tables)
 * 6. Fetch column metadata for selected tables
 * 7. Build SchemaContextPacket with M-Schema format
 */

import { Pool, PoolClient } from "pg"
import { v4 as uuidv4 } from "uuid"
import { getPythonClient, PythonClient } from "./python_client.js"
import {
	SchemaContextPacket,
	TableMeta,
	ColumnMeta,
	RetrievedTable,
	RetrievalConfig,
	DEFAULT_RETRIEVAL_CONFIG,
	renderMSchema,
} from "./schema_types.js"
import { BM25_SEARCH_ENABLED, bm25Search, rrfFuse, BM25Result } from "./bm25_search.js"

/**
 * Schema Retriever for RAG-based table selection
 */
export class SchemaRetriever {
	private pool: Pool
	private pythonClient: PythonClient
	private config: RetrievalConfig
	private logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}

	constructor(
		pool: Pool,
		logger: { info: Function; error: Function; warn: Function; debug: Function },
		config?: Partial<RetrievalConfig>,
	) {
		this.pool = pool
		this.pythonClient = getPythonClient()
		this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config }
		this.logger = logger
	}

	/**
	 * Retrieve schema context for a natural language question
	 *
	 * Main entry point for schema retrieval.
	 */
	async retrieveSchemaContext(
		question: string,
		databaseId: string,
		options?: {
			moduleFilter?: string[]
		},
	): Promise<SchemaContextPacket & { _bm25Tables?: string[]; _fusionMethod?: string }> {
		const queryId = uuidv4()
		const startTime = Date.now()
		const moduleFilter = options?.moduleFilter

		this.logger.info("Starting schema retrieval", {
			query_id: queryId,
			question,
			database_id: databaseId,
			module_filter: moduleFilter,
			bm25_enabled: BM25_SEARCH_ENABLED,
		})

		let client: PoolClient | null = null

		try {
			// Step 1: Embed the question
			this.logger.debug("Embedding question", { query_id: queryId })
			const embedding = await this.pythonClient.embedText(question)
			const embedLatency = Date.now() - startTime

			this.logger.debug("Question embedded", {
				query_id: queryId,
				dimensions: embedding.length,
				latency_ms: embedLatency,
			})

			// Step 2: Query pgvector for similar tables (cosine)
			client = await this.pool.connect()

			const retrievalStart = Date.now()
			const cosineResults = await this.retrieveSimilarTables(
				client,
				embedding,
				this.config.topK,
				this.config.threshold,
				moduleFilter,
			)

			this.logger.debug("Cosine retrieval complete", {
				query_id: queryId,
				tables_retrieved: cosineResults.length,
				top_tables: cosineResults.slice(0, 5).map((t) => ({
					name: t.table_name,
					similarity: t.similarity.toFixed(3),
				})),
			})

			// Step 3: BM25 full-text search (if enabled)
			let bm25Results: BM25Result[] = []
			let fusionMethod = "cosine_only"

			if (BM25_SEARCH_ENABLED) {
				bm25Results = await bm25Search(
					client,
					question,
					this.config.topK,
					moduleFilter,
					this.logger,
				)

				this.logger.debug("BM25 retrieval complete", {
					query_id: queryId,
					tables_retrieved: bm25Results.length,
					top_tables: bm25Results.slice(0, 5).map(t => ({
						name: t.table_name,
						rank: t.rank.toFixed(4),
					})),
				})
			}

			// Step 4: Fuse results with RRF (or use cosine-only)
			let retrievedTables: RetrievedTable[]

			if (BM25_SEARCH_ENABLED && bm25Results.length > 0) {
				retrievedTables = rrfFuse(cosineResults, bm25Results, {
					k: 60,
					maxTables: this.config.topK,
				})
				fusionMethod = "rrf"

				this.logger.debug("RRF fusion complete", {
					query_id: queryId,
					cosine_count: cosineResults.length,
					bm25_count: bm25Results.length,
					fused_count: retrievedTables.length,
					hybrid_count: retrievedTables.filter(t => t.source === "hybrid").length,
					bm25_only_count: retrievedTables.filter(t => t.source === "bm25").length,
				})
			} else {
				retrievedTables = cosineResults
			}

			// Step 5: FK Expansion
			const expandedTables = await this.expandFKRelationships(
				client,
				retrievedTables,
				this.config.fkExpansionLimit,
				this.config.maxTables,
			)

			this.logger.debug("FK expansion complete", {
				query_id: queryId,
				tables_before: retrievedTables.length,
				tables_after: expandedTables.length,
			})

			// Step 6: Fetch full metadata for selected tables
			const tableNames = expandedTables.map((t) => t.table_name)
			const tableMetas = await this.fetchTableMetadata(client, tableNames)

			// Step 7: Get FK edges between selected tables
			const fkEdges = await this.getFKEdges(client, tableNames)

			// Step 8: Build SchemaContextPacket
			const packet = this.buildSchemaContextPacket(
				queryId,
				databaseId,
				question,
				embedding,
				expandedTables,
				tableMetas,
				fkEdges,
				retrievedTables.length,
			)

			const totalLatency = Date.now() - startTime
			this.logger.info("Schema retrieval complete", {
				query_id: queryId,
				tables_selected: packet.tables.length,
				modules: packet.modules,
				fusion_method: fusionMethod,
				latency_ms: totalLatency,
			})

			// Attach diagnostics metadata for exam logging
			const enrichedPacket = packet as SchemaContextPacket & { _bm25Tables?: string[]; _fusionMethod?: string }
			enrichedPacket._bm25Tables = bm25Results.map(t => t.table_name)
			enrichedPacket._fusionMethod = fusionMethod

			return enrichedPacket
		} finally {
			if (client) {
				client.release()
			}
		}
	}

	/**
	 * Query pgvector for similar tables
	 */
	private async retrieveSimilarTables(
		client: PoolClient,
		embedding: number[],
		topK: number,
		threshold: number,
		moduleFilter?: string[],
	): Promise<RetrievedTable[]> {
		// Format embedding as PostgreSQL vector literal
		const vectorLiteral = `[${embedding.join(",")}]`

		const hasModuleFilter = moduleFilter && moduleFilter.length > 0

		const query = hasModuleFilter
			? `
				SELECT
					se.table_name,
					se.table_schema,
					st.module,
					st.table_gloss,
					st.fk_degree,
					st.is_hub,
					1 - (se.embedding <=> $1::vector) AS similarity
				FROM rag.schema_embeddings se
				JOIN rag.schema_tables st
					ON se.table_name = st.table_name
					AND se.table_schema = st.table_schema
				WHERE se.entity_type = 'table'
					AND 1 - (se.embedding <=> $1::vector) >= $2
					AND st.module = ANY($4)
				ORDER BY se.embedding <=> $1::vector
				LIMIT $3
			`
			: `
				SELECT
					se.table_name,
					se.table_schema,
					st.module,
					st.table_gloss,
					st.fk_degree,
					st.is_hub,
					1 - (se.embedding <=> $1::vector) AS similarity
				FROM rag.schema_embeddings se
				JOIN rag.schema_tables st
					ON se.table_name = st.table_name
					AND se.table_schema = st.table_schema
				WHERE se.entity_type = 'table'
					AND 1 - (se.embedding <=> $1::vector) >= $2
				ORDER BY se.embedding <=> $1::vector
				LIMIT $3
			`

		const params: any[] = hasModuleFilter
			? [vectorLiteral, threshold, topK, moduleFilter]
			: [vectorLiteral, threshold, topK]

		const result = await client.query(query, params)

		return result.rows.map((row: any) => ({
			table_name: row.table_name,
			table_schema: row.table_schema,
			module: row.module,
			table_gloss: row.table_gloss,
			similarity: parseFloat(row.similarity),
			source: "retrieval" as const,
			fk_degree: row.fk_degree,
			is_hub: row.is_hub,
		}))
	}

	/**
	 * Expand FK relationships for retrieved tables
	 *
	 * Bounded expansion:
	 * - Hub tables (fk_degree > 8): cap at hubFKCap FKs
	 * - Normal tables: include all direct FKs
	 */
	private async expandFKRelationships(
		client: PoolClient,
		retrievedTables: RetrievedTable[],
		expansionLimit: number,
		maxTables: number,
	): Promise<RetrievedTable[]> {
		const selectedTableNames = new Set(retrievedTables.map((t) => t.table_name))
		const expandedTables: RetrievedTable[] = [...retrievedTables]
		const hubTablesCapped: string[] = []

		// Sort by similarity descending for prioritized expansion
		const sortedTables = [...retrievedTables].sort(
			(a, b) => b.similarity - a.similarity,
		)

		// Expand top tables (respect expansionLimit)
		const tablesToExpand = sortedTables.slice(0, expansionLimit)

		for (const table of tablesToExpand) {
			if (expandedTables.length >= maxTables) {
				break
			}

			// Get FK relationships for this table
			const fkQuery = `
				SELECT
					fk.ref_table_name AS related_table,
					st.table_schema,
					st.module,
					st.table_gloss,
					st.fk_degree,
					st.is_hub
				FROM rag.schema_fks fk
				JOIN rag.schema_tables st
					ON fk.ref_table_name = st.table_name
				WHERE fk.table_name = $1
					AND fk.ref_table_name != $1

				UNION

				SELECT
					fk.table_name AS related_table,
					st.table_schema,
					st.module,
					st.table_gloss,
					st.fk_degree,
					st.is_hub
				FROM rag.schema_fks fk
				JOIN rag.schema_tables st
					ON fk.table_name = st.table_name
				WHERE fk.ref_table_name = $1
					AND fk.table_name != $1
			`

			const fkResult = await client.query(fkQuery, [table.table_name])
			let relatedTables = fkResult.rows

			// Hub table capping
			if (table.is_hub && relatedTables.length > this.config.hubFKCap) {
				hubTablesCapped.push(table.table_name)
				// Prioritize non-hub related tables first
				relatedTables = relatedTables
					.sort((a, b) => {
						// Non-hubs first
						if (a.is_hub !== b.is_hub) return a.is_hub ? 1 : -1
						// Then by fk_degree ascending
						return a.fk_degree - b.fk_degree
					})
					.slice(0, this.config.hubFKCap)
			}

			for (const related of relatedTables) {
				if (expandedTables.length >= maxTables) {
					break
				}

				if (!selectedTableNames.has(related.related_table)) {
					selectedTableNames.add(related.related_table)
					expandedTables.push({
						table_name: related.related_table,
						table_schema: related.table_schema,
						module: related.module,
						table_gloss: related.table_gloss,
						similarity: table.similarity * 0.8, // Decay for FK expansion
						source: "fk_expansion",
						fk_degree: related.fk_degree,
						is_hub: related.is_hub,
					})
				}
			}
		}

		return expandedTables
	}

	/**
	 * Fetch full metadata for selected tables
	 */
	private async fetchTableMetadata(
		client: PoolClient,
		tableNames: string[],
	): Promise<Map<string, TableMeta>> {
		if (tableNames.length === 0) {
			return new Map()
		}

		// Fetch table info
		const tableQuery = `
			SELECT
				table_schema,
				table_name,
				module,
				table_gloss,
				fk_degree,
				is_hub
			FROM rag.schema_tables
			WHERE table_name = ANY($1)
		`
		const tableResult = await client.query(tableQuery, [tableNames])

		// Fetch columns for all tables
		const columnQuery = `
			SELECT
				table_name,
				column_name,
				data_type,
				is_pk,
				is_fk,
				fk_target_table,
				fk_target_column,
				inferred_gloss,
				ordinal_pos
			FROM rag.schema_columns
			WHERE table_name = ANY($1)
			ORDER BY table_name, ordinal_pos
		`
		const columnResult = await client.query(columnQuery, [tableNames])

		// Group columns by table
		const columnsByTable = new Map<string, ColumnMeta[]>()
		for (const row of columnResult.rows) {
			const existing = columnsByTable.get(row.table_name) || []
			existing.push({
				column_name: row.column_name,
				data_type: row.data_type,
				is_pk: row.is_pk,
				is_fk: row.is_fk,
				fk_target_table: row.fk_target_table,
				fk_target_column: row.fk_target_column,
				inferred_gloss: row.inferred_gloss,
				ordinal_pos: row.ordinal_pos,
			})
			columnsByTable.set(row.table_name, existing)
		}

		// Build TableMeta map
		const result = new Map<string, TableMeta>()
		for (const row of tableResult.rows) {
			result.set(row.table_name, {
				table_schema: row.table_schema,
				table_name: row.table_name,
				module: row.module,
				table_gloss: row.table_gloss,
				fk_degree: row.fk_degree,
				is_hub: row.is_hub,
				columns: columnsByTable.get(row.table_name) || [],
			})
		}

		return result
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
	 * Build SchemaContextPacket from retrieved data
	 */
	private buildSchemaContextPacket(
		queryId: string,
		databaseId: string,
		question: string,
		embedding: number[],
		retrievedTables: RetrievedTable[],
		tableMetas: Map<string, TableMeta>,
		fkEdges: Array<{
			from_table: string
			from_column: string
			to_table: string
			to_column: string
		}>,
		totalCandidates: number,
	): SchemaContextPacket {
		// Build table entries with M-Schema
		const tables = retrievedTables.map((rt) => {
			const meta = tableMetas.get(rt.table_name)
			if (!meta) {
				// Fallback if metadata not found
				return {
					table_name: rt.table_name,
					table_schema: rt.table_schema,
					module: rt.module,
					gloss: rt.table_gloss,
					m_schema: `${rt.table_name} (...)`,
					similarity: rt.similarity,
					source: rt.source,
					is_hub: rt.is_hub,
				}
			}

			return {
				table_name: meta.table_name,
				table_schema: meta.table_schema,
				module: meta.module,
				gloss: meta.table_gloss,
				m_schema: renderMSchema(meta),
				similarity: rt.similarity,
				source: rt.source,
				is_hub: meta.is_hub,
			}
		})

		// Extract unique modules
		const modules = [...new Set(tables.map((t) => t.module))]

		// Count sources
		const tablesFromRetrieval = tables.filter(
			(t) => t.source === "retrieval",
		).length
		const tablesFromFKExpansion = tables.filter(
			(t) => t.source === "fk_expansion",
		).length
		const hubTablesCapped = tables
			.filter((t) => t.is_hub && t.source === "retrieval")
			.map((t) => t.table_name)

		return {
			query_id: queryId,
			database_id: databaseId,
			question,
			question_embedding: embedding,
			tables,
			fk_edges: fkEdges,
			modules,
			retrieval_meta: {
				total_candidates: totalCandidates,
				threshold_used: this.config.threshold,
				tables_from_retrieval: tablesFromRetrieval,
				tables_from_fk_expansion: tablesFromFKExpansion,
				hub_tables_capped: hubTablesCapped,
			},
			created_at: new Date().toISOString(),
		}
	}
}

/**
 * Get allowed table names from schema context
 *
 * Used for SQL validator allowlist
 */
export function getAllowedTables(packet: SchemaContextPacket): string[] {
	return packet.tables.map((t) => t.table_name)
}

/**
 * Singleton retriever instance
 */
let defaultRetriever: SchemaRetriever | null = null

export function getSchemaRetriever(
	pool: Pool,
	logger: { info: Function; error: Function; warn: Function; debug: Function },
	config?: Partial<RetrievalConfig>,
): SchemaRetriever {
	if (!defaultRetriever) {
		defaultRetriever = new SchemaRetriever(pool, logger, config)
	}
	return defaultRetriever
}

export function resetSchemaRetriever(): void {
	defaultRetriever = null
}
