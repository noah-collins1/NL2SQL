import { describe, it, expect } from "vitest"
import {
	extractTableRefsFromSQL,
	extractColumnRefsFromSQL,
	extractJoinsFromSQL,
	buildAliasMap,
	computeSchemaAdherence,
	computeJoinMatch,
	computeResultShape,
	detectExpectedShape,
	detectActualShape,
	extractWhereValues,
	HeuristicReranker,
} from "./candidate_reranker.js"
import type { SchemaLinkBundle } from "./schema_linker.js"
import type { JoinPlan } from "./join_planner.js"
import type { SchemaContextPacket } from "./schema_types.js"
import type { SQLCandidate } from "./multi_candidate.js"

// ============================================================================
// Helpers
// ============================================================================

function makeSchemaContext(tables: Array<{ name: string; columns: string[] }>): SchemaContextPacket {
	return {
		query_id: "test",
		database_id: "test",
		question: "test",
		tables: tables.map(t => ({
			table_name: t.name,
			table_schema: "public",
			module: "test",
			gloss: `${t.name} table`,
			m_schema: `${t.name} [${t.columns.map(c => `${c}: text`).join(", ")}]`,
			similarity: 0.8,
			source: "retrieval" as const,
		})),
		fk_edges: [],
		modules: ["test"],
		retrieval_meta: {
			total_candidates: 10,
			threshold_used: 0.25,
			tables_from_retrieval: tables.length,
			tables_from_fk_expansion: 0,
			hub_tables_capped: [],
		},
		created_at: new Date().toISOString(),
	}
}

function makeBundle(linked: Record<string, string[]>): SchemaLinkBundle {
	return {
		linkedTables: Object.keys(linked).map(t => ({ table: t, relevance: 0.9, reason: "test" })),
		linkedColumns: Object.fromEntries(
			Object.entries(linked).map(([table, cols]) => [
				table,
				cols.map(c => ({ column: c, relevance: 0.8, concept: "test" })),
			]),
		),
		joinHints: [],
		valueHints: [],
		unsupportedConcepts: [],
	}
}

function makeJoinPlan(skeletons: Array<{
	tables: string[]
	joins: Array<{ fromTable: string; fromColumn: string; toTable: string; toColumn: string }>
}>): JoinPlan {
	return {
		skeletons: skeletons.map((s, i) => ({
			tables: s.tables,
			joins: s.joins.map(j => ({ ...j, joinType: "INNER" as const })),
			score: i,
			sqlFragment: "",
		})),
		graphStats: { nodes: 5, edges: 4 },
	}
}

function makeCandidate(sql: string, index: number, score = 100): SQLCandidate {
	return {
		sql,
		index,
		score,
		scoreBreakdown: {
			base: 100,
			lintErrors: 0,
			lintWarnings: 0,
			explainResult: "pass",
			explainPenalty: 0,
			preExecErrors: 0,
			heuristicBonuses: [],
			totalBonus: 0,
			finalScore: score,
		},
		structuralValid: true,
		structuralIssues: [],
		lintResult: null,
		explainPassed: true,
		explainError: null,
		explainSqlstate: null,
		rejected: false,
		rejectionReason: null,
	}
}

// ============================================================================
// extractTableRefsFromSQL
// ============================================================================

describe("extractTableRefsFromSQL", () => {
	it("extracts tables from simple SELECT", () => {
		const sql = "SELECT * FROM employees LIMIT 10"
		expect(extractTableRefsFromSQL(sql)).toEqual(["employees"])
	})

	it("extracts tables from JOIN", () => {
		const sql = "SELECT e.name FROM employees e JOIN departments d ON e.dept_id = d.id LIMIT 10"
		expect(extractTableRefsFromSQL(sql)).toContain("employees")
		expect(extractTableRefsFromSQL(sql)).toContain("departments")
	})

	it("extracts tables from multiple JOINs", () => {
		const sql = `SELECT e.name, d.name, p.title
			FROM employees e
			LEFT JOIN departments d ON e.dept_id = d.id
			INNER JOIN projects p ON e.project_id = p.id
			LIMIT 10`
		const tables = extractTableRefsFromSQL(sql)
		expect(tables).toContain("employees")
		expect(tables).toContain("departments")
		expect(tables).toContain("projects")
	})

	it("deduplicates tables", () => {
		const sql = "SELECT * FROM employees e JOIN employees e2 ON e.manager_id = e2.id LIMIT 10"
		expect(extractTableRefsFromSQL(sql)).toEqual(["employees"])
	})

	it("skips SQL keywords after FROM", () => {
		const sql = "SELECT * FROM (SELECT id FROM employees) sub LIMIT 10"
		const tables = extractTableRefsFromSQL(sql)
		// Should not include "select" or "(", but might include "employees"
		expect(tables).not.toContain("select")
	})
})

// ============================================================================
// extractColumnRefsFromSQL
// ============================================================================

describe("extractColumnRefsFromSQL", () => {
	it("extracts qualified column refs", () => {
		const sql = "SELECT e.name, e.salary FROM employees e LIMIT 10"
		const refs = extractColumnRefsFromSQL(sql)
		expect(refs).toContainEqual({ table: "e", column: "name" })
		expect(refs).toContainEqual({ table: "e", column: "salary" })
	})

	it("ignores string literals", () => {
		const sql = "SELECT * FROM employees WHERE name = 'John Smith' LIMIT 10"
		const refs = extractColumnRefsFromSQL(sql)
		const colNames = refs.map(r => r.column)
		expect(colNames).not.toContain("john")
		expect(colNames).not.toContain("smith")
	})

	it("filters SQL keywords", () => {
		const sql = "SELECT COUNT(*) FROM employees WHERE status = 'active' LIMIT 10"
		const refs = extractColumnRefsFromSQL(sql)
		const colNames = refs.map(r => r.column)
		expect(colNames).not.toContain("count")
		expect(colNames).toContain("status")
	})
})

// ============================================================================
// buildAliasMap
// ============================================================================

describe("buildAliasMap", () => {
	it("maps aliases from FROM clause", () => {
		const sql = "SELECT e.name FROM employees e LIMIT 10"
		const map = buildAliasMap(sql)
		expect(map.get("e")).toBe("employees")
	})

	it("maps aliases with AS keyword", () => {
		const sql = "SELECT e.name FROM employees AS e LIMIT 10"
		const map = buildAliasMap(sql)
		expect(map.get("e")).toBe("employees")
	})

	it("maps aliases from JOIN clauses", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.dept_id = d.id LIMIT 10"
		const map = buildAliasMap(sql)
		expect(map.get("e")).toBe("employees")
		expect(map.get("d")).toBe("departments")
	})

	it("does not map SQL keywords as aliases", () => {
		const sql = "SELECT * FROM employees LEFT JOIN departments ON employees.dept_id = departments.id LIMIT 10"
		const map = buildAliasMap(sql)
		expect(map.has("left")).toBe(false)
	})
})

// ============================================================================
// extractJoinsFromSQL
// ============================================================================

describe("extractJoinsFromSQL", () => {
	it("extracts simple JOIN ON condition", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.id LIMIT 10"
		const joins = extractJoinsFromSQL(sql)
		expect(joins.length).toBe(1)
		expect(joins[0]).toEqual({
			leftTable: "employees",
			rightTable: "departments",
			leftColumn: "department_id",
			rightColumn: "id",
		})
	})

	it("extracts multiple JOIN conditions", () => {
		const sql = `SELECT * FROM employees e
			JOIN departments d ON e.department_id = d.id
			JOIN projects p ON e.project_id = p.id
			LIMIT 10`
		const joins = extractJoinsFromSQL(sql)
		expect(joins.length).toBe(2)
	})

	it("handles compound ON clause (AND)", () => {
		const sql = `SELECT * FROM order_items oi
			JOIN orders o ON oi.order_id = o.id AND oi.company_id = o.company_id
			LIMIT 10`
		const joins = extractJoinsFromSQL(sql)
		expect(joins.length).toBe(2)
		expect(joins[0].leftColumn).toBe("order_id")
		expect(joins[1].leftColumn).toBe("company_id")
	})

	it("resolves aliases to table names", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.dept_id = d.id LIMIT 10"
		const joins = extractJoinsFromSQL(sql)
		expect(joins[0].leftTable).toBe("employees")
		expect(joins[0].rightTable).toBe("departments")
	})

	it("returns empty array for queries without JOINs", () => {
		const sql = "SELECT * FROM employees WHERE id = 1 LIMIT 10"
		expect(extractJoinsFromSQL(sql)).toEqual([])
	})
})

// ============================================================================
// computeSchemaAdherence
// ============================================================================

describe("computeSchemaAdherence", () => {
	it("returns 1.0 when all tables and columns are known", () => {
		const sql = "SELECT e.name, e.salary FROM employees e LIMIT 10"
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name", "salary", "department_id"] },
		])
		const result = computeSchemaAdherence(sql, null, ctx)
		expect(result.tableScore).toBe(1.0)
		expect(result.columnScore).toBe(1.0)
		expect(result.combined).toBe(1.0)
	})

	it("penalizes hallucinated tables", () => {
		const sql = "SELECT * FROM employees e JOIN fake_table f ON e.id = f.emp_id LIMIT 10"
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name"] },
		])
		const result = computeSchemaAdherence(sql, null, ctx)
		expect(result.tableScore).toBe(0.5) // 1 of 2 tables found
		expect(result.tablesFound).toBe(1)
		expect(result.tablesTotal).toBe(2)
	})

	it("uses schema link bundle for column lookup", () => {
		const sql = "SELECT e.full_name FROM employees e LIMIT 10"
		const bundle = makeBundle({ employees: ["full_name", "hire_date"] })
		const result = computeSchemaAdherence(sql, bundle, null)
		expect(result.columnScore).toBe(1.0)
	})

	it("returns 1.0 when no context available", () => {
		const sql = "SELECT * FROM employees LIMIT 10"
		const result = computeSchemaAdherence(sql, null, null)
		expect(result.combined).toBe(1.0)
	})

	it("penalizes hallucinated columns", () => {
		const sql = "SELECT e.name, e.hallucinated_col FROM employees e LIMIT 10"
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name", "salary"] },
		])
		const result = computeSchemaAdherence(sql, null, ctx)
		expect(result.columnScore).toBe(0.5) // 1 of 2 columns found
	})
})

// ============================================================================
// computeJoinMatch
// ============================================================================

describe("computeJoinMatch", () => {
	it("returns score 1.0 when joins match exactly", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.id LIMIT 10"
		const plan = makeJoinPlan([{
			tables: ["employees", "departments"],
			joins: [{
				fromTable: "employees",
				fromColumn: "department_id",
				toTable: "departments",
				toColumn: "id",
			}],
		}])
		const result = computeJoinMatch(sql, plan)
		expect(result.score).toBe(1.0)
		expect(result.matchedJoins).toBe(1)
	})

	it("handles reversed join order", () => {
		// SQL has d.id = e.department_id (reversed from skeleton)
		const sql = "SELECT * FROM departments d JOIN employees e ON d.id = e.department_id LIMIT 10"
		const plan = makeJoinPlan([{
			tables: ["employees", "departments"],
			joins: [{
				fromTable: "employees",
				fromColumn: "department_id",
				toTable: "departments",
				toColumn: "id",
			}],
		}])
		const result = computeJoinMatch(sql, plan)
		expect(result.score).toBe(1.0)
	})

	it("returns partial score for partial match", () => {
		const sql = `SELECT * FROM employees e
			JOIN departments d ON e.department_id = d.id
			JOIN projects p ON e.project_id = p.id
			LIMIT 10`
		const plan = makeJoinPlan([{
			tables: ["employees", "departments", "projects"],
			joins: [
				{ fromTable: "employees", fromColumn: "department_id", toTable: "departments", toColumn: "id" },
				{ fromTable: "employees", fromColumn: "team_id", toTable: "projects", toColumn: "team_id" }, // Different column
			],
		}])
		const result = computeJoinMatch(sql, plan)
		expect(result.score).toBe(0.5) // 1 of 2 joins match
	})

	it("returns 1.0 when no join plan", () => {
		const sql = "SELECT * FROM employees LIMIT 10"
		const result = computeJoinMatch(sql, null)
		expect(result.score).toBe(1.0)
	})

	it("returns 0.0 when SQL has no joins but plan expects joins", () => {
		const sql = "SELECT * FROM employees LIMIT 10"
		const plan = makeJoinPlan([{
			tables: ["employees", "departments"],
			joins: [{
				fromTable: "employees",
				fromColumn: "department_id",
				toTable: "departments",
				toColumn: "id",
			}],
		}])
		const result = computeJoinMatch(sql, plan)
		expect(result.score).toBe(0.0)
	})

	it("selects best skeleton when multiple available", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.id LIMIT 10"
		const plan = makeJoinPlan([
			{
				tables: ["employees", "projects"],
				joins: [{ fromTable: "employees", fromColumn: "project_id", toTable: "projects", toColumn: "id" }],
			},
			{
				tables: ["employees", "departments"],
				joins: [{ fromTable: "employees", fromColumn: "department_id", toTable: "departments", toColumn: "id" }],
			},
		])
		const result = computeJoinMatch(sql, plan)
		expect(result.score).toBe(1.0)
		expect(result.bestSkeletonIndex).toBe(1) // Second skeleton matches
	})
})

// ============================================================================
// detectExpectedShape
// ============================================================================

describe("detectExpectedShape", () => {
	it("detects COUNT from 'how many'", () => {
		expect(detectExpectedShape("How many employees are there?").aggregation).toBe("count")
	})

	it("detects SUM from 'total'", () => {
		expect(detectExpectedShape("Total sales amount for 2024").aggregation).toBe("sum")
	})

	it("detects AVG from 'average'", () => {
		expect(detectExpectedShape("Average salary by department").aggregation).toBe("avg")
	})

	it("detects MIN from 'lowest'", () => {
		expect(detectExpectedShape("Lowest price product").aggregation).toBe("min")
	})

	it("detects MAX from 'highest'", () => {
		expect(detectExpectedShape("Highest revenue customer").aggregation).toBe("max")
	})

	it("detects GROUP BY from 'by department'", () => {
		expect(detectExpectedShape("Total sales by department").groupBy).toBe(true)
	})

	it("detects ORDER BY from 'top'", () => {
		expect(detectExpectedShape("Top 5 customers by revenue").orderBy).toBe(true)
	})

	it("returns unknown for generic questions", () => {
		expect(detectExpectedShape("What projects are in progress?").aggregation).toBe("unknown")
	})

	it("returns list for 'show all'", () => {
		expect(detectExpectedShape("Show all active projects").aggregation).toBe("list")
	})
})

// ============================================================================
// detectActualShape
// ============================================================================

describe("detectActualShape", () => {
	it("detects COUNT in SQL", () => {
		const result = detectActualShape("SELECT COUNT(*) FROM employees")
		expect(result.aggregations).toContain("count")
	})

	it("detects SUM in SQL", () => {
		const result = detectActualShape("SELECT SUM(amount) FROM sales")
		expect(result.aggregations).toContain("sum")
	})

	it("detects GROUP BY", () => {
		const result = detectActualShape("SELECT dept, COUNT(*) FROM employees GROUP BY dept")
		expect(result.hasGroupBy).toBe(true)
	})

	it("detects ORDER BY", () => {
		const result = detectActualShape("SELECT * FROM employees ORDER BY salary DESC")
		expect(result.hasOrderBy).toBe(true)
	})

	it("returns list when no aggregation", () => {
		const result = detectActualShape("SELECT name FROM employees LIMIT 10")
		expect(result.aggregations).toEqual(["list"])
	})

	it("detects multiple aggregations", () => {
		const result = detectActualShape("SELECT COUNT(*), SUM(amount), AVG(price) FROM orders")
		expect(result.aggregations).toContain("count")
		expect(result.aggregations).toContain("sum")
		expect(result.aggregations).toContain("avg")
	})
})

// ============================================================================
// computeResultShape
// ============================================================================

describe("computeResultShape", () => {
	it("scores 1.0 for matching COUNT", () => {
		const result = computeResultShape(
			"How many employees are there?",
			"SELECT COUNT(*) FROM employees",
		)
		expect(result.score).toBeGreaterThanOrEqual(0.9)
		expect(result.expectedAgg).toBe("count")
		expect(result.actualAgg).toContain("count")
	})

	it("scores 1.0 for matching SUM", () => {
		const result = computeResultShape(
			"Total sales amount for 2024",
			"SELECT SUM(amount) FROM sales WHERE year = 2024",
		)
		expect(result.score).toBeGreaterThanOrEqual(0.9)
	})

	it("scores low for COUNT when SUM expected", () => {
		const result = computeResultShape(
			"Total sales amount for 2024",
			"SELECT COUNT(*) FROM sales WHERE year = 2024",
		)
		expect(result.score).toBeLessThan(0.5)
	})

	it("boosts score for matching GROUP BY", () => {
		const result = computeResultShape(
			"Total sales by department",
			"SELECT department, SUM(amount) FROM sales GROUP BY department",
		)
		expect(result.score).toBe(1.0)
	})

	it("reduces score for missing GROUP BY", () => {
		const result = computeResultShape(
			"Total sales by department",
			"SELECT SUM(amount) FROM sales",
		)
		expect(result.score).toBeLessThan(1.0)
	})
})

// ============================================================================
// extractWhereValues
// ============================================================================

describe("extractWhereValues", () => {
	it("extracts equality string values", () => {
		const sql = "SELECT * FROM employees WHERE department = 'Sales' LIMIT 10"
		const values = extractWhereValues(sql)
		expect(values.length).toBe(1)
		expect(values[0]).toEqual({
			column: "department",
			value: "Sales",
			operator: "=",
		})
	})

	it("extracts qualified column values", () => {
		const sql = "SELECT * FROM employees e WHERE e.status = 'active' LIMIT 10"
		const values = extractWhereValues(sql)
		expect(values.length).toBe(1)
		expect(values[0].table).toBe("e")
		expect(values[0].column).toBe("status")
		expect(values[0].value).toBe("active")
	})

	it("extracts IN clause values", () => {
		const sql = "SELECT * FROM employees WHERE dept IN ('Sales', 'HR', 'Engineering') LIMIT 10"
		const values = extractWhereValues(sql)
		const inValues = values.filter(v => v.operator === "IN")
		expect(inValues.length).toBe(3)
		expect(inValues.map(v => v.value)).toContain("Sales")
		expect(inValues.map(v => v.value)).toContain("HR")
		expect(inValues.map(v => v.value)).toContain("Engineering")
	})

	it("extracts LIKE patterns", () => {
		const sql = "SELECT * FROM employees WHERE name LIKE '%Smith%' LIMIT 10"
		const values = extractWhereValues(sql)
		expect(values.length).toBe(1)
		expect(values[0].operator).toBe("LIKE")
		expect(values[0].value).toBe("%Smith%")
	})
})

// ============================================================================
// HeuristicReranker Integration
// ============================================================================

describe("HeuristicReranker", () => {
	it("applies bonuses to candidates", async () => {
		const reranker = new HeuristicReranker()
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name", "salary", "department_id"] },
			{ name: "departments", columns: ["id", "name"] },
		])

		const candidates = [
			makeCandidate("SELECT e.name FROM employees e LIMIT 10", 1, 100),
			makeCandidate("SELECT f.name FROM fake_table f LIMIT 10", 2, 100),
		]

		const result = await reranker.rerank(candidates, {
			question: "List all employee names",
			schemaLinkBundle: null,
			joinPlan: null,
			schemaContext: ctx,
		})

		// First candidate should score higher (valid table)
		expect(result.candidates[0].index).toBe(1)
		expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score)

		// Details should be present
		expect(result.rerankDetails.length).toBe(2)
		const detail1 = result.rerankDetails.find(d => d.index === 1)!
		expect(detail1.schemaAdherence.tableScore).toBe(1.0)
		expect(detail1.totalBonus).toBeGreaterThan(0)
	})

	it("preserves order when candidates have equal signals", async () => {
		const reranker = new HeuristicReranker()
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name"] },
		])

		const candidates = [
			makeCandidate("SELECT name FROM employees LIMIT 10", 1, 110),
			makeCandidate("SELECT name FROM employees LIMIT 5", 2, 100),
		]

		const result = await reranker.rerank(candidates, {
			question: "List employees",
			schemaLinkBundle: null,
			joinPlan: null,
			schemaContext: ctx,
		})

		// Candidate 1 should still be first (higher base score, same bonuses)
		expect(result.candidates[0].index).toBe(1)
	})

	it("rewards join match", async () => {
		const reranker = new HeuristicReranker()
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name", "department_id"] },
			{ name: "departments", columns: ["id", "name"] },
		])
		const plan = makeJoinPlan([{
			tables: ["employees", "departments"],
			joins: [{
				fromTable: "employees",
				fromColumn: "department_id",
				toTable: "departments",
				toColumn: "id",
			}],
		}])

		const candidates = [
			makeCandidate(
				"SELECT e.name, d.name FROM employees e JOIN departments d ON e.department_id = d.id LIMIT 10",
				1, 100,
			),
			makeCandidate(
				"SELECT e.name, d.name FROM employees e JOIN departments d ON e.id = d.name LIMIT 10",
				2, 100,
			),
		]

		const result = await reranker.rerank(candidates, {
			question: "List employees by department",
			schemaLinkBundle: null,
			joinPlan: plan,
			schemaContext: ctx,
		})

		// First candidate matches join plan, should score higher
		const detail1 = result.rerankDetails.find(d => d.index === 1)!
		const detail2 = result.rerankDetails.find(d => d.index === 2)!
		expect(detail1.joinMatch.score).toBeGreaterThan(detail2.joinMatch.score)
	})

	it("rewards correct aggregation shape", async () => {
		const reranker = new HeuristicReranker()
		const ctx = makeSchemaContext([
			{ name: "employees", columns: ["id", "name", "salary"] },
		])

		const candidates = [
			makeCandidate("SELECT COUNT(*) FROM employees", 1, 100),
			makeCandidate("SELECT SUM(salary) FROM employees", 2, 100),
		]

		const result = await reranker.rerank(candidates, {
			question: "How many employees are there?",
			schemaLinkBundle: null,
			joinPlan: null,
			schemaContext: ctx,
		})

		// COUNT candidate should score higher for "how many" question
		const detail1 = result.rerankDetails.find(d => d.index === 1)!
		const detail2 = result.rerankDetails.find(d => d.index === 2)!
		expect(detail1.resultShape.score).toBeGreaterThan(detail2.resultShape.score)
	})
})
