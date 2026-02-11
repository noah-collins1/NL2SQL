/**
 * Join Planner
 *
 * Enumerates valid join paths from FK metadata so the LLM doesn't have to
 * invent join keys. Builds a FK graph and finds shortest paths between
 * required tables using BFS.
 */

import type { SchemaContextPacket } from "./schema_types.js"
import type { SchemaLinkBundle } from "./schema_linker.js"

// ============================================================================
// Feature Flags
// ============================================================================

export const JOIN_PLANNER_ENABLED = process.env.JOIN_PLANNER_ENABLED === "true"
export const JOIN_PLANNER_TOP_K = parseInt(process.env.JOIN_PLANNER_TOP_K || "3", 10)

// ============================================================================
// Types
// ============================================================================

export interface JoinPlan {
	skeletons: JoinSkeleton[]
	graphStats: { nodes: number; edges: number }
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
	score: number // Lower is better (fewer hops)
	sqlFragment: string
}

interface FKEdge {
	fromTable: string
	fromColumn: string
	toTable: string
	toColumn: string
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
 * Find K shortest paths between two tables.
 * Uses iterative BFS with path removal (Yen's-like).
 */
function findKShortestPaths(graph: FKGraph, from: string, to: string, k: number): PathResult[] {
	const paths: PathResult[] = []

	// First path is always the shortest
	const shortest = findShortestPath(graph, from, to)
	if (!shortest) return paths
	paths.push(shortest)

	// For simplicity, just return the single shortest path
	// (multi-path enumeration is rarely needed for FK graphs)
	return paths
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
			const isForward = edge.fromTable === current
			const joinTable = neighbor
			const onClause = `${edge.fromTable}.${edge.fromColumn} = ${edge.toTable}.${edge.toColumn}`

			parts.push(`JOIN ${joinTable} ON ${onClause}`)
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
 * @returns JoinPlan with skeletons and graph stats
 */
export function planJoins(
	schemaContext: SchemaContextPacket,
	schemaLinkBundle: SchemaLinkBundle | null,
	topK: number = JOIN_PLANNER_TOP_K,
): JoinPlan {
	const graph = new FKGraph(schemaContext.fk_edges)

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
		}
	}

	// Filter to tables that exist in the graph
	const graphTables = requiredTables.filter(t => graph.hasTable(t))

	// Build connecting subgraph
	const subgraph = buildConnectingSubgraph(graph, graphTables)

	if (!subgraph) {
		return {
			skeletons: [],
			graphStats: { nodes: graph.nodeCount, edges: graph.edgeCount },
		}
	}

	// Generate SQL fragment
	const sqlFragment = generateSQLFragment(subgraph)

	// Build join skeleton
	const skeleton: JoinSkeleton = {
		tables: subgraph.tables,
		joins: subgraph.edges.map(edge => ({
			fromTable: edge.fromTable,
			fromColumn: edge.fromColumn,
			toTable: edge.toTable,
			toColumn: edge.toColumn,
			joinType: "INNER" as const,
		})),
		score: subgraph.edges.length, // Score = number of hops (lower is better)
		sqlFragment,
	}

	return {
		skeletons: [skeleton],
		graphStats: { nodes: graph.nodeCount, edges: graph.edgeCount },
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

	for (let i = 0; i < plan.skeletons.length; i++) {
		const skeleton = plan.skeletons[i]
		if (plan.skeletons.length > 1) {
			lines.push(`### Option ${i + 1} (${skeleton.joins.length} joins)`)
		}
		lines.push("```sql")
		lines.push(skeleton.sqlFragment)
		lines.push("```")
		lines.push("")
	}

	return lines.join("\n")
}
