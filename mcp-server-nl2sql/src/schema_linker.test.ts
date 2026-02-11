import { describe, it, expect } from "vitest"
import { extractKeyphrases, linkSchema } from "./schema_linker.js"
import type { SchemaContextPacket } from "./schema_types.js"

// Helper: build a tiny schema context for testing
function buildTestSchema(): SchemaContextPacket {
	return {
		query_id: "test",
		database_id: "test_db",
		question: "test",
		tables: [
			{
				table_name: "employees",
				table_schema: "public",
				module: "HR",
				gloss: "Employee records",
				m_schema: "employees (employee_id integer PK, first_name varchar, last_name varchar, hire_date date, salary numeric, department_id integer FK→departments)",
				similarity: 0.9,
				source: "retrieval",
			},
			{
				table_name: "departments",
				table_schema: "public",
				module: "HR",
				gloss: "Department info",
				m_schema: "departments (department_id integer PK, name varchar, budget numeric)",
				similarity: 0.7,
				source: "retrieval",
			},
		],
		fk_edges: [
			{ from_table: "employees", from_column: "department_id", to_table: "departments", to_column: "department_id" },
		],
		modules: ["HR"],
		retrieval_meta: {
			total_candidates: 2,
			threshold_used: 0.25,
			tables_from_retrieval: 2,
			tables_from_fk_expansion: 0,
			hub_tables_capped: [],
		},
		created_at: new Date().toISOString(),
	}
}

describe("extractKeyphrases", () => {
	it("should extract simple tokens", () => {
		const kps = extractKeyphrases("total salary by department")
		const texts = kps.map(k => k.text)
		expect(texts).toContain("salary")
		expect(texts).toContain("department")
	})

	it("should filter out stopwords", () => {
		const kps = extractKeyphrases("what is the total salary")
		const texts = kps.map(k => k.text)
		expect(texts).not.toContain("what")
		expect(texts).not.toContain("is")
		expect(texts).not.toContain("the")
	})

	it("should detect quoted values", () => {
		const kps = extractKeyphrases('employees in "Engineering" department')
		const quoted = kps.filter(k => k.isQuotedValue)
		expect(quoted.length).toBe(1)
		expect(quoted[0].text).toBe("Engineering")
	})

	it("should detect numbers", () => {
		const kps = extractKeyphrases("employees with salary above 100000")
		const numbers = kps.filter(k => k.isNumber)
		expect(numbers.length).toBe(1)
		expect(numbers[0].text).toBe("100000")
	})

	it("should detect metric words", () => {
		const kps = extractKeyphrases("total count of employees per department")
		const metrics = kps.filter(k => k.isMetric)
		expect(metrics.some(m => m.text === "total")).toBe(true)
		expect(metrics.some(m => m.text === "count")).toBe(true)
	})
})

describe("linkSchema", () => {
	it("should link 'salary' to employees.salary column", () => {
		const schema = buildTestSchema()
		const result = linkSchema("total salary by department", schema)

		// Should have linked columns
		expect(result.linkedColumns["employees"]).toBeDefined()
		const empCols = result.linkedColumns["employees"]
		const salaryMatch = empCols?.find(c => c.column === "salary")
		expect(salaryMatch).toBeDefined()
		expect(salaryMatch!.relevance).toBeGreaterThanOrEqual(0.5)
	})

	it("should link 'department' to departments table", () => {
		const schema = buildTestSchema()
		const result = linkSchema("total salary by department", schema)

		// departments table should be linked
		const deptTable = result.linkedTables.find(t => t.table === "departments")
		expect(deptTable).toBeDefined()
	})

	it("should detect quoted value hints", () => {
		const schema = buildTestSchema()
		const result = linkSchema('employees in "Engineering" department', schema)

		expect(result.valueHints.length).toBeGreaterThan(0)
		expect(result.valueHints.some(v => v.value === "Engineering")).toBe(true)
	})

	it("should populate unsupportedConcepts for unknown terms", () => {
		const schema = buildTestSchema()
		const result = linkSchema("employee certification expiry", schema)

		// "certification" and "expiry" don't match any column
		expect(result.unsupportedConcepts.some(c => c === "certification" || c === "expiry")).toBe(true)
	})

	it("should include join hints from FK edges", () => {
		const schema = buildTestSchema()
		const result = linkSchema("salary by department", schema)

		expect(result.joinHints.length).toBe(1)
		expect(result.joinHints[0].from).toBe("employees.department_id")
		expect(result.joinHints[0].to).toBe("departments.department_id")
	})

	it("should rank tables with more matched columns higher", () => {
		const schema = buildTestSchema()
		const result = linkSchema("employee name and salary and hire date", schema)

		// employees should be first (more column matches)
		const tableOrder = result.linkedTables.map(t => t.table)
		const empIdx = tableOrder.indexOf("employees")
		const deptIdx = tableOrder.indexOf("departments")

		if (empIdx !== -1 && deptIdx !== -1) {
			expect(empIdx).toBeLessThan(deptIdx)
		}
	})
})
