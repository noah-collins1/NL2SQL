/**
 * Join Planner
 *
 * Enumerates valid join paths from FK metadata so the LLM doesn't have to
 * invent join keys. Builds a FK graph and finds shortest paths between
 * required tables using BFS.
 *
 * Phase 2 upgrades:
 * - Module-scoped FK subgraph caching (2.1)
 * - Dynamic hub table handling (2.2)
 * - Cross-module join detection (2.4)
 * - Multi-factor join path scoring (2.3)
 * - K-shortest paths via Yen's algorithm (2.3)
 */

import type { SchemaContextPacket } from "./schema_types.js"
import type { SchemaLinkBundle } from "./schema_linker.js"

// ============================================================================
// Feature Flags
// ============================================================================

export const JOIN_PLANNER_ENABLED = process.env.JOIN_PLANNER_ENABLED === "true"
export const JOIN_PLANNER_TOP_K = parseInt(process.env.JOIN_PLANNER_TOP_K || "3", 10)
export const FK_SUBGRAPH_CACHE_ENABLED = process.env.FK_SUBGRAPH_CACHE_ENABLED !== "false"
export const DYNAMIC_HUB_CAP_ENABLED = process.env.DYNAMIC_HUB_CAP_ENABLED !== "false"
export const JOIN_PATH_SCORING_ENABLED = process.env.JOIN_PATH_SCORING_ENABLED !== "false"
export const CROSS_MODULE_JOIN_ENABLED = process.env.CROSS_MODULE_JOIN_ENABLED !== "false"

// ============================================================================
// Types
// ============================================================================

export interface JoinPlan {
	skeletons: JoinSkeleton[]
	graphStats: { nodes: number; edges: number }
	crossModuleDetected?: boolean
	bridgeTables?: string[]
	modulesUsed?: string[]
}

export interface JoinSkeleton {
	tables: string[]
	joins: Array<{
		fromTable: string
		fromColumn: string
		toTable: string
		toColumn: string
		joinType: "INNER" | "LEFT"
	}>
	score: number // Lower is better
	sqlFragment: string
	scoreDetails?: JoinPathScore
}

export interface JoinPathScore {
	hopCount: number
	semanticAlignment: number // 0-1: intermediate tables match keyphrases?
	columnCoverage: number    // 0-1: join columns in schema link?
	combined: number          // weighted sum (lower = better)
}

interface FKEdge {
	fromTable: string
	fromColumn: string
	toTable: string
	toColumn: string
}

interface CrossModuleInfo {
	detected: boolean
	modules: string[]
	bridgeTables: string[]
}

interface HubConfig {
	hubTables: Set<string>
	relevantTables: Set<string>
	defaultCap: number
	relevantCap: number
}

// ============================================================================
// Scoring Weights
// ============================================================================

const SCORE_WEIGHTS = {
	hopCount: 0.30,            // shorter preferred (positive = penalty per hop)
	semanticAlignment: -0.35,  // more alignment = lower (better) score
	columnCoverage: -0.20,     // more coverage = lower score
	fkValidity: -0.15,        // always 1.0 for FK-based BFS
}

// ============================================================================
// FK Graph
// ============================================================================

/**
 * Adjacency list graph built from FK edges.
 * Each edge is bidirectional (can join in either direction).
 */
class FKGraph {
	private adjacency: Map<string, Array<{ neighbor: string; edge: FKEdge }>> = new Map()
	private allTables: Set<string> = new Set()
	private allEdges: FKEdge[] = []

	constructor(fkEdges: SchemaContextPacket["fk_edges"]) {
		for (const edge of fkEdges) {
			const fkEdge: FKEdge = {
				fromTable: edge.from_table,
				fromColumn: edge.from_column,
				toTable: edge.to_table,
				toColumn: edge.to_column,
			}
			this.allEdges.push(fkEdge)
			this.allTables.add(edge.from_table)
			this.allTables.add(edge.to_table)

			// Forward: from → to
			if (!this.adjacency.has(edge.from_table)) {
				this.adjacency.set(edge.from_table, [])
			}
			this.adjacency.get(edge.from_table)!.push({ neighbor: edge.to_table, edge: fkEdge })

			// Reverse: to → from (bidirectional)
			if (!this.adjacency.has(edge.to_table)) {
				this.adjacency.set(edge.to_table, [])
			}
			this.adjacency.get(edge.to_table)!.push({ neighbor: edge.from_table, edge: fkEdge })
		}
	}

	static fromFKEdges(edges: FKEdge[]): FKGraph {
		return new FKGraph(edges.map(e => ({
			from_table: e.fromTable,
			from_column: e.fromColumn,
			to_table: e.toTable,
			to_column: e.toColumn,
		})))
	}

	static merge(graphs: FKGraph[]): FKGraph {
		const edgeSet = new Set<string>()
		const merged: FKEdge[] = []
		for (const g of graphs) {
			for (const e of g.allEdges) {
				const key = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
				if (!edgeSet.has(key)) {
					edgeSet.add(key)
					merged.push(e)
				}
			}
		}
		return FKGraph.fromFKEdges(merged)
	}

	get nodeCount(): number {
		return this.allTables.size
	}

	get edgeCount(): number {
		return this.allEdges.length
	}

	getNeighbors(table: string): Array<{ neighbor: string; edge: FKEdge }> {
		return this.adjacency.get(table) || []
	}

	hasTable(table: string): boolean {
		return this.allTables.has(table)
	}

	getEdges(): FKEdge[] {
		return this.allEdges
	}

	getTables(): Set<string> {
		return new Set(this.allTables)
	}
}

// ============================================================================
// Module Subgraph Caching (2.1)
// ============================================================================

let _subgraphCache: {
	subgraphs: Map<string, FKGraph>
	fullGraph: FKGraph
	cacheKey: string
} | null = null

function computeCacheKey(fkEdges: SchemaContextPacket["fk_edges"]): string {
	const sorted = [...fkEdges]
		.map(e => `${e.from_table}.${e.from_column}->${e.to_table}.${e.to_column}`)
		.sort()
		.join("|")
	let hash = 0
	for (let i = 0; i < sorted.length; i++) {
		hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0
	}
	return hash.toString(36)
}

function buildModuleSubgraphs(schemaContext: SchemaContextPacket): Map<string, FKGraph> {
	// Group tables by module
	const moduleToTables = new Map<string, Set<string>>()
	for (const t of schemaContext.tables) {
		if (!moduleToTables.has(t.module)) moduleToTables.set(t.module, new Set())
		moduleToTables.get(t.module)!.add(t.table_name)
	}

	const subgraphs = new Map<string, FKGraph>()
	for (const [mod, tables] of moduleToTables) {
		// Include edges where either end is in this module
		// Cross-module edges appear in both module subgraphs (bridge paths)
		const moduleEdges = schemaContext.fk_edges.filter(e =>
			tables.has(e.from_table) || tables.has(e.to_table)
		)
		subgraphs.set(mod, new FKGraph(moduleEdges))
	}
	return subgraphs
}

function getOrBuildCache(schemaContext: SchemaContextPacket): NonNullable<typeof _subgraphCache> {
	const key = computeCacheKey(schemaContext.fk_edges)
	if (_subgraphCache && _subgraphCache.cacheKey === key) {
		return _subgraphCache
	}
	const fullGraph = new FKGraph(schemaContext.fk_edges)
	const subgraphs = buildModuleSubgraphs(schemaContext)
	_subgraphCache = { subgraphs, fullGraph, cacheKey: key }
	return _subgraphCache
}

function getSubgraphForModules(
	cache: NonNullable<typeof _subgraphCache>,
	modules: string[],
): FKGraph {
	if (modules.length === 0) return cache.fullGraph
	const graphs: FKGraph[] = []
	for (const mod of modules) {
		const g = cache.subgraphs.get(mod)
		if (g) graphs.push(g)
	}
	if (graphs.length === 0) return cache.fullGraph
	if (graphs.length === 1) return graphs[0]
	return FKGraph.merge(graphs)
}

// ============================================================================
// Hub Table Handling (2.2)
// ============================================================================

function identifyHubTables(
	schemaContext: SchemaContextPacket,
	fkEdges: SchemaContextPacket["fk_edges"],
): Set<string> {
	const degree = new Map<string, number>()
	for (const e of fkEdges) {
		degree.set(e.from_table, (degree.get(e.from_table) || 0) + 1)
		degree.set(e.to_table, (degree.get(e.to_table) || 0) + 1)
	}

	const hubs = new Set<string>()
	for (const [table, deg] of degree) {
		if (deg > 8) hubs.add(table)
	}
	// Include explicitly flagged hubs from retriever
	for (const t of schemaContext.tables) {
		if (t.is_hub) hubs.add(t.table_name)
	}
	return hubs
}

function applyDynamicHubCaps(graph: FKGraph, hubConfig: HubConfig): FKGraph {
	const allEdges = graph.getEdges()

	// Deduplicate edges by canonical key
	const edgeMap = new Map<string, FKEdge>()
	for (const e of allEdges) {
		const key = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
		if (!edgeMap.has(key)) edgeMap.set(key, e)
	}
	const uniqueEdges = Array.from(edgeMap.values())

	// Separate hub edges from non-hub edges
	const nonHubEdges: FKEdge[] = []
	const hubEdgeGroups = new Map<string, FKEdge[]>()

	for (const e of uniqueEdges) {
		const fromHub = hubConfig.hubTables.has(e.fromTable)
		const toHub = hubConfig.hubTables.has(e.toTable)
		if (!fromHub && !toHub) {
			nonHubEdges.push(e)
		} else {
			if (fromHub) {
				if (!hubEdgeGroups.has(e.fromTable)) hubEdgeGroups.set(e.fromTable, [])
				hubEdgeGroups.get(e.fromTable)!.push(e)
			}
			if (toHub) {
				if (!hubEdgeGroups.has(e.toTable)) hubEdgeGroups.set(e.toTable, [])
				hubEdgeGroups.get(e.toTable)!.push(e)
			}
		}
	}

	// For each hub, cap its edges (prioritize relevant neighbors)
	const keptHubEdgeKeys = new Set<string>()
	for (const [hub, edges] of hubEdgeGroups) {
		const isRelevant = hubConfig.relevantTables.has(hub)
		const cap = isRelevant ? hubConfig.relevantCap : hubConfig.defaultCap

		// Sort: relevant neighbors first, then alphabetical for stability
		const sorted = [...edges].sort((a, b) => {
			const aNeighbor = a.fromTable === hub ? a.toTable : a.fromTable
			const bNeighbor = b.fromTable === hub ? b.toTable : b.fromTable
			const aRel = hubConfig.relevantTables.has(aNeighbor) ? 0 : 1
			const bRel = hubConfig.relevantTables.has(bNeighbor) ? 0 : 1
			if (aRel !== bRel) return aRel - bRel
			return aNeighbor.localeCompare(bNeighbor)
		})

		for (const e of sorted.slice(0, cap)) {
			keptHubEdgeKeys.add(`${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`)
		}
	}

	// Combine: all non-hub edges + capped hub edges
	const finalEdges: FKEdge[] = [...nonHubEdges]
	const nonHubKeys = new Set(nonHubEdges.map(e =>
		`${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
	))
	for (const e of uniqueEdges) {
		const key = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
		if (keptHubEdgeKeys.has(key) && !nonHubKeys.has(key)) {
			finalEdges.push(e)
		}
	}

	return FKGraph.fromFKEdges(finalEdges)
}

// ============================================================================
// Cross-Module Join Detection (2.4)
// ============================================================================

function detectCrossModuleJoin(
	schemaContext: SchemaContextPacket,
	schemaLinkBundle: SchemaLinkBundle | null,
	moduleRouteResult?: { modules: string[] },
): CrossModuleInfo {
	const involvedModules = new Set<string>()

	// From module router
	if (moduleRouteResult?.modules) {
		for (const m of moduleRouteResult.modules) involvedModules.add(m)
	}

	// From schema link bundle (which tables are linked → which modules)
	if (schemaLinkBundle) {
		const tableToModule = new Map<string, string>()
		for (const t of schemaContext.tables) {
			tableToModule.set(t.table_name, t.module)
		}
		for (const lt of schemaLinkBundle.linkedTables) {
			const mod = tableToModule.get(lt.table)
			if (mod) involvedModules.add(mod)
		}
	}

	// Fallback: use all modules from schema context
	if (involvedModules.size === 0) {
		for (const m of schemaContext.modules) involvedModules.add(m)
	}

	const modules = Array.from(involvedModules)
	const detected = modules.length > 1
	const bridgeTables = detected
		? findBridgeTables(schemaContext, modules)
		: []

	return { detected, modules, bridgeTables }
}

function findBridgeTables(schemaContext: SchemaContextPacket, modules: string[]): string[] {
	const moduleSet = new Set(modules)
	const tableToModule = new Map<string, string>()
	for (const t of schemaContext.tables) {
		tableToModule.set(t.table_name, t.module)
	}

	const bridges = new Set<string>()
	for (const e of schemaContext.fk_edges) {
		const fromMod = tableToModule.get(e.from_table)
		const toMod = tableToModule.get(e.to_table)
		if (fromMod && toMod && fromMod !== toMod
			&& moduleSet.has(fromMod) && moduleSet.has(toMod)) {
			bridges.add(e.from_table)
			bridges.add(e.to_table)
		}
	}
	return Array.from(bridges)
}

// ============================================================================
// Path Finding (BFS)
// ============================================================================

interface PathResult {
	tables: string[]
	edges: FKEdge[]
}

/**
 * Find shortest path between two tables using BFS.
 * Returns null if no path exists.
 */
function findShortestPath(graph: FKGraph, from: string, to: string): PathResult | null {
	if (from === to) return { tables: [from], edges: [] }
	if (!graph.hasTable(from) || !graph.hasTable(to)) return null

	const visited = new Set<string>()
	const queue: Array<{ table: string; path: string[]; edges: FKEdge[] }> = [
		{ table: from, path: [from], edges: [] },
	]
	visited.add(from)

	while (queue.length > 0) {
		const current = queue.shift()!

		for (const { neighbor, edge } of graph.getNeighbors(current.table)) {
			if (visited.has(neighbor)) continue
			visited.add(neighbor)

			const newPath = [...current.path, neighbor]
			const newEdges = [...current.edges, edge]

			if (neighbor === to) {
				return { tables: newPath, edges: newEdges }
			}

			queue.push({ table: neighbor, path: newPath, edges: newEdges })
		}
	}

	return null // No path found
}

/**
 * BFS with excluded edges and nodes. Used by Yen's algorithm.
 */
function findShortestPathExcluding(
	graph: FKGraph,
	from: string,
	to: string,
	excludedEdges: Set<string>,
	excludedNodes: Set<string>,
): PathResult | null {
	if (from === to) return { tables: [from], edges: [] }
	if (!graph.hasTable(from) || !graph.hasTable(to)) return null
	if (excludedNodes.has(from) || excludedNodes.has(to)) return null

	const visited = new Set<string>()
	const queue: Array<{ table: string; path: string[]; edges: FKEdge[] }> = [
		{ table: from, path: [from], edges: [] },
	]
	visited.add(from)

	while (queue.length > 0) {
		const current = queue.shift()!

		for (const { neighbor, edge } of graph.getNeighbors(current.table)) {
			if (visited.has(neighbor)) continue
			if (excludedNodes.has(neighbor)) continue

			// Check if this edge is excluded (canonical direction)
			const edgeKey = `${edge.fromTable}.${edge.fromColumn}->${edge.toTable}.${edge.toColumn}`
			if (excludedEdges.has(edgeKey)) continue

			visited.add(neighbor)
			const newPath = [...current.path, neighbor]
			const newEdges = [...current.edges, edge]

			if (neighbor === to) {
				return { tables: newPath, edges: newEdges }
			}

			queue.push({ table: neighbor, path: newPath, edges: newEdges })
		}
	}

	return null
}

/**
 * Find K shortest paths between two tables using Yen's algorithm.
 * When JOIN_PATH_SCORING_ENABLED is false, falls back to single shortest path.
 */
function findKShortestPaths(graph: FKGraph, from: string, to: string, k: number): PathResult[] {
	if (!JOIN_PATH_SCORING_ENABLED) {
		const shortest = findShortestPath(graph, from, to)
		return shortest ? [shortest] : []
	}

	const A: PathResult[] = [] // Confirmed K shortest paths
	const B: PathResult[] = [] // Candidate pool

	// Step 1: Find the actual shortest path
	const p1 = findShortestPath(graph, from, to)
	if (!p1) return []
	A.push(p1)

	// Step 2: Iteratively find next shortest paths
	for (let ki = 1; ki < k; ki++) {
		const prevPath = A[ki - 1]

		for (let i = 0; i < prevPath.tables.length - 1; i++) {
			const spurNode = prevPath.tables[i]
			const rootPath = prevPath.tables.slice(0, i + 1)
			const rootEdges = prevPath.edges.slice(0, i)

			// Exclude edges from paths in A that share the same root path prefix
			const excludedEdges = new Set<string>()
			for (const path of A) {
				if (path.tables.length > i &&
					path.tables.slice(0, i + 1).join(",") === rootPath.join(",")) {
					if (path.edges[i]) {
						const e = path.edges[i]
						excludedEdges.add(`${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`)
					}
				}
			}

			// Exclude root path nodes (except spur node) to prevent loops
			const excludedNodes = new Set(rootPath.slice(0, -1))

			const spurPath = findShortestPathExcluding(graph, spurNode, to, excludedEdges, excludedNodes)

			if (spurPath) {
				const totalTables = [...rootPath.slice(0, -1), ...spurPath.tables]
				const totalEdges = [...rootEdges, ...spurPath.edges]
				const totalPath: PathResult = { tables: totalTables, edges: totalEdges }

				const pathKey = totalTables.join(",")
				if (!B.some(p => p.tables.join(",") === pathKey) &&
					!A.some(p => p.tables.join(",") === pathKey)) {
					B.push(totalPath)
				}
			}
		}

		if (B.length === 0) break

		// Sort candidates by hop count, pick shortest
		B.sort((a, b) => a.edges.length - b.edges.length)
		A.push(B.shift()!)
	}

	return A
}

// ============================================================================
// Join Path Scoring (2.3)
// ============================================================================

function scoreJoinPath(
	pathResult: { tables: string[]; edges: FKEdge[] },
	schemaLinkBundle: SchemaLinkBundle | null,
	_schemaContext: SchemaContextPacket,
): JoinPathScore {
	const hopCount = pathResult.edges.length

	// Semantic alignment: fraction of intermediate tables that are linked
	let semanticAlignment = 0
	if (schemaLinkBundle && pathResult.tables.length > 2) {
		const intermediates = pathResult.tables.slice(1, -1)
		const linkedSet = new Set(schemaLinkBundle.linkedTables.map(t => t.table))
		const linked = intermediates.filter(t => linkedSet.has(t)).length
		semanticAlignment = intermediates.length > 0 ? linked / intermediates.length : 0
	} else if (pathResult.tables.length <= 2) {
		semanticAlignment = 1 // Direct join, always aligned
	}

	// Column coverage: fraction of join columns appearing in schema link
	let columnCoverage = 0
	if (schemaLinkBundle && pathResult.edges.length > 0) {
		let totalJoinCols = 0
		let coveredCols = 0
		for (const edge of pathResult.edges) {
			totalJoinCols += 2
			const fromCols = schemaLinkBundle.linkedColumns[edge.fromTable] || []
			const toCols = schemaLinkBundle.linkedColumns[edge.toTable] || []
			if (fromCols.some(c => c.column === edge.fromColumn)) coveredCols++
			if (toCols.some(c => c.column === edge.toColumn)) coveredCols++
		}
		columnCoverage = totalJoinCols > 0 ? coveredCols / totalJoinCols : 0
	}

	// FK validity: always 1.0 for FK-based BFS paths
	const fkValidity = 1.0

	// Combined score (lower = better)
	const combined =
		SCORE_WEIGHTS.hopCount * hopCount +
		SCORE_WEIGHTS.semanticAlignment * semanticAlignment +
		SCORE_WEIGHTS.columnCoverage * columnCoverage +
		SCORE_WEIGHTS.fkValidity * fkValidity

	return { hopCount, semanticAlignment, columnCoverage, combined }
}

// ============================================================================
// Steiner Tree Approximation
// ============================================================================

/**
 * Build a minimum connecting subgraph for the required tables.
 * Uses pairwise shortest paths and merges them.
 */
function buildConnectingSubgraph(
	graph: FKGraph,
	requiredTables: string[],
): { tables: string[]; edges: FKEdge[] } | null {
	if (requiredTables.length <= 1) {
		return { tables: requiredTables, edges: [] }
	}

	const allTables = new Set<string>(requiredTables)
	const allEdges: FKEdge[] = []
	const edgeSet = new Set<string>()

	// Find paths between all pairs of required tables
	for (let i = 0; i < requiredTables.length; i++) {
		for (let j = i + 1; j < requiredTables.length; j++) {
			const path = findShortestPath(graph, requiredTables[i], requiredTables[j])
			if (path) {
				for (const table of path.tables) {
					allTables.add(table)
				}
				for (const edge of path.edges) {
					const edgeKey = `${edge.fromTable}.${edge.fromColumn}->${edge.toTable}.${edge.toColumn}`
					if (!edgeSet.has(edgeKey)) {
						edgeSet.add(edgeKey)
						allEdges.push(edge)
					}
				}
			}
		}
	}

	if (allEdges.length === 0 && requiredTables.length > 1) {
		return null // No connections found
	}

	return { tables: Array.from(allTables), edges: allEdges }
}

/**
 * Build multiple scored skeletons using K-shortest paths.
 * Primary skeleton uses standard Steiner tree approach.
 * Variants swap in alternative paths for each table pair.
 */
function buildScoredSkeletons(
	graph: FKGraph,
	requiredTables: string[],
	schemaLinkBundle: SchemaLinkBundle | null,
	schemaContext: SchemaContextPacket,
	topK: number,
): Array<{ tables: string[]; edges: FKEdge[]; scoreDetails: JoinPathScore }> {
	if (requiredTables.length <= 1) {
		return [{
			tables: requiredTables,
			edges: [],
			scoreDetails: { hopCount: 0, semanticAlignment: 1, columnCoverage: 1, combined: 0 },
		}]
	}

	// Primary skeleton from Steiner tree approach
	const primary = buildConnectingSubgraph(graph, requiredTables)
	if (!primary) return []

	const primaryScore = scoreJoinPath(primary, schemaLinkBundle, schemaContext)
	const results: Array<{ tables: string[]; edges: FKEdge[]; scoreDetails: JoinPathScore }> = [
		{ ...primary, scoreDetails: primaryScore },
	]

	if (topK <= 1) return results

	// Generate variants by swapping alternative paths for each pair
	const seenKeys = new Set<string>()
	seenKeys.add([...primary.tables].sort().join(","))

	for (let i = 0; i < requiredTables.length && results.length < topK; i++) {
		for (let j = i + 1; j < requiredTables.length && results.length < topK; j++) {
			const altPaths = findKShortestPaths(graph, requiredTables[i], requiredTables[j], 2)
			if (altPaths.length < 2) continue

			// Build variant: use 2nd path for this pair, shortest for others
			const variantTables = new Set<string>()
			const variantEdges: FKEdge[] = []
			const variantEdgeSet = new Set<string>()

			// Add alternative path for this pair
			for (const t of altPaths[1].tables) variantTables.add(t)
			for (const e of altPaths[1].edges) {
				const k = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
				if (!variantEdgeSet.has(k)) {
					variantEdgeSet.add(k)
					variantEdges.push(e)
				}
			}

			// Add shortest paths for all other pairs
			for (let ii = 0; ii < requiredTables.length; ii++) {
				for (let jj = ii + 1; jj < requiredTables.length; jj++) {
					if (ii === i && jj === j) continue
					const path = findShortestPath(graph, requiredTables[ii], requiredTables[jj])
					if (path) {
						for (const t of path.tables) variantTables.add(t)
						for (const e of path.edges) {
							const k = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`
							if (!variantEdgeSet.has(k)) {
								variantEdgeSet.add(k)
								variantEdges.push(e)
							}
						}
					}
				}
			}

			const variantKey = [...variantTables].sort().join(",")
			if (seenKeys.has(variantKey)) continue
			seenKeys.add(variantKey)

			const variant = { tables: Array.from(variantTables), edges: variantEdges }
			const variantScore = scoreJoinPath(variant, schemaLinkBundle, schemaContext)
			results.push({ ...variant, scoreDetails: variantScore })
		}
	}

	// Sort by combined score (lower = better)
	results.sort((a, b) => a.scoreDetails.combined - b.scoreDetails.combined)
	return results.slice(0, topK)
}

// ============================================================================
// SQL Fragment Generation
// ============================================================================

/**
 * Generate a SQL fragment from a join skeleton.
 */
function generateSQLFragment(skeleton: { tables: string[]; edges: FKEdge[] }): string {
	if (skeleton.tables.length === 0) return ""
	if (skeleton.tables.length === 1) return skeleton.tables[0]

	// Determine the root table (first required table or the one with most connections)
	const root = skeleton.tables[0]

	// Build join order by walking from root
	const visited = new Set<string>()
	visited.add(root)
	const parts: string[] = [root]

	// Create adjacency from edges
	const adj = new Map<string, Array<{ neighbor: string; edge: FKEdge }>>()
	for (const edge of skeleton.edges) {
		if (!adj.has(edge.fromTable)) adj.set(edge.fromTable, [])
		if (!adj.has(edge.toTable)) adj.set(edge.toTable, [])
		adj.get(edge.fromTable)!.push({ neighbor: edge.toTable, edge })
		adj.get(edge.toTable)!.push({ neighbor: edge.fromTable, edge })
	}

	// BFS from root to generate join order
	const queue = [root]
	while (queue.length > 0) {
		const current = queue.shift()!
		for (const { neighbor, edge } of adj.get(current) || []) {
			if (visited.has(neighbor)) continue
			visited.add(neighbor)

			// Determine join condition direction
			const onClause = `${edge.fromTable}.${edge.fromColumn} = ${edge.toTable}.${edge.toColumn}`

			parts.push(`JOIN ${neighbor} ON ${onClause}`)
			queue.push(neighbor)
		}
	}

	return parts.join("\n")
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Plan joins for required tables.
 *
 * @param schemaContext - Schema context with FK edges
 * @param schemaLinkBundle - Schema link bundle (determines required tables)
 * @param topK - Maximum number of join skeletons to return
 * @param options - Additional options (module route result, etc.)
 * @returns JoinPlan with skeletons and graph stats
 */
export function planJoins(
	schemaContext: SchemaContextPacket,
	schemaLinkBundle: SchemaLinkBundle | null,
	topK: number = JOIN_PLANNER_TOP_K,
	options?: {
		moduleRouteResult?: { modules: string[] }
	},
): JoinPlan {
	// Step 1: Build graph (with optional module subgraph caching)
	let graph: FKGraph
	let cache: NonNullable<typeof _subgraphCache> | null = null

	if (FK_SUBGRAPH_CACHE_ENABLED) {
		cache = getOrBuildCache(schemaContext)
		graph = cache.fullGraph
	} else {
		graph = new FKGraph(schemaContext.fk_edges)
	}

	// Step 2: Cross-module detection
	let crossModuleInfo: CrossModuleInfo | undefined

	if (CROSS_MODULE_JOIN_ENABLED) {
		crossModuleInfo = detectCrossModuleJoin(
			schemaContext,
			schemaLinkBundle,
			options?.moduleRouteResult,
		)

		// Use module-scoped subgraph when single module
		if (cache && crossModuleInfo.modules.length === 1) {
			graph = getSubgraphForModules(cache, crossModuleInfo.modules)
		} else if (cache && crossModuleInfo.detected) {
			// Cross-module: merge relevant module subgraphs
			graph = getSubgraphForModules(cache, crossModuleInfo.modules)
		}
	} else if (cache && options?.moduleRouteResult?.modules.length) {
		// Even without cross-module detection, use module subgraph if available
		graph = getSubgraphForModules(cache, options.moduleRouteResult.modules)
	}

	// Step 3: Dynamic hub caps
	if (DYNAMIC_HUB_CAP_ENABLED) {
		const relevantTables = new Set<string>()
		if (schemaLinkBundle) {
			for (const lt of schemaLinkBundle.linkedTables) {
				if (lt.relevance > 0) relevantTables.add(lt.table)
			}
		}

		const hubTables = identifyHubTables(schemaContext, schemaContext.fk_edges)
		if (hubTables.size > 0) {
			graph = applyDynamicHubCaps(graph, {
				hubTables,
				relevantTables,
				defaultCap: 5,
				relevantCap: 15,
			})
		}
	}

	// Determine required tables
	let requiredTables: string[]
	if (schemaLinkBundle) {
		// Use linked tables (sorted by relevance, top N)
		requiredTables = schemaLinkBundle.linkedTables
			.filter(t => t.relevance > 0)
			.map(t => t.table)
	} else {
		// Use all tables from schema context
		requiredTables = schemaContext.tables.map(t => t.table_name)
	}

	// Handle single table or no tables case (no joins needed)
	if (requiredTables.length <= 1) {
		return {
			skeletons: requiredTables.length === 1
				? [{
					tables: requiredTables,
					joins: [],
					score: 0,
					sqlFragment: requiredTables[0],
				}]
				: [],
			graphStats: { nodes: graph.nodeCount, edges: graph.edgeCount },
			crossModuleDetected: crossModuleInfo?.detected,
			bridgeTables: crossModuleInfo?.bridgeTables,
			modulesUsed: crossModuleInfo?.modules,
		}
	}

	// Filter to tables that exist in the graph
	const graphTables = requiredTables.filter(t => graph.hasTable(t))

	// Step 4: Build skeletons (scored or legacy)
	let rawSkeletons: Array<{ tables: string[]; edges: FKEdge[]; scoreDetails?: JoinPathScore }>

	if (JOIN_PATH_SCORING_ENABLED) {
		rawSkeletons = buildScoredSkeletons(graph, graphTables, schemaLinkBundle, schemaContext, topK)
	} else {
		// Legacy: single skeleton with hop-count scoring
		const subgraph = buildConnectingSubgraph(graph, graphTables)
		rawSkeletons = subgraph ? [{ ...subgraph, scoreDetails: undefined }] : []
	}

	if (rawSkeletons.length === 0) {
		return {
			skeletons: [],
			graphStats: { nodes: graph.nodeCount, edges: graph.edgeCount },
			crossModuleDetected: crossModuleInfo?.detected,
			bridgeTables: crossModuleInfo?.bridgeTables,
			modulesUsed: crossModuleInfo?.modules,
		}
	}

	// Build final JoinSkeleton array
	const skeletons: JoinSkeleton[] = rawSkeletons.map(raw => {
		const sqlFragment = generateSQLFragment(raw)
		return {
			tables: raw.tables,
			joins: raw.edges.map(edge => ({
				fromTable: edge.fromTable,
				fromColumn: edge.fromColumn,
				toTable: edge.toTable,
				toColumn: edge.toColumn,
				joinType: "INNER" as const,
			})),
			score: raw.scoreDetails?.combined ?? raw.edges.length,
			sqlFragment,
			scoreDetails: raw.scoreDetails,
		}
	})

	return {
		skeletons,
		graphStats: { nodes: graph.nodeCount, edges: graph.edgeCount },
		crossModuleDetected: crossModuleInfo?.detected,
		bridgeTables: crossModuleInfo?.bridgeTables,
		modulesUsed: crossModuleInfo?.modules,
	}
}

// ============================================================================
// Prompt Formatting
// ============================================================================

/**
 * Format a JoinPlan for inclusion in the LLM prompt.
 */
export function formatJoinPlanForPrompt(plan: JoinPlan): string {
	if (plan.skeletons.length === 0) return ""

	const lines: string[] = []
	lines.push("## Join Plan (use these exact join conditions)")
	lines.push("")

	// Cross-module note
	if (plan.crossModuleDetected && plan.bridgeTables && plan.bridgeTables.length > 0) {
		lines.push(`Note: Cross-module query spanning ${plan.modulesUsed?.join(", ") || "multiple"} modules.`)
		lines.push(`Bridge tables: ${plan.bridgeTables.join(", ")}`)
		lines.push("")
	}

	for (let i = 0; i < plan.skeletons.length; i++) {
		const skeleton = plan.skeletons[i]
		if (plan.skeletons.length > 1) {
			const confidence = skeleton.scoreDetails
				? ` (score: ${skeleton.scoreDetails.combined.toFixed(2)}, alignment: ${(skeleton.scoreDetails.semanticAlignment * 100).toFixed(0)}%)`
				: ` (${skeleton.joins.length} joins)`
			lines.push(`### Option ${i + 1}${confidence}`)
		}
		lines.push("```sql")
		lines.push(skeleton.sqlFragment)
		lines.push("```")
		lines.push("")
	}

	return lines.join("\n")
}

// ============================================================================
// Test Helpers (exported for unit tests)
// ============================================================================

export { FKGraph as _FKGraph }

export const _testHelpers = {
	findShortestPath,
	findKShortestPaths,
	findShortestPathExcluding,
	buildConnectingSubgraph,
	scoreJoinPath,
	buildScoredSkeletons,
	detectCrossModuleJoin,
	findBridgeTables,
	identifyHubTables,
	applyDynamicHubCaps,
	buildModuleSubgraphs,
	getOrBuildCache,
	getSubgraphForModules,
	computeCacheKey,
	resetCache: () => { _subgraphCache = null },
}
