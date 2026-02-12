/**
 * BM25 Full-Text Search + RRF Fusion
 *
 * Phase 1.2: tsvector-based full-text search on table+column metadata
 * Phase 1.3: Reciprocal Rank Fusion (RRF) combining BM25 + cosine similarity
 */

import { PoolClient } from "pg"
import { RetrievedTable } from "./schema_types.js"

export const BM25_SEARCH_ENABLED = process.env.BM25_SEARCH_ENABLED !== "false" // default ON

export interface BM25Result {
	table_name: string
	table_schema: string
	module: string
	table_gloss: string
	rank: number // ts_rank score
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
	// Check if search_vector column exists (graceful degradation)
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
				st.table_name,
				st.table_schema,
				st.module,
				st.table_gloss,
				st.fk_degree,
				st.is_hub,
				ts_rank(st.search_vector, plainto_tsquery('english', $1)) AS rank
			FROM rag.schema_tables st
			WHERE st.search_vector @@ plainto_tsquery('english', $1)
				AND st.module = ANY($3)
			ORDER BY rank DESC
			LIMIT $2
		`
		: `
			SELECT
				st.table_name,
				st.table_schema,
				st.module,
				st.table_gloss,
				st.fk_degree,
				st.is_hub,
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
 * Combines cosine similarity results with BM25 results using the formula:
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

	// Score cosine results by rank position
	for (let i = 0; i < cosineResults.length; i++) {
		const t = cosineResults[i]
		const rrfScore = 1 / (k + i + 1) // rank is 1-based
		scores.set(t.table_name, {
			rrfScore,
			table: t,
			inCosine: true,
			inBm25: false,
		})
	}

	// Add BM25 results
	const missingRankCosine = cosineResults.length + 1 // rank for tables not in cosine
	for (let i = 0; i < bm25Results.length; i++) {
		const b = bm25Results[i]
		const bm25RrfScore = 1 / (k + i + 1)
		const existing = scores.get(b.table_name)

		if (existing) {
			// Table in both lists - combine scores
			existing.rrfScore += bm25RrfScore
			existing.inBm25 = true
		} else {
			// BM25-only table - add with penalty for missing cosine rank
			const cosineRrfScore = 1 / (k + missingRankCosine)
			scores.set(b.table_name, {
				rrfScore: cosineRrfScore + bm25RrfScore,
				table: {
					table_name: b.table_name,
					table_schema: b.table_schema,
					module: b.module,
					table_gloss: b.table_gloss,
					similarity: 0, // No cosine similarity
					source: "bm25" as any,
					fk_degree: b.fk_degree,
					is_hub: b.is_hub,
				},
				inCosine: false,
				inBm25: true,
			})
		}
	}

	// Sort by RRF score descending
	const sorted = [...scores.values()]
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.slice(0, config.maxTables)

	// Build result with source annotation
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
			similarity: entry.table.similarity || entry.rrfScore, // preserve cosine similarity if available
			source: source as any,
		}
	})
}
