/**
 * Schema RAG Retriever + BM25 Search + RRF Fusion + Module Router
 *
 * Consolidated retrieval module combining:
 * - schema_retriever.ts — V1 RAG retriever (pgvector cosine + FK expansion)
 * - bm25_search.ts — BM25 tsvector search + RRF fusion
 * - module_router.ts — Question → module classification (keyword + embedding)
 *
 * Flow:
 * 1. Embed user question via Python sidecar
 * 2. [Optional] Route to 1-3 modules (keyword + embedding)
 * 3. Query pgvector for top-K similar tables (cosine)
 * 4. Query BM25 full-text search (tsvector)
 * 5. Fuse results with Reciprocal Rank Fusion (RRF)
 * 6. Expand FK relationships (bounded for hub tables)
 * 7. Fetch column metadata for selected tables
 * 8. Build SchemaContextPacket with M-Schema format
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
import { getConfig } from "./config/loadConfig.js"

// ============================================================================
// Feature Flags
// ============================================================================

export const BM25_SEARCH_ENABLED = process.env.BM25_SEARCH_ENABLED !== undefined
	? process.env.BM25_SEARCH_ENABLED !== "false"
	: getConfig().features.bm25

export const MODULE_ROUTER_ENABLED = process.env.MODULE_ROUTER_ENABLED !== undefined
	? process.env.MODULE_ROUTER_ENABLED !== "false"
	: getConfig().features.module_router

// ============================================================================
// BM25 Search Types & Implementation
// ============================================================================

export interface BM25Result {
	table_name: string
	table_schema: string
	module: string
	table_gloss: string
	rank: number
	fk_degree: number
	is_hub: boolean
}

/**
 * Full-text search on rag.schema_tables.search_vector
 * Returns tables ranked by BM25-style ts_rank
 */
export async function bm25Search(
	client: PoolClient,
	question: string,
	topK: number,
	moduleFilter?: string[],
	logger?: { warn: Function; debug: Function },
): Promise<BM25Result[]> {
	try {
		const colCheck = await client.query(`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = 'rag' AND table_name = 'schema_tables' AND column_name = 'search_vector'
		`)
		if (colCheck.rows.length === 0) {
			logger?.warn("BM25: search_vector column not found, skipping BM25 search")
			return []
		}
	} catch (err) {
		logger?.warn("BM25: Failed to check search_vector column", { error: String(err) })
		return []
	}

	const hasModuleFilter = moduleFilter && moduleFilter.length > 0

	const query = hasModuleFilter
		? `
			SELECT
				st.table_name, st.table_schema, st.module, st.table_gloss,
				st.fk_degree, st.is_hub,
				ts_rank(st.search_vector, plainto_tsquery('english', $1)) AS rank
			FROM rag.schema_tables st
			WHERE st.search_vector @@ plainto_tsquery('english', $1)
				AND st.module = ANY($3)
			ORDER BY rank DESC
			LIMIT $2
		`
		: `
			SELECT
				st.table_name, st.table_schema, st.module, st.table_gloss,
				st.fk_degree, st.is_hub,
				ts_rank(st.search_vector, plainto_tsquery('english', $1)) AS rank
			FROM rag.schema_tables st
			WHERE st.search_vector @@ plainto_tsquery('english', $1)
			ORDER BY rank DESC
			LIMIT $2
		`

	const params: any[] = hasModuleFilter
		? [question, topK, moduleFilter]
		: [question, topK]

	try {
		const result = await client.query(query, params)
		return result.rows.map((row: any) => ({
			table_name: row.table_name,
			table_schema: row.table_schema,
			module: row.module,
			table_gloss: row.table_gloss || "",
			rank: parseFloat(row.rank),
			fk_degree: row.fk_degree,
			is_hub: row.is_hub,
		}))
	} catch (err) {
		logger?.warn("BM25: search query failed", { error: String(err) })
		return []
	}
}

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Combines cosine similarity results with BM25 results using:
 * score(table) = 1/(k + rank_cosine) + 1/(k + rank_bm25)
 *
 * k=60 is standard (from the original RRF paper)
 */
export function rrfFuse(
	cosineResults: RetrievedTable[],
	bm25Results: BM25Result[],
	config: { k: number; maxTables: number },
): RetrievedTable[] {
	const k = config.k
	const scores = new Map<string, {
		rrfScore: number
		table: RetrievedTable
		inCosine: boolean
		inBm25: boolean
	}>()

	for (let i = 0; i < cosineResults.length; i++) {
		const t = cosineResults[i]
		const rrfScore = 1 / (k + i + 1)
		scores.set(t.table_name, {
			rrfScore,
			table: t,
			inCosine: true,
			inBm25: false,
		})
	}

	const missingRankCosine = cosineResults.length + 1
	for (let i = 0; i < bm25Results.length; i++) {
		const b = bm25Results[i]
		const bm25RrfScore = 1 / (k + i + 1)
		const existing = scores.get(b.table_name)

		if (existing) {
			existing.rrfScore += bm25RrfScore
			existing.inBm25 = true
		} else {
			const cosineRrfScore = 1 / (k + missingRankCosine)
			scores.set(b.table_name, {
				rrfScore: cosineRrfScore + bm25RrfScore,
				table: {
					table_name: b.table_name,
					table_schema: b.table_schema,
					module: b.module,
					table_gloss: b.table_gloss,
					similarity: 0,
					source: "bm25" as any,
					fk_degree: b.fk_degree,
					is_hub: b.is_hub,
				},
				inCosine: false,
				inBm25: true,
			})
		}
	}

	const sorted = [...scores.values()]
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.slice(0, config.maxTables)

	return sorted.map(entry => {
		let source: string
		if (entry.inCosine && entry.inBm25) {
			source = "hybrid"
		} else if (entry.inBm25) {
			source = "bm25"
		} else {
			source = "retrieval"
		}

		return {
			...entry.table,
			similarity: entry.table.similarity || entry.rrfScore,
			source: source as any,
		}
	})
}

// ============================================================================
// Module Router Types & Implementation
// ============================================================================

export interface ModuleRouteResult {
	modules: string[]
	confidences: number[]
	method: "keyword" | "embedding" | "hybrid"
}

const MODULE_KEYWORDS: Record<string, string[]> = {
	HR: ["employee", "employees", "salary", "salaries", "leave", "leaves", "benefit", "benefits", "department", "departments", "hire", "hired", "hiring", "training", "trainings", "attendance", "payroll"],
	Finance: ["journal", "ledger", "account", "accounts", "fiscal", "budget", "budgets", "bank", "tax", "taxes", "payment", "payments", "receivable", "payable", "financial", "revenue", "expense", "expenses", "invoice", "invoices", "ar", "ap", "depreciation", "gl", "posting", "period"],
	Sales: ["customer", "customers", "order", "orders", "sales", "sale", "quote", "quotes", "opportunity", "opportunities", "revenue", "territory", "territories", "representative", "representatives"],
	Procurement: ["vendor", "vendors", "purchase", "purchases", "requisition", "requisitions", "invoice", "invoices", "supplier", "suppliers", "procurement"],
	Inventory: ["warehouse", "warehouses", "product", "products", "stock", "inventory", "transfer", "transfers", "reorder", "item", "items"],
	Projects: ["project", "projects", "task", "tasks", "milestone", "milestones", "timesheet", "timesheets", "resource", "resources", "phase", "phases"],
	Assets: ["asset", "assets", "maintenance", "fixed"],
	Common: ["country", "countries", "state", "states", "city", "cities", "address", "addresses", "currency", "currencies", "audit", "region", "regions"],
	Manufacturing: ["bom", "work order", "work orders", "manufacturing", "scrap", "quality", "routing", "work center"],
	Services: ["sow", "statement of work", "deliverable", "deliverables", "engagement", "billing milestone", "rate card", "skill matrix"],
	Retail: ["pos", "point of sale", "loyalty", "promotion", "promotions", "store inventory", "retail"],
	Corporate: ["intercompany", "consolidation", "elimination", "statutory", "compliance", "audit finding"],
	Support: ["case", "cases", "ticket", "tickets", "sla", "customer service", "service request"],
	Workflow: ["approval", "approvals", "workflow", "requisition", "requisitions"],
}

/**
 * Classify a question into 1-3 ERP modules.
 * Uses keyword rules + embedding similarity against module embeddings.
 */
export async function routeToModules(
	client: PoolClient,
	question: string,
	questionEmbedding: number[],
	maxModules: number = 3,
	logger?: { debug: Function; warn: Function },
): Promise<ModuleRouteResult> {
	const questionLower = question.toLowerCase()
	const tokens = questionLower.split(/\s+/)
	const keywordScores = new Map<string, number>()

	for (const [module, keywords] of Object.entries(MODULE_KEYWORDS)) {
		let score = 0
		for (const kw of keywords) {
			if (tokens.includes(kw) || questionLower.includes(kw)) {
				score++
			}
		}
		if (score > 0) {
			keywordScores.set(module, score)
		}
	}

	let embeddingScores = new Map<string, number>()
	try {
		const vectorLiteral = `[${questionEmbedding.join(",")}]`
		const result = await client.query(`
			SELECT module_name AS module, 1 - (embedding <=> $1::vector) AS similarity
			FROM rag.module_embeddings
			ORDER BY embedding <=> $1::vector
			LIMIT $2
		`, [vectorLiteral, maxModules + 2])

		for (const row of result.rows) {
			embeddingScores.set(row.module, parseFloat(row.similarity))
		}
	} catch (err) {
		logger?.warn("Module router: embedding lookup failed", { error: String(err) })
	}

	const combined = new Map<string, { score: number; confidence: number }>()

	for (const [module, sim] of embeddingScores) {
		combined.set(module, { score: sim, confidence: sim })
	}

	for (const [module, kwScore] of keywordScores) {
		const existing = combined.get(module)
		if (existing) {
			existing.score += kwScore * 0.15
			existing.confidence = Math.max(existing.confidence, kwScore * 0.2)
		} else {
			combined.set(module, {
				score: kwScore * 0.15,
				confidence: kwScore * 0.2,
			})
		}
	}

	const sorted = [...combined.entries()]
		.sort((a, b) => b[1].score - a[1].score)

	let method: "keyword" | "embedding" | "hybrid"
	if (keywordScores.size > 0 && embeddingScores.size > 0) {
		method = "hybrid"
	} else if (keywordScores.size > 0) {
		method = "keyword"
	} else {
		method = "embedding"
	}

	if (sorted.length === 0 || (sorted[0][1].confidence < 0.30 && keywordScores.size === 0)) {
		logger?.debug("Module router: no strong match, returning all modules (no filtering)")
		return {
			modules: [],
			confidences: [],
			method,
		}
	}

	const topModules = sorted.slice(0, maxModules)

	return {
		modules: topModules.map(([m]) => m),
		confidences: topModules.map(([, s]) => s.confidence),
		method,
	}
}

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
