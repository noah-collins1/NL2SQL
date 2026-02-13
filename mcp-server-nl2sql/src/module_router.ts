/**
 * Module Router
 *
 * Phase 1.1: Classify a question into 1-3 ERP modules to narrow
 * the table universe before retrieval.
 *
 * Uses keyword rules (fast, deterministic) + embedding similarity (semantic).
 */

import { PoolClient } from "pg"

export const MODULE_ROUTER_ENABLED = process.env.MODULE_ROUTER_ENABLED !== "false" // default ON

export interface ModuleRouteResult {
	modules: string[]
	confidences: number[]
	method: "keyword" | "embedding" | "hybrid"
}

/**
 * Keyword rules for module detection.
 * Tokens are lowercased and matched against question tokens.
 */
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
	// 1. Keyword matching
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

	// 2. Embedding similarity against module embeddings
	let embeddingScores = new Map<string, number>()
	try {
		const vectorLiteral = `[${questionEmbedding.join(",")}]`
		const result = await client.query(`
			SELECT module_name AS module, 1 - (embedding <=> $1::vector) AS similarity
			FROM rag.module_embeddings
			ORDER BY embedding <=> $1::vector
			LIMIT $2
		`, [vectorLiteral, maxModules + 2]) // fetch a few extra for merging

		for (const row of result.rows) {
			embeddingScores.set(row.module, parseFloat(row.similarity))
		}
	} catch (err) {
		// module_embeddings table may not exist yet
		logger?.warn("Module router: embedding lookup failed", { error: String(err) })
	}

	// 3. Combine: keyword matches boost embedding rank
	const combined = new Map<string, { score: number; confidence: number }>()

	// Start with embedding scores
	for (const [module, sim] of embeddingScores) {
		combined.set(module, { score: sim, confidence: sim })
	}

	// Boost with keyword matches
	for (const [module, kwScore] of keywordScores) {
		const existing = combined.get(module)
		if (existing) {
			// Keyword match boosts the score
			existing.score += kwScore * 0.15 // each keyword match adds 0.15
			existing.confidence = Math.max(existing.confidence, kwScore * 0.2)
		} else {
			// Keyword-only module (no embedding match)
			combined.set(module, {
				score: kwScore * 0.15,
				confidence: kwScore * 0.2,
			})
		}
	}

	// Sort by combined score
	const sorted = [...combined.entries()]
		.sort((a, b) => b[1].score - a[1].score)

	// Determine method
	let method: "keyword" | "embedding" | "hybrid"
	if (keywordScores.size > 0 && embeddingScores.size > 0) {
		method = "hybrid"
	} else if (keywordScores.size > 0) {
		method = "keyword"
	} else {
		method = "embedding"
	}

	// 4. Fallback: if no strong matches, return all modules (no filtering)
	if (sorted.length === 0 || (sorted[0][1].confidence < 0.30 && keywordScores.size === 0)) {
		logger?.debug("Module router: no strong match, returning all modules (no filtering)")
		return {
			modules: [],
			confidences: [],
			method,
		}
	}

	// Take top maxModules
	const topModules = sorted.slice(0, maxModules)

	return {
		modules: topModules.map(([m]) => m),
		confidences: topModules.map(([, s]) => s.confidence),
		method,
	}
}
