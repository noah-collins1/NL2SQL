import { describe, it, expect } from "vitest"
import { pgNormalize } from "./pg_normalize.js"

describe("pgNormalize", () => {
	describe("YEAR/MONTH/DAY → EXTRACT", () => {
		it("should transform YEAR(col) to EXTRACT(YEAR FROM col)", () => {
			const result = pgNormalize("SELECT YEAR(hire_date) FROM employees")
			expect(result.sql).toBe("SELECT EXTRACT(YEAR FROM hire_date) FROM employees")
			expect(result.applied).toContain("YEAR_TO_EXTRACT")
			expect(result.changed).toBe(true)
		})

		it("should transform MONTH(col) to EXTRACT(MONTH FROM col)", () => {
			const result = pgNormalize("SELECT MONTH(created_at) FROM orders")
			expect(result.sql).toBe("SELECT EXTRACT(MONTH FROM created_at) FROM orders")
			expect(result.applied).toContain("MONTH_TO_EXTRACT")
		})

		it("should transform DAY(col) to EXTRACT(DAY FROM col)", () => {
			const result = pgNormalize("SELECT DAY(ship_date) FROM orders")
			expect(result.sql).toBe("SELECT EXTRACT(DAY FROM ship_date) FROM orders")
			expect(result.applied).toContain("DAY_TO_EXTRACT")
		})

		it("should handle case-insensitive function names", () => {
			const result = pgNormalize("SELECT year(hire_date) FROM employees")
			expect(result.sql).toBe("SELECT EXTRACT(YEAR FROM hire_date) FROM employees")
		})

		it("should handle multiple extracts in one query", () => {
			const result = pgNormalize(
				"SELECT YEAR(hire_date), MONTH(hire_date) FROM employees"
			)
			expect(result.sql).toBe(
				"SELECT EXTRACT(YEAR FROM hire_date), EXTRACT(MONTH FROM hire_date) FROM employees"
			)
			expect(result.applied).toContain("YEAR_TO_EXTRACT")
			expect(result.applied).toContain("MONTH_TO_EXTRACT")
		})
	})

	describe("IFNULL/ISNULL/NVL → COALESCE", () => {
		it("should transform IFNULL(a, b) to COALESCE(a, b)", () => {
			const result = pgNormalize("SELECT IFNULL(amount, 0) FROM orders")
			expect(result.sql).toBe("SELECT COALESCE(amount, 0) FROM orders")
			expect(result.applied).toContain("IFNULL_TO_COALESCE")
		})

		it("should transform ISNULL(a, b) to COALESCE(a, b)", () => {
			const result = pgNormalize("SELECT ISNULL(name, 'N/A') FROM employees")
			expect(result.sql).toBe("SELECT COALESCE(name, 'N/A') FROM employees")
			expect(result.applied).toContain("ISNULL_TO_COALESCE")
		})

		it("should transform NVL(a, b) to COALESCE(a, b)", () => {
			const result = pgNormalize("SELECT NVL(salary, 0) FROM employees")
			expect(result.sql).toBe("SELECT COALESCE(salary, 0) FROM employees")
			expect(result.applied).toContain("NVL_TO_COALESCE")
		})
	})

	describe("DATE_ADD/DATE_SUB → INTERVAL arithmetic", () => {
		it("should transform DATE_ADD(d, INTERVAL 30 DAY)", () => {
			const result = pgNormalize("SELECT DATE_ADD(hire_date, INTERVAL 30 DAY) FROM employees")
			expect(result.sql).toBe("SELECT hire_date + INTERVAL '30 DAY' FROM employees")
			expect(result.applied).toContain("DATE_ADD_TO_INTERVAL")
		})

		it("should transform DATE_SUB(d, INTERVAL 7 DAY)", () => {
			const result = pgNormalize("SELECT DATE_SUB(end_date, INTERVAL 7 DAY) FROM projects")
			expect(result.sql).toBe("SELECT end_date - INTERVAL '7 DAY' FROM projects")
			expect(result.applied).toContain("DATE_SUB_TO_INTERVAL")
		})

		it("should handle MONTH interval unit", () => {
			const result = pgNormalize("SELECT DATE_ADD(start_date, INTERVAL 3 MONTH) FROM contracts")
			expect(result.sql).toBe("SELECT start_date + INTERVAL '3 MONTH' FROM contracts")
		})
	})

	describe("DATEDIFF → date subtraction", () => {
		it("should transform DATEDIFF(a, b)", () => {
			const result = pgNormalize("SELECT DATEDIFF(end_date, start_date) FROM projects")
			expect(result.sql).toBe("SELECT (end_date::date - start_date::date) FROM projects")
			expect(result.applied).toContain("DATEDIFF_TO_SUBTRACT")
		})
	})

	describe("GROUP_CONCAT → STRING_AGG", () => {
		it("should transform GROUP_CONCAT(expr)", () => {
			const result = pgNormalize("SELECT GROUP_CONCAT(name) FROM employees GROUP BY dept_id")
			expect(result.sql).toBe("SELECT STRING_AGG(name::text, ', ') FROM employees GROUP BY dept_id")
			expect(result.applied).toContain("GROUP_CONCAT_TO_STRING_AGG")
		})
	})

	describe("MySQL LIMIT offset → LIMIT OFFSET", () => {
		it("should transform LIMIT n, m to LIMIT m OFFSET n", () => {
			const result = pgNormalize("SELECT * FROM employees LIMIT 10, 5")
			expect(result.sql).toBe("SELECT * FROM employees LIMIT 5 OFFSET 10")
			expect(result.applied).toContain("MYSQL_LIMIT_OFFSET")
		})
	})

	describe("Backtick removal", () => {
		it("should remove backtick identifiers", () => {
			const result = pgNormalize("SELECT `name`, `salary` FROM `employees`")
			expect(result.sql).toBe("SELECT name, salary FROM employees")
			expect(result.applied).toContain("REMOVE_BACKTICKS")
		})
	})

	describe("::date_trunc() cast fix", () => {
		it("should fix expr::date_trunc('month', expr) to date_trunc('month', expr)", () => {
			const result = pgNormalize(
				"SELECT os.expected_close_date::date_trunc('month', expected_close_date) FROM sales_opportunities os"
			)
			expect(result.sql).toBe(
				"SELECT date_trunc('month', expected_close_date) FROM sales_opportunities os"
			)
			expect(result.applied).toContain("DATE_TRUNC_CAST_FIX")
			expect(result.changed).toBe(true)
		})

		it("should not modify valid date_trunc function call", () => {
			const sql = "SELECT date_trunc('month', order_date) FROM orders"
			const result = pgNormalize(sql)
			expect(result.sql).toBe(sql)
			expect(result.changed).toBe(false)
		})
	})

	describe("No-op for valid PG SQL", () => {
		it("should not modify already-valid PostgreSQL SQL", () => {
			const sql = "SELECT e.name, e.salary FROM employees e WHERE e.department_id = 1 ORDER BY e.salary DESC LIMIT 10"
			const result = pgNormalize(sql)
			expect(result.sql).toBe(sql)
			expect(result.applied).toEqual([])
			expect(result.changed).toBe(false)
		})

		it("should not modify EXTRACT that already exists", () => {
			const sql = "SELECT EXTRACT(YEAR FROM hire_date) FROM employees"
			const result = pgNormalize(sql)
			expect(result.sql).toBe(sql)
			expect(result.changed).toBe(false)
		})

		it("should not modify COALESCE that already exists", () => {
			const sql = "SELECT COALESCE(amount, 0) FROM orders"
			const result = pgNormalize(sql)
			expect(result.sql).toBe(sql)
			expect(result.changed).toBe(false)
		})
	})

	describe("Complex SQL with multiple patterns", () => {
		it("should apply multiple transforms in one query", () => {
			const sql = "SELECT YEAR(hire_date), IFNULL(salary, 0) FROM `employees` WHERE hire_date > DATE_SUB(CURRENT_DATE, INTERVAL 365 DAY)"
			const result = pgNormalize(sql)
			expect(result.sql).toBe(
				"SELECT EXTRACT(YEAR FROM hire_date), COALESCE(salary, 0) FROM employees WHERE hire_date > CURRENT_DATE - INTERVAL '365 DAY'"
			)
			expect(result.applied.length).toBeGreaterThanOrEqual(3)
			expect(result.changed).toBe(true)
		})
	})

	describe("Edge cases", () => {
		it("should handle empty string", () => {
			const result = pgNormalize("")
			expect(result.sql).toBe("")
			expect(result.changed).toBe(false)
		})

		it("should handle whitespace-only string", () => {
			const result = pgNormalize("   ")
			expect(result.sql).toBe("   ")
			expect(result.changed).toBe(false)
		})
	})
})
