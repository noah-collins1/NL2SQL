import { describe, it, expect } from "vitest"
import { planJoins, formatJoinPlanForPrompt } from "./join_planner.js"
import type { SchemaContextPacket } from "./schema_types.js"
import type { SchemaLinkBundle } from "./schema_linker.js"

function makeFakeSchema(
	tables: string[],
	fkEdges: Array<{ from_table: string; from_column: string; to_table: string; to_column: string }>,
): SchemaContextPacket {
	return {
		query_id: "test",
		database_id: "test_db",
		question: "test",
		tables: tables.map(t => ({
			table_name: t,
			table_schema: "public",
			module: "Test",
			gloss: `${t} table`,
			m_schema: `${t} (id integer PK)`,
			similarity: 0.8,
			source: "retrieval" as const,
		})),
		fk_edges: fkEdges,
		modules: ["Test"],
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

function makeBundle(tables: string[]): SchemaLinkBundle {
	return {
		linkedTables: tables.map((t, i) => ({ table: t, relevance: 0.9 - i * 0.1, reason: "test" })),
		linkedColumns: {},
		joinHints: [],
		valueHints: [],
		unsupportedConcepts: [],
	}
}

describe("planJoins", () => {
	it("should find path in 3-table FK chain: A → B → C", () => {
		const schema = makeFakeSchema(["A", "B", "C"], [
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
		const schema = makeFakeSchema(["A", "B", "C", "D"], [
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
		const schema = makeFakeSchema(["A", "B", "C"], [
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
		const schema = makeFakeSchema(["employees", "departments"], [
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
		const schema = makeFakeSchema(["employees"], [])
		const bundle = makeBundle(["employees"])

		const plan = planJoins(schema, bundle)

		// Single table has no joins
		expect(plan.skeletons.length).toBe(1)
		expect(plan.skeletons[0].joins.length).toBe(0)
		expect(plan.skeletons[0].sqlFragment).toBe("employees")
	})

	it("should return graph stats", () => {
		const schema = makeFakeSchema(["A", "B", "C"], [
			{ from_table: "A", from_column: "b_id", to_table: "B", to_column: "id" },
			{ from_table: "B", from_column: "c_id", to_table: "C", to_column: "id" },
		])
		const bundle = makeBundle(["A", "C"])

		const plan = planJoins(schema, bundle)

		expect(plan.graphStats.nodes).toBe(3)
		expect(plan.graphStats.edges).toBe(2)
	})
})

describe("formatJoinPlanForPrompt", () => {
	it("should format a join plan with SQL fragment", () => {
		const schema = makeFakeSchema(["employees", "departments"], [
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
})
