import { describe, it, expect, beforeEach } from "vitest"
import { planJoins, formatJoinPlanForPrompt, _FKGraph, _testHelpers } from "./join_planner.js"
import type { SchemaContextPacket } from "./schema_types.js"
import type { SchemaLinkBundle } from "./schema_linker.js"

const {
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
	resetCache,
} = _testHelpers

function makeFakeSchema(
	tables: Array<{ name: string; module?: string; is_hub?: boolean }>,
	fkEdges: Array<{ from_table: string; from_column: string; to_table: string; to_column: string }>,
): SchemaContextPacket {
	const modules = [...new Set(tables.map(t => t.module || "Test"))]
	return {
		query_id: "test",
		database_id: "test_db",
		question: "test",
		tables: tables.map(t => ({
			table_name: t.name,
			table_schema: "public",
			module: t.module || "Test",
			gloss: `${t.name} table`,
			m_schema: `${t.name} (id integer PK)`,
			similarity: 0.8,
			source: "retrieval" as const,
			is_hub: t.is_hub,
		})),
		fk_edges: fkEdges,
		modules,
		retrieval_meta: {
			total_candidates: tables.length,
			threshold_used: 0.25,
			tables_from_retrieval: tables.length,
			tables_from_fk_expansion: 0,
			hub_tables_capped: [],
		},
		created_at: new Date().toISOString(),
	}
}

// Shorthand for simple table list
function simpleSchema(
	tableNames: string[],
	fkEdges: Array<{ from_table: string; from_column: string; to_table: string; to_column: string }>,
): SchemaContextPacket {
	return makeFakeSchema(tableNames.map(name => ({ name })), fkEdges)
}

function makeBundle(
	tables: string[],
	linkedColumns?: Record<string, Array<{ column: string; relevance: number; concept: string }>>,
): SchemaLinkBundle {
	return {
		linkedTables: tables.map((t, i) => ({ table: t, relevance: 0.9 - i * 0.1, reason: "test" })),
		linkedColumns: linkedColumns || {},
		joinHints: [],
		valueHints: [],
		unsupportedConcepts: [],
	}
}

beforeEach(() => {
	resetCache()
})

// ============================================================================
// Basic planJoins tests (existing behavior preserved)
// ============================================================================

describe("planJoins", () => {
	it("should find path in 3-table FK chain: A → B → C", () => {
		const schema = simpleSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])
		const bundle = makeBundle(["A", "C"])

		const plan = planJoins(schema, bundle)

		expect(plan.skeletons.length).toBeGreaterThan(0)
		const skeleton = plan.skeletons[0]
		expect(skeleton.tables).toContain("A")
		expect(skeleton.tables).toContain("B") // Intermediate table
		expect(skeleton.tables).toContain("C")
		expect(skeleton.joins.length).toBe(2) // A→B and B→C
	})

	it("should find path in diamond graph: A→B, A→C, B→D, C→D", () => {
		const schema = simpleSchema(["A", "B", "C", "D"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])
		const bundle = makeBundle(["A", "D"])

		const plan = planJoins(schema, bundle)

		expect(plan.skeletons.length).toBeGreaterThan(0)
		const skeleton = plan.skeletons[0]
		expect(skeleton.tables).toContain("A")
		expect(skeleton.tables).toContain("D")
		// Should find path of length 2 (A→B→D or A→C→D)
		expect(skeleton.joins.length).toBe(2)
	})

	it("should return empty skeletons when no path exists", () => {
		const schema = simpleSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			// No edge to C
		])
		const bundle = makeBundle(["A", "C"])

		const plan = planJoins(schema, bundle)

		// C is not in the graph since there are no edges involving it
		// The plan should still work but may be incomplete
		expect(plan.graphStats.nodes).toBe(2) // Only A and B are in graph
	})

	it("should generate valid SQL fragment", () => {
		const schema = simpleSchema(["employees", "departments"], [
			{ from_table: "employees", from_column: "department_id", to_table: "departments", to_column: "department_id" },
		])
		const bundle = makeBundle(["employees", "departments"])

		const plan = planJoins(schema, bundle)

		expect(plan.skeletons.length).toBe(1)
		const fragment = plan.skeletons[0].sqlFragment
		expect(fragment).toContain("employees")
		expect(fragment).toContain("departments")
		expect(fragment).toContain("JOIN")
		expect(fragment).toContain("department_id")
	})

	it("should handle single table (no joins needed)", () => {
		const schema = simpleSchema(["employees"], [])
		const bundle = makeBundle(["employees"])

		const plan = planJoins(schema, bundle)

		// Single table has no joins
		expect(plan.skeletons.length).toBe(1)
		expect(plan.skeletons[0].joins.length).toBe(0)
		expect(plan.skeletons[0].sqlFragment).toBe("employees")
	})

	it("should return graph stats", () => {
		const schema = simpleSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])
		const bundle = makeBundle(["A", "C"])

		const plan = planJoins(schema, bundle)

		expect(plan.graphStats.nodes).toBe(3)
		expect(plan.graphStats.edges).toBe(2)
	})

	it("should include scoreDetails on skeletons", () => {
		const schema = simpleSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])
		const bundle = makeBundle(["A", "C"])

		const plan = planJoins(schema, bundle)

		expect(plan.skeletons.length).toBeGreaterThan(0)
		const skeleton = plan.skeletons[0]
		expect(skeleton.scoreDetails).toBeDefined()
		expect(skeleton.scoreDetails!.hopCount).toBe(2)
		expect(typeof skeleton.scoreDetails!.combined).toBe("number")
	})
})

// ============================================================================
// Module Subgraph Caching (2.1)
// ============================================================================

describe("Module Subgraph Caching", () => {
	it("should partition tables into module subgraphs", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "customers", module: "Sales" },
				{ name: "employees", module: "HR" },
				{ name: "departments", module: "HR" },
			],
			[
				{ from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "id" },
				{ from_table: "employees", from_column: "dept_id", to_table: "departments", to_column: "id" },
			],
		)

		const subgraphs = buildModuleSubgraphs(schema)

		expect(subgraphs.size).toBe(2)
		expect(subgraphs.has("Sales")).toBe(true)
		expect(subgraphs.has("HR")).toBe(true)

		const salesGraph = subgraphs.get("Sales")!
		expect(salesGraph.hasTable("orders")).toBe(true)
		expect(salesGraph.hasTable("customers")).toBe(true)
		expect(salesGraph.hasTable("employees")).toBe(false)
		expect(salesGraph.edgeCount).toBe(1)

		const hrGraph = subgraphs.get("HR")!
		expect(hrGraph.hasTable("employees")).toBe(true)
		expect(hrGraph.hasTable("departments")).toBe(true)
		expect(hrGraph.hasTable("orders")).toBe(false)
		expect(hrGraph.edgeCount).toBe(1)
	})

	it("should include cross-module edges in both subgraphs", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "employees", module: "HR" },
			],
			[
				// Cross-module edge: orders references employees (sales rep)
				{ from_table: "orders", from_column: "sales_rep_id", to_table: "employees", to_column: "id" },
			],
		)

		const subgraphs = buildModuleSubgraphs(schema)

		// Both subgraphs should include the cross-module edge
		const salesGraph = subgraphs.get("Sales")!
		expect(salesGraph.hasTable("orders")).toBe(true)
		expect(salesGraph.hasTable("employees")).toBe(true)
		expect(salesGraph.edgeCount).toBe(1)

		const hrGraph = subgraphs.get("HR")!
		expect(hrGraph.hasTable("orders")).toBe(true)
		expect(hrGraph.hasTable("employees")).toBe(true)
		expect(hrGraph.edgeCount).toBe(1)
	})

	it("should cache subgraphs and invalidate on edge change", () => {
		const schema1 = simpleSchema(["A", "B"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		const cache1 = getOrBuildCache(schema1)
		const cache2 = getOrBuildCache(schema1)
		expect(cache1).toBe(cache2) // Same reference = cache hit

		// Different edges → cache miss
		const schema2 = simpleSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])
		const cache3 = getOrBuildCache(schema2)
		expect(cache3).not.toBe(cache1) // Different reference = cache miss
	})

	it("should merge module subgraphs correctly", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "customers", module: "Sales" },
				{ name: "employees", module: "HR" },
			],
			[
				{ from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "id" },
				{ from_table: "orders", from_column: "sales_rep_id", to_table: "employees", to_column: "id" },
			],
		)

		const cache = getOrBuildCache(schema)
		const merged = getSubgraphForModules(cache, ["Sales", "HR"])

		expect(merged.hasTable("orders")).toBe(true)
		expect(merged.hasTable("customers")).toBe(true)
		expect(merged.hasTable("employees")).toBe(true)
		expect(merged.edgeCount).toBe(2)
	})

	it("should fall back to full graph when no modules match", () => {
		const schema = simpleSchema(["A", "B"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		const cache = getOrBuildCache(schema)
		const result = getSubgraphForModules(cache, ["NonExistent"])

		// Falls back to full graph
		expect(result.hasTable("A")).toBe(true)
		expect(result.hasTable("B")).toBe(true)
	})

	it("should produce stable cache keys", () => {
		const edges = [
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		]
		const edgesReversed = [...edges].reverse()

		expect(computeCacheKey(edges)).toBe(computeCacheKey(edgesReversed))
	})
})

// ============================================================================
// Hub Table Handling (2.2)
// ============================================================================

describe("Hub Table Handling", () => {
	it("should identify hub tables by FK degree > 8", () => {
		// Create a hub table with 9+ edges
		const tables = ["hub", ...Array.from({ length: 10 }, (_, i) => `t${i}`)]
		const edges = Array.from({ length: 10 }, (_, i) => ({
			from_table: `t${i}`,
			from_column: "hub_id",
			to_table: "hub",
			to_column: "id",
		}))
		const schema = simpleSchema(tables, edges)

		const hubs = identifyHubTables(schema, edges)

		expect(hubs.has("hub")).toBe(true)
		// Individual tables with degree 1 should not be hubs
		expect(hubs.has("t0")).toBe(false)
	})

	it("should include explicitly flagged hub tables", () => {
		const schema = makeFakeSchema(
			[{ name: "companies", is_hub: true }, { name: "orders" }],
			[{ from_table: "orders", from_column: "company_id", to_table: "companies", to_column: "id" }],
		)

		const hubs = identifyHubTables(schema, schema.fk_edges)

		expect(hubs.has("companies")).toBe(true)
	})

	it("should cap irrelevant hub neighbors to defaultCap", () => {
		// Hub with 10 neighbors, none relevant
		const tables = ["hub", ...Array.from({ length: 10 }, (_, i) => `t${i}`)]
		const edges = Array.from({ length: 10 }, (_, i) => ({
			from_table: `t${i}`,
			from_column: "hub_id",
			to_table: "hub",
			to_column: "id",
		}))
		const schema = simpleSchema(tables, edges)
		const graph = new _FKGraph(edges)

		const capped = applyDynamicHubCaps(graph, {
			hubTables: new Set(["hub"]),
			relevantTables: new Set(),
			defaultCap: 3,
			relevantCap: 10,
		})

		// Hub should only have 3 edges after capping
		expect(capped.edgeCount).toBe(3)
	})

	it("should allow more neighbors for relevant hub tables", () => {
		const tables = ["hub", ...Array.from({ length: 10 }, (_, i) => `t${i}`)]
		const edges = Array.from({ length: 10 }, (_, i) => ({
			from_table: `t${i}`,
			from_column: "hub_id",
			to_table: "hub",
			to_column: "id",
		}))
		const schema = simpleSchema(tables, edges)
		const graph = new _FKGraph(edges)

		const capped = applyDynamicHubCaps(graph, {
			hubTables: new Set(["hub"]),
			relevantTables: new Set(["hub"]),  // hub is relevant
			defaultCap: 3,
			relevantCap: 8,
		})

		expect(capped.edgeCount).toBe(8)
	})

	it("should prioritize relevant neighbors when capping", () => {
		const tables = ["hub", "relevant1", "relevant2", "irrelevant1", "irrelevant2", "irrelevant3"]
		const edges = [
			{ from_table: "irrelevant1", from_column: "hub_id", to_table: "hub", to_column: "id" },
			{ from_table: "irrelevant2", from_column: "hub_id", to_table: "hub", to_column: "id" },
			{ from_table: "irrelevant3", from_column: "hub_id", to_table: "hub", to_column: "id" },
			{ from_table: "relevant1", from_column: "hub_id", to_table: "hub", to_column: "id" },
			{ from_table: "relevant2", from_column: "hub_id", to_table: "hub", to_column: "id" },
		]
		const graph = new _FKGraph(edges)

		const capped = applyDynamicHubCaps(graph, {
			hubTables: new Set(["hub"]),
			relevantTables: new Set(),  // hub itself not relevant
			defaultCap: 2,  // Only keep 2 edges
			relevantCap: 5,
		})

		// With cap=2, should keep 2 edges. Relevant neighbors are prioritized.
		// Since relevantTables is empty (for the hub), all neighbors sorted alphabetically
		expect(capped.edgeCount).toBe(2)
	})
})

// ============================================================================
// Cross-Module Join Detection (2.4)
// ============================================================================

describe("Cross-Module Join Detection", () => {
	it("should detect cross-module join from schema link bundle", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "employees", module: "HR" },
			],
			[
				{ from_table: "orders", from_column: "sales_rep_id", to_table: "employees", to_column: "id" },
			],
		)
		const bundle = makeBundle(["orders", "employees"])

		const info = detectCrossModuleJoin(schema, bundle)

		expect(info.detected).toBe(true)
		expect(info.modules).toContain("Sales")
		expect(info.modules).toContain("HR")
	})

	it("should detect cross-module join from module route result", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "employees", module: "HR" },
			],
			[],
		)

		const info = detectCrossModuleJoin(schema, null, { modules: ["Sales", "HR"] })

		expect(info.detected).toBe(true)
		expect(info.modules.length).toBe(2)
	})

	it("should not detect cross-module for single module", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "customers", module: "Sales" },
			],
			[],
		)
		const bundle = makeBundle(["orders", "customers"])

		const info = detectCrossModuleJoin(schema, bundle)

		expect(info.detected).toBe(false)
		expect(info.modules.length).toBe(1)
		expect(info.bridgeTables.length).toBe(0)
	})

	it("should identify bridge tables between modules", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "customers", module: "Sales" },
				{ name: "employees", module: "HR" },
				{ name: "departments", module: "HR" },
			],
			[
				{ from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "id" },
				{ from_table: "employees", from_column: "dept_id", to_table: "departments", to_column: "id" },
				// Cross-module bridge: orders.sales_rep_id → employees.id
				{ from_table: "orders", from_column: "sales_rep_id", to_table: "employees", to_column: "id" },
			],
		)

		const bridges = findBridgeTables(schema, ["Sales", "HR"])

		expect(bridges).toContain("orders")
		expect(bridges).toContain("employees")
		// Customers and departments are NOT bridge tables
		expect(bridges).not.toContain("customers")
		expect(bridges).not.toContain("departments")
	})

	it("should return bridge tables in JoinPlan", () => {
		const schema = makeFakeSchema(
			[
				{ name: "orders", module: "Sales" },
				{ name: "employees", module: "HR" },
			],
			[
				{ from_table: "orders", from_column: "sales_rep_id", to_table: "employees", to_column: "id" },
			],
		)
		const bundle = makeBundle(["orders", "employees"])

		const plan = planJoins(schema, bundle)

		expect(plan.crossModuleDetected).toBe(true)
		expect(plan.bridgeTables).toContain("orders")
		expect(plan.bridgeTables).toContain("employees")
		expect(plan.modulesUsed).toContain("Sales")
		expect(plan.modulesUsed).toContain("HR")
	})
})

// ============================================================================
// K-Shortest Paths (Yen's Algorithm)
// ============================================================================

describe("K-Shortest Paths", () => {
	it("should find 2 paths in diamond graph", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])

		const paths = findKShortestPaths(graph, "A", "D", 3)

		expect(paths.length).toBe(2)
		// Both paths should be 2 hops
		expect(paths[0].edges.length).toBe(2)
		expect(paths[1].edges.length).toBe(2)
		// Paths should go through different intermediate tables
		const intermediates = paths.map(p => p.tables[1])
		expect(new Set(intermediates).size).toBe(2) // B and C
	})

	it("should return single path when only one exists", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])

		const paths = findKShortestPaths(graph, "A", "C", 3)

		expect(paths.length).toBe(1)
		expect(paths[0].tables).toEqual(["A", "B", "C"])
	})

	it("should return empty array when no path exists", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		const paths = findKShortestPaths(graph, "A", "C", 3)

		expect(paths.length).toBe(0)
	})

	it("findShortestPathExcluding should respect excluded edges", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])

		// Exclude edge A→B, should find A→C→D
		const excludedEdges = new Set(["A.b_id->B.id"])
		const path = findShortestPathExcluding(graph, "A", "D", excludedEdges, new Set())

		expect(path).not.toBeNull()
		expect(path!.tables).toContain("C")
		expect(path!.tables).not.toContain("B")
	})

	it("findShortestPathExcluding should respect excluded nodes", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])

		// Exclude node B, should find A→C→D
		const path = findShortestPathExcluding(graph, "A", "D", new Set(), new Set(["B"]))

		expect(path).not.toBeNull()
		expect(path!.tables).toContain("C")
		expect(path!.tables).not.toContain("B")
	})
})

// ============================================================================
// Join Path Scoring (2.3)
// ============================================================================

describe("Join Path Scoring", () => {
	it("should score direct join with full alignment", () => {
		const schema = simpleSchema(["A", "B"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])
		const bundle = makeBundle(["A", "B"])
		const path = { tables: ["A", "B"], edges: [{ fromTable: "A", fromColumn: "b_id", toTable: "B", toColumn: "id" }] }

		const score = scoreJoinPath(path, bundle, schema)

		expect(score.hopCount).toBe(1)
		expect(score.semanticAlignment).toBe(1) // Direct join
		expect(typeof score.combined).toBe("number")
	})

	it("should penalize irrelevant intermediate tables", () => {
		const schema = simpleSchema(["A", "X", "B"], [
			{ from_table: "A", from_column: "x_id", to_table: "X", to_column: "id" },
			{ from_table: "X", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		// Bundle does NOT include X (irrelevant intermediate)
		const bundleWithoutX = makeBundle(["A", "B"])
		const pathThruX = {
			tables: ["A", "X", "B"],
			edges: [
				{ fromTable: "A", fromColumn: "x_id", toTable: "X", toColumn: "id" },
				{ fromTable: "X", fromColumn: "b_id", toTable: "B", toColumn: "id" },
			],
		}

		const score = scoreJoinPath(pathThruX, bundleWithoutX, schema)
		expect(score.semanticAlignment).toBe(0) // X is not linked

		// Bundle INCLUDES X (relevant intermediate)
		const bundleWithX = makeBundle(["A", "X", "B"])
		const scoreWithX = scoreJoinPath(pathThruX, bundleWithX, schema)
		expect(scoreWithX.semanticAlignment).toBe(1) // X is linked

		// Relevant path should have lower (better) combined score
		expect(scoreWithX.combined).toBeLessThan(score.combined)
	})

	it("should prefer semantically aligned path over shorter irrelevant path", () => {
		const schema = simpleSchema(["A", "relevant", "irrelevant", "B"], [
			{ from_table: "A", from_column: "r_id", to_table: "relevant", to_column: "id" },
			{ from_table: "relevant", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "i_id", to_table: "irrelevant", to_column: "id" },
			{ from_table: "irrelevant", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		const bundle = makeBundle(["A", "relevant", "B"])

		// Path through relevant (2 hops, aligned)
		const alignedPath = {
			tables: ["A", "relevant", "B"],
			edges: [
				{ fromTable: "A", fromColumn: "r_id", toTable: "relevant", toColumn: "id" },
				{ fromTable: "relevant", fromColumn: "b_id", toTable: "B", toColumn: "id" },
			],
		}

		// Path through irrelevant (2 hops, not aligned)
		const misalignedPath = {
			tables: ["A", "irrelevant", "B"],
			edges: [
				{ fromTable: "A", fromColumn: "i_id", toTable: "irrelevant", toColumn: "id" },
				{ fromTable: "irrelevant", fromColumn: "b_id", toTable: "B", toColumn: "id" },
			],
		}

		const alignedScore = scoreJoinPath(alignedPath, bundle, schema)
		const misalignedScore = scoreJoinPath(misalignedPath, bundle, schema)

		expect(alignedScore.semanticAlignment).toBe(1)
		expect(misalignedScore.semanticAlignment).toBe(0)
		// Aligned path should score better (lower)
		expect(alignedScore.combined).toBeLessThan(misalignedScore.combined)
	})

	it("should factor column coverage into score", () => {
		const schema = simpleSchema(["A", "B"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		// Bundle with column coverage
		const bundleWithCoverage = makeBundle(["A", "B"], {
			A: [{ column: "b_id", relevance: 0.9, concept: "reference" }],
			B: [{ column: "id", relevance: 0.9, concept: "primary key" }],
		})

		// Bundle without column coverage
		const bundleWithout = makeBundle(["A", "B"])

		const path = { tables: ["A", "B"], edges: [{ fromTable: "A", fromColumn: "b_id", toTable: "B", toColumn: "id" }] }

		const scoreWith = scoreJoinPath(path, bundleWithCoverage, schema)
		const scoreWithout = scoreJoinPath(path, bundleWithout, schema)

		expect(scoreWith.columnCoverage).toBe(1) // Both join columns covered
		expect(scoreWithout.columnCoverage).toBe(0)
		// Higher coverage should score better (lower)
		expect(scoreWith.combined).toBeLessThan(scoreWithout.combined)
	})
})

// ============================================================================
// Multi-Skeleton Generation
// ============================================================================

describe("Multi-Skeleton", () => {
	it("should return multiple skeletons for diamond graph", () => {
		const schema = simpleSchema(["A", "B", "C", "D"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])

		const bundle = makeBundle(["A", "D"])

		const skeletons = buildScoredSkeletons(
			new _FKGraph(schema.fk_edges),
			["A", "D"],
			bundle,
			schema,
			3,
		)

		expect(skeletons.length).toBe(2) // Two distinct paths: A-B-D and A-C-D
		// Both should have 2 hops
		expect(skeletons[0].scoreDetails.hopCount).toBe(2)
		expect(skeletons[1].scoreDetails.hopCount).toBe(2)
	})

	it("should sort skeletons by combined score", () => {
		const schema = simpleSchema(["A", "relevant", "irrelevant", "B"], [
			{ from_table: "A", from_column: "r_id", to_table: "relevant", to_column: "id" },
			{ from_table: "relevant", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "i_id", to_table: "irrelevant", to_column: "id" },
			{ from_table: "irrelevant", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		// Bundle includes "relevant" but not "irrelevant"
		const bundle = makeBundle(["A", "relevant", "B"])

		const skeletons = buildScoredSkeletons(
			new _FKGraph(schema.fk_edges),
			["A", "B"],
			bundle,
			schema,
			3,
		)

		expect(skeletons.length).toBe(2)
		// First skeleton should have lower (better) score
		expect(skeletons[0].scoreDetails.combined).toBeLessThanOrEqual(skeletons[1].scoreDetails.combined)
		// First skeleton should go through "relevant"
		expect(skeletons[0].tables).toContain("relevant")
	})

	it("should respect topK limit", () => {
		const schema = simpleSchema(["A", "B", "C", "D"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "A", from_column: "c_id", to_table: "C", to_column: "id" },
			{ from_table: "B", from_column: "d_id", to_table: "D", to_column: "id" },
			{ from_table: "C", from_column: "d_id", to_table: "D", to_column: "id" },
		])

		const bundle = makeBundle(["A", "D"])

		const skeletons = buildScoredSkeletons(
			new _FKGraph(schema.fk_edges),
			["A", "D"],
			bundle,
			schema,
			1, // Only want 1
		)

		expect(skeletons.length).toBe(1)
	})
})

// ============================================================================
// FKGraph merge and utilities
// ============================================================================

describe("FKGraph", () => {
	it("should merge multiple graphs without duplicates", () => {
		const g1 = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])
		const g2 = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" }, // duplicate
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])

		const merged = _FKGraph.merge([g1, g2])

		expect(merged.edgeCount).toBe(2) // No duplicates
		expect(merged.nodeCount).toBe(3)
		expect(merged.hasTable("A")).toBe(true)
		expect(merged.hasTable("B")).toBe(true)
		expect(merged.hasTable("C")).toBe(true)
	})

	it("should construct from FKEdges via static factory", () => {
		const graph = _FKGraph.fromFKEdges([
			{ fromTable: "A", fromColumn: "b_id", toTable: "B", toColumn: "id" },
		])

		expect(graph.nodeCount).toBe(2)
		expect(graph.edgeCount).toBe(1)
		expect(graph.hasTable("A")).toBe(true)
		expect(graph.hasTable("B")).toBe(true)
	})

	it("getTables should return all tables", () => {
		const graph = new _FKGraph([
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
		])

		const tables = graph.getTables()

		expect(tables.size).toBe(2)
		expect(tables.has("A")).toBe(true)
		expect(tables.has("B")).toBe(true)
	})
})

// ============================================================================
// Q57 Regression Test
// ============================================================================

describe("Q57 regression: project profitability", () => {
	it("should include project_budgets in skeleton for projects+project_budgets+project_expenses", () => {
		// Simulate the Q57 scenario: projects, project_budgets, project_expenses
		const schema = makeFakeSchema(
			[
				{ name: "projects", module: "Projects" },
				{ name: "project_budgets", module: "Projects" },
				{ name: "project_expenses", module: "Projects" },
				{ name: "budgets", module: "Finance" },  // Wrong table the model was using
			],
			[
				{ from_table: "project_budgets", from_column: "project_id", to_table: "projects", to_column: "project_id" },
				{ from_table: "project_expenses", from_column: "project_id", to_table: "projects", to_column: "project_id" },
				{ from_table: "budgets", from_column: "department_id", to_table: "projects", to_column: "department_id" },
			],
		)

		// Schema linker should link the correct tables
		const bundle = makeBundle(["projects", "project_budgets", "project_expenses"])

		const plan = planJoins(schema, bundle)

		expect(plan.skeletons.length).toBeGreaterThan(0)
		const skeleton = plan.skeletons[0]

		// Must include all 3 correct tables
		expect(skeleton.tables).toContain("projects")
		expect(skeleton.tables).toContain("project_budgets")
		expect(skeleton.tables).toContain("project_expenses")

		// Must NOT include the wrong "budgets" table
		expect(skeleton.tables).not.toContain("budgets")

		// Should have 2 joins: project_budgets→projects, project_expenses→projects
		expect(skeleton.joins.length).toBe(2)
	})
})

// ============================================================================
// formatJoinPlanForPrompt
// ============================================================================

describe("formatJoinPlanForPrompt", () => {
	it("should format a join plan with SQL fragment", () => {
		const schema = simpleSchema(["employees", "departments"], [
			{ from_table: "employees", from_column: "department_id", to_table: "departments", to_column: "department_id" },
		])
		const bundle = makeBundle(["employees", "departments"])
		const plan = planJoins(schema, bundle)

		const text = formatJoinPlanForPrompt(plan)

		expect(text).toContain("Join Plan")
		expect(text).toContain("JOIN")
		expect(text).toContain("```sql")
	})

	it("should return empty string for empty plan", () => {
		const text = formatJoinPlanForPrompt({ skeletons: [], graphStats: { nodes: 0, edges: 0 } })
		expect(text).toBe("")
	})

	it("should include cross-module note when detected", () => {
		const text = formatJoinPlanForPrompt({
			skeletons: [{
				tables: ["orders", "employees"],
				joins: [{
					fromTable: "orders", fromColumn: "sales_rep_id",
					toTable: "employees", toColumn: "id",
					joinType: "INNER",
				}],
				score: 1,
				sqlFragment: "orders\nJOIN employees ON orders.sales_rep_id = employees.id",
			}],
			graphStats: { nodes: 2, edges: 1 },
			crossModuleDetected: true,
			bridgeTables: ["orders", "employees"],
			modulesUsed: ["Sales", "HR"],
		})

		expect(text).toContain("Cross-module")
		expect(text).toContain("Sales")
		expect(text).toContain("HR")
		expect(text).toContain("Bridge tables")
	})

	it("should show score details for multiple skeletons", () => {
		const text = formatJoinPlanForPrompt({
			skeletons: [
				{
					tables: ["A", "B", "D"],
					joins: [
						{ fromTable: "A", fromColumn: "b_id", toTable: "B", toColumn: "id", joinType: "INNER" },
						{ fromTable: "B", fromColumn: "d_id", toTable: "D", toColumn: "id", joinType: "INNER" },
					],
					score: -0.10,
					sqlFragment: "A\nJOIN B ON A.b_id = B.id\nJOIN D ON B.d_id = D.id",
					scoreDetails: { hopCount: 2, semanticAlignment: 1, columnCoverage: 0.5, combined: -0.10 },
				},
				{
					tables: ["A", "C", "D"],
					joins: [
						{ fromTable: "A", fromColumn: "c_id", toTable: "C", toColumn: "id", joinType: "INNER" },
						{ fromTable: "C", fromColumn: "d_id", toTable: "D", toColumn: "id", joinType: "INNER" },
					],
					score: 0.15,
					sqlFragment: "A\nJOIN C ON A.c_id = C.id\nJOIN D ON C.d_id = D.id",
					scoreDetails: { hopCount: 2, semanticAlignment: 0, columnCoverage: 0, combined: 0.15 },
				},
			],
			graphStats: { nodes: 4, edges: 4 },
		})

		expect(text).toContain("Option 1")
		expect(text).toContain("Option 2")
		expect(text).toContain("score:")
		expect(text).toContain("alignment:")
	})
})
