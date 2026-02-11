import { describe, it, expect } from "vitest"
import {
	glossColumn,
	splitSnakeCase,
	inferTypeHint,
	generateGlosses,
	type SchemaGlosses,
} from "./schema_glosses.js"
import type { SchemaContextPacket } from "./schema_types.js"

describe("splitSnakeCase", () => {
	it("should split snake_case names into tokens", () => {
		expect(splitSnakeCase("purchase_order_date")).toEqual(["purchase", "order", "date"])
	})

	it("should handle single-word names", () => {
		expect(splitSnakeCase("salary")).toEqual(["salary"])
	})

	it("should handle names with consecutive underscores", () => {
		expect(splitSnakeCase("first__name")).toEqual(["first", "name"])
	})

	it("should lowercase tokens", () => {
		expect(splitSnakeCase("EMPLOYEE_ID")).toEqual(["employee", "id"])
	})
})

describe("inferTypeHint", () => {
	it("should infer identifier for _id suffix", () => {
		expect(inferTypeHint("employee_id", "integer")).toBe("identifier/key")
	})

	it("should infer date for _date suffix", () => {
		expect(inferTypeHint("hire_date", "date")).toBe("date/timestamp")
	})

	it("should infer monetary for _amount suffix", () => {
		expect(inferTypeHint("total_amount", "numeric")).toBe("monetary amount")
	})

	it("should infer quantity for _qty suffix", () => {
		expect(inferTypeHint("order_qty", "integer")).toBe("quantity")
	})

	it("should infer name for _name suffix", () => {
		expect(inferTypeHint("first_name", "varchar")).toBe("name/label")
	})

	it("should infer status for _status suffix", () => {
		expect(inferTypeHint("order_status", "text")).toBe("status enum")
	})

	it("should infer type for _type suffix", () => {
		expect(inferTypeHint("account_type", "text")).toBe("type/category")
	})

	it("should infer code for _code suffix", () => {
		expect(inferTypeHint("currency_code", "text")).toBe("code identifier")
	})

	it("should fall back to data type for unknown names", () => {
		expect(inferTypeHint("foo", "integer")).toBe("numeric")
		expect(inferTypeHint("bar", "text")).toBe("text")
		expect(inferTypeHint("baz", "boolean")).toBe("boolean flag")
	})
})

describe("glossColumn", () => {
	it("should generate gloss for purchase_order_date", () => {
		const gloss = glossColumn("purchase_order_date", "date", false, false, null)
		expect(gloss.typeHint).toBe("date/timestamp")
		expect(gloss.synonyms).toContain("purchase")
		expect(gloss.synonyms).toContain("order")
		expect(gloss.synonyms).toContain("date")
		expect(gloss.synonyms).toContain("dt") // abbreviation
		expect(gloss.isPK).toBe(false)
		expect(gloss.isFK).toBe(false)
	})

	it("should generate gloss for employee_id PK", () => {
		const gloss = glossColumn("employee_id", "integer", true, false, null)
		expect(gloss.typeHint).toBe("identifier/key")
		expect(gloss.isPK).toBe(true)
		expect(gloss.description).toContain("Primary key")
		expect(gloss.synonyms).toContain("employee")
		expect(gloss.synonyms).toContain("emp") // abbreviation
		expect(gloss.synonyms).toContain("id")
		expect(gloss.synonyms).toContain("identifier") // abbreviation expansion
	})

	it("should generate gloss for FK column", () => {
		const gloss = glossColumn("department_id", "integer", false, true, "departments")
		expect(gloss.isFK).toBe(true)
		expect(gloss.fkTarget).toBe("departments")
		expect(gloss.description).toContain("departments")
		expect(gloss.synonyms).toContain("department")
		expect(gloss.synonyms).toContain("dept") // abbreviation
	})

	it("should include monetary type hint for salary", () => {
		const gloss = glossColumn("base_salary", "numeric", false, false, null)
		expect(gloss.typeHint).toBe("monetary amount")
	})

	it("should include quantity type hint for qty columns", () => {
		const gloss = glossColumn("order_qty", "integer", false, false, null)
		expect(gloss.typeHint).toBe("quantity")
		expect(gloss.synonyms).toContain("qty")
		expect(gloss.synonyms).toContain("quantity") // abbreviation expansion
	})
})

describe("generateGlosses", () => {
	it("should generate glosses for a fake schema context", () => {
		const schemaContext: SchemaContextPacket = {
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
					similarity: 0.8,
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

		const glosses = generateGlosses(schemaContext)

		// Should have entries for all columns across all tables
		expect(glosses.size).toBe(9) // 6 employee cols + 3 department cols

		// Check specific entries
		const empId = glosses.get("employees.employee_id")
		expect(empId).toBeDefined()
		expect(empId!.isPK).toBe(true)
		expect(empId!.typeHint).toBe("identifier/key")

		const salary = glosses.get("employees.salary")
		expect(salary).toBeDefined()
		expect(salary!.typeHint).toBe("monetary amount")

		const hireDate = glosses.get("employees.hire_date")
		expect(hireDate).toBeDefined()
		expect(hireDate!.typeHint).toBe("date/timestamp")

		const deptId = glosses.get("employees.department_id")
		expect(deptId).toBeDefined()
		expect(deptId!.isFK).toBe(true)
		expect(deptId!.fkTarget).toBe("departments")

		const deptName = glosses.get("departments.name")
		expect(deptName).toBeDefined()
	})

	it("should produce deterministic output for same input", () => {
		const schemaContext: SchemaContextPacket = {
			query_id: "test",
			database_id: "test_db",
			question: "test",
			tables: [
				{
					table_name: "orders",
					table_schema: "public",
					module: "Sales",
					gloss: "Orders",
					m_schema: "orders (order_id integer PK, customer_id integer FK→customers, order_date date, total_amount numeric)",
					similarity: 0.9,
					source: "retrieval",
				},
			],
			fk_edges: [],
			modules: ["Sales"],
			retrieval_meta: { total_candidates: 1, threshold_used: 0.25, tables_from_retrieval: 1, tables_from_fk_expansion: 0, hub_tables_capped: [] },
			created_at: new Date().toISOString(),
		}

		const glosses1 = generateGlosses(schemaContext)
		const glosses2 = generateGlosses(schemaContext)

		expect(glosses1.size).toBe(glosses2.size)
		for (const [key, gloss1] of glosses1) {
			const gloss2 = glosses2.get(key)
			expect(gloss2).toBeDefined()
			expect(gloss1.typeHint).toBe(gloss2!.typeHint)
			expect(gloss1.description).toBe(gloss2!.description)
		}
	})
})
