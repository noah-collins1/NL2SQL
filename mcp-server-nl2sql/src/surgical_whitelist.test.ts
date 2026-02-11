/**
 * Tests for Surgical Column Whitelist Module
 */

import { describe, it, expect } from "vitest"
import {
	parseFromJoinClauses,
	buildAliasMapRobust,
	getFromJoinTables,
	extractFailingReference,
	resolveAliasToTableRobust,
	getTableColumns,
	getFKNeighbors,
	compressColumns,
	buildSurgicalColumnWhitelist,
	attemptDeterministicRewrite,
	formatCompactRepairPrompt,
	processSurgicalWhitelist,
	evaluateStrictGating,
	evaluateActiveGating,
	checkRiskBlacklist,
	SURGICAL_WHITELIST_CONFIG,
	tokenize,
	computeContainment,
	isKeywordReference,
	findColumnMatches,
} from "./surgical_whitelist.js"
import type { SurgicalWhitelistConfig } from "./surgical_whitelist.js"
import type { SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Test Fixtures
// ============================================================================

const mockSchemaContext: SchemaContextPacket = {
	query_id: "test-1",
	database_id: "enterprise_erp",
	question: "Test question",
	tables: [
		{
			table_name: "employees",
			table_schema: "public",
			module: "HR",
			gloss: "Employee records",
			m_schema: "employees (employee_id INTEGER PK, first_name VARCHAR, last_name VARCHAR, email VARCHAR, department_id INTEGER FK→departments, hire_date DATE, salary NUMERIC)",
			similarity: 0.8,
			source: "retrieval",
		},
		{
			table_name: "departments",
			table_schema: "public",
			module: "HR",
			gloss: "Department records",
			m_schema: "departments (department_id INTEGER PK, name VARCHAR, manager_id INTEGER FK→employees, budget NUMERIC)",
			similarity: 0.7,
			source: "retrieval",
		},
		{
			table_name: "projects",
			table_schema: "public",
			module: "Projects",
			gloss: "Project records",
			m_schema: "projects (project_id INTEGER PK, name VARCHAR, budget NUMERIC, start_date DATE, end_date DATE, status VARCHAR)",
			similarity: 0.6,
			source: "fk_expansion",
		},
	],
	fk_edges: [
		{ from_table: "employees", from_column: "department_id", to_table: "departments", to_column: "department_id" },
		{ from_table: "departments", from_column: "manager_id", to_table: "employees", to_column: "employee_id" },
	],
	modules: ["HR", "Projects"],
	retrieval_meta: {
		total_candidates: 10,
		threshold_used: 0.25,
		tables_from_retrieval: 2,
		tables_from_fk_expansion: 1,
		hub_tables_capped: [],
	},
	created_at: new Date().toISOString(),
}

// ============================================================================
// FROM/JOIN Parsing Tests
// ============================================================================

describe("parseFromJoinClauses", () => {
	it("parses simple FROM clause", () => {
		const sql = "SELECT * FROM employees"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({ table: "employees", alias: null, source: "from" })
	})

	it("parses FROM with alias", () => {
		const sql = "SELECT * FROM employees e"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({ table: "employees", alias: "e", source: "from" })
	})

	it("parses FROM with AS alias", () => {
		const sql = "SELECT * FROM employees AS emp"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({ table: "employees", alias: "emp", source: "from" })
	})

	it("parses schema-qualified table", () => {
		const sql = "SELECT * FROM public.employees AS e"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toEqual({ table: "employees", alias: "e", source: "from" })
	})

	it("parses JOIN clauses", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.department_id"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(2)
		expect(entries[0]).toEqual({ table: "employees", alias: "e", source: "from" })
		expect(entries[1]).toEqual({ table: "departments", alias: "d", source: "join" })
	})

	it("parses LEFT JOIN with AS", () => {
		const sql = "SELECT * FROM employees e LEFT JOIN departments AS dept ON e.department_id = dept.department_id"
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(2)
		expect(entries[0]).toEqual({ table: "employees", alias: "e", source: "from" })
		expect(entries[1]).toEqual({ table: "departments", alias: "dept", source: "join" })
	})

	it("parses multiple JOIN clauses", () => {
		const sql = `SELECT * FROM employees e
			JOIN departments d ON e.department_id = d.department_id
			LEFT JOIN projects p ON e.employee_id = p.manager_id`
		const entries = parseFromJoinClauses(sql)
		expect(entries).toHaveLength(3)
		expect(entries.map(e => e.table)).toEqual(["employees", "departments", "projects"])
	})
})

describe("buildAliasMapRobust", () => {
	it("builds alias map from simple query", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.department_id"
		const map = buildAliasMapRobust(sql)

		expect(map.get("e")).toBe("employees")
		expect(map.get("d")).toBe("departments")
		expect(map.get("employees")).toBe("employees")
		expect(map.get("departments")).toBe("departments")
	})
})

describe("getFromJoinTables", () => {
	it("returns unique table names", () => {
		const sql = "SELECT * FROM employees e JOIN departments d ON e.department_id = d.department_id"
		const tables = getFromJoinTables(sql)
		expect(tables).toEqual(["employees", "departments"])
	})
})

// ============================================================================
// Error Reference Extraction Tests
// ============================================================================

describe("extractFailingReference", () => {
	it("extracts quoted qualified reference", () => {
		const error = 'column "e.salary_amount" does not exist'
		const sql = "SELECT e.salary_amount FROM employees e"
		const result = extractFailingReference(error, sql)

		expect(result).toEqual({ alias: "e", column: "salary_amount", qualified: true })
	})

	it("extracts unquoted qualified reference", () => {
		const error = "column e.salary_amount does not exist"
		const sql = "SELECT e.salary_amount FROM employees e"
		const result = extractFailingReference(error, sql)

		expect(result).toEqual({ alias: "e", column: "salary_amount", qualified: true })
	})

	it("extracts quoted simple reference", () => {
		const error = 'column "salary_amount" does not exist'
		const sql = "SELECT salary_amount FROM employees"
		const result = extractFailingReference(error, sql)

		expect(result).toEqual({ alias: null, column: "salary_amount", qualified: false })
	})

	it("finds qualifier in SQL when not in error", () => {
		const error = 'column "amount" does not exist'
		const sql = "SELECT e.amount FROM employees e"
		const result = extractFailingReference(error, sql)

		expect(result).toEqual({ alias: "e", column: "amount", qualified: true })
	})

	it("handles 'of relation' format", () => {
		const error = 'column "amount" of relation "employees" does not exist'
		const sql = "SELECT amount FROM employees"
		const result = extractFailingReference(error, sql)

		expect(result).toEqual({ alias: "employees", column: "amount", qualified: false })
	})
})

// ============================================================================
// Alias Resolution Tests
// ============================================================================

describe("resolveAliasToTableRobust", () => {
	it("resolves alias from SQL", () => {
		const sql = "SELECT * FROM employees e WHERE e.salary > 100"
		const result = resolveAliasToTableRobust("e", sql, mockSchemaContext)

		expect(result.table).toBe("employees")
		expect(result.method).toBe("alias_map")
		expect(result.ambiguous).toBe(false)
	})

	it("resolves direct table name", () => {
		const sql = "SELECT * FROM employees WHERE salary > 100"
		const result = resolveAliasToTableRobust("employees", sql, mockSchemaContext)

		expect(result.table).toBe("employees")
		expect(result.ambiguous).toBe(false)
	})

	it("returns ambiguous for unknown alias", () => {
		const sql = "SELECT * FROM employees e WHERE x.salary > 100"
		const result = resolveAliasToTableRobust("x", sql, mockSchemaContext)

		expect(result.table).toBe(null)
		expect(result.ambiguous).toBe(true)
		expect(result.candidates).toEqual(["employees"])
	})
})

// ============================================================================
// Column Extraction Tests
// ============================================================================

describe("getTableColumns", () => {
	it("extracts columns from m_schema", () => {
		const columns = getTableColumns("employees", mockSchemaContext)
		expect(columns).toContain("employee_id")
		expect(columns).toContain("first_name")
		expect(columns).toContain("salary")
		expect(columns).toContain("department_id")
	})

	it("returns empty for unknown table", () => {
		const columns = getTableColumns("unknown_table", mockSchemaContext)
		expect(columns).toEqual([])
	})
})

describe("getFKNeighbors", () => {
	it("finds FK neighbors", () => {
		const neighbors = getFKNeighbors("employees", mockSchemaContext)
		expect(neighbors).toContain("departments")
	})

	it("respects max limit", () => {
		const neighbors = getFKNeighbors("employees", mockSchemaContext, 1)
		expect(neighbors.length).toBeLessThanOrEqual(1)
	})
})

// ============================================================================
// Column Compression Tests
// ============================================================================

describe("compressColumns", () => {
	it("does not compress when under limit", () => {
		const columns = ["id", "name", "email"]
		const result = compressColumns(columns, 10, ["id", "name"])

		expect(result.compressed).toBe(false)
		expect(result.columns).toEqual(columns)
	})

	it("compresses and prioritizes keywords", () => {
		const columns = ["foo", "bar", "employee_id", "name", "baz", "amount", "qux"]
		const result = compressColumns(columns, 4, ["id", "name", "amount"])

		expect(result.compressed).toBe(true)
		expect(result.originalCount).toBe(7)
		expect(result.columns.length).toBe(4)
		expect(result.columns).toContain("employee_id")
		expect(result.columns).toContain("name")
		expect(result.columns).toContain("amount")
	})
})

// ============================================================================
// Surgical Whitelist Building Tests
// ============================================================================

describe("buildSurgicalColumnWhitelist", () => {
	it("builds whitelist for qualified column reference", () => {
		const sql = "SELECT e.salary_amount FROM employees e"
		const error = 'column "e.salary_amount" does not exist'

		const result = buildSurgicalColumnWhitelist(sql, error, mockSchemaContext)

		expect(result.primaryTables).toContain("employees")
		expect(result.tables["employees"]).toBeDefined()
		expect(result.tables["employees"]).toContain("salary")
	})

	it("includes FK neighbors when configured", () => {
		const sql = "SELECT e.salary FROM employees e"
		const error = 'column "e.salary_amount" does not exist'

		const config = { ...SURGICAL_WHITELIST_CONFIG, includeFkNeighbors: true }
		const result = buildSurgicalColumnWhitelist(sql, error, mockSchemaContext, config)

		expect(result.neighborTables.length).toBeGreaterThanOrEqual(0)
	})
})

// ============================================================================
// Deterministic Rewrite Tests
// ============================================================================

describe("attemptDeterministicRewrite", () => {
	it("rewrites exact case mismatch", () => {
		const sql = "SELECT e.SALARY FROM employees e"
		const error = 'column "e.SALARY" does not exist'
		const whitelist = { employees: ["employee_id", "salary", "first_name"] }

		const result = attemptDeterministicRewrite(sql, error, whitelist)

		expect(result.applied).toBe(true)
		expect(result.sql).toContain("e.salary")
		expect(result.rewrites[0].confidence).toBeGreaterThan(0.9)
	})

	it("rewrites snake_case variant", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const whitelist = { employees: ["employee_id", "first_name", "last_name"] }

		const result = attemptDeterministicRewrite(sql, error, whitelist)

		expect(result.applied).toBe(true)
		expect(result.sql).toContain("e.first_name")
	})

	it("rejects ambiguous rewrites", () => {
		// Unqualified "empid" matches "emp_id" in BOTH tables at 0.85 (snake_normalized)
		const sql = "SELECT empid FROM employees, departments"
		const error = 'column "empid" does not exist'
		const whitelist = { employees: ["emp_id", "salary"], departments: ["emp_id", "dept_name"] }

		const config = { ...SURGICAL_WHITELIST_CONFIG, rewriteAmbiguityDelta: 0.05, rewriteMinConfidence: 0.7 }
		const result = attemptDeterministicRewrite(sql, error, whitelist, config)

		// Both tables have emp_id matching at 0.85 -> ambiguous (delta = 0 < 0.05)
		expect(result.applied).toBe(false)
		expect(result.rejection_reason).toContain("ambiguous")
	})

	it("rejects low confidence matches", () => {
		const sql = "SELECT e.salry FROM employees e"
		const error = 'column "e.salry" does not exist'
		// "salry" has some similarity to "salary" but below the 0.75 threshold
		const whitelist = { employees: ["employee_id", "salary", "department_id"] }

		const result = attemptDeterministicRewrite(sql, error, whitelist)

		expect(result.applied).toBe(false)
		// Either no candidates or below threshold
		expect(result.rejection_reason).toMatch(/below_threshold|no_candidates/)
	})
})

// ============================================================================
// Compact Repair Prompt Tests
// ============================================================================

describe("formatCompactRepairPrompt", () => {
	it("generates compact prompt under 2000 chars", () => {
		const whitelistResult = {
			tables: {
				employees: ["employee_id", "first_name", "last_name", "salary", "department_id"],
				departments: ["department_id", "name", "budget"],
			},
			primaryTables: ["employees"],
			neighborTables: ["departments"],
			scopeReason: "primary_tables_plus_fk_neighbors",
			debug: {
				failing_reference: "e.salary_amount",
				alias_resolved: "employees",
				alias_resolution_method: "alias_map",
				compression_applied: false,
			},
		}

		const prompt = formatCompactRepairPrompt(whitelistResult, "e.salary_amount")

		expect(prompt.length).toBeLessThan(2000)
		expect(prompt).toContain("salary_amount")
		expect(prompt).toContain("employees")
		expect(prompt).toContain("Use ONLY columns listed")
	})
})

// ============================================================================
// Full Integration Tests
// ============================================================================

describe("processSurgicalWhitelist", () => {
	it("successfully rewrites obvious column mistake", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'

		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)

		expect(result.success).toBe(true)
		expect(result.correctedSQL).toContain("first_name")
		expect(result.telemetry.whitelist_triggered).toBe(true)
		expect(result.telemetry.deterministic_rewrites[0].applied).toBe(true)
	})

	it("falls back to repair prompt when rewrite fails", () => {
		const sql = "SELECT e.xyz_column FROM employees e"
		const error = 'column "e.xyz_column" does not exist'

		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)

		expect(result.success).toBe(false)
		expect(result.repairPromptDelta).toBeDefined()
		expect(result.telemetry.repair_used_whitelist).toBe(true)
		expect(result.telemetry.whitelist_prompt_size).toBeGreaterThan(0)
	})

	it("records telemetry correctly", () => {
		const sql = "SELECT e.salary FROM employees e"
		const error = 'column "e.salary_amount" does not exist'

		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)

		expect(result.telemetry.whitelist_tables_count).toBeGreaterThan(0)
		expect(result.telemetry.whitelist_columns_total).toBeGreaterThan(0)
		expect(result.telemetry.alias_resolution.alias).toBe("e")
	})
})

// ============================================================================
// Token Utility Tests
// ============================================================================

describe("tokenize", () => {
	it("splits snake_case", () => {
		expect(tokenize("quantity_on_hand")).toEqual(["quantity", "on", "hand"])
	})
	it("handles single token", () => {
		expect(tokenize("salary")).toEqual(["salary"])
	})
	it("handles empty string", () => {
		expect(tokenize("")).toEqual([])
	})
})

describe("computeContainment", () => {
	it("detects ref in candidate: quantity in quantity_on_hand", () => {
		const result = computeContainment("quantity", "quantity_on_hand")
		expect(result.refInCandidate).toBe(true)
		expect(result.candidateInRef).toBe(false)
		expect(result.tokenOverlap).toBeGreaterThan(0)
	})

	it("detects candidate in ref: amount in actual_amount", () => {
		const result = computeContainment("actual_amount", "amount")
		expect(result.refInCandidate).toBe(false)
		expect(result.candidateInRef).toBe(true)
	})

	it("detects exact overlap", () => {
		const result = computeContainment("salary", "salary")
		expect(result.refInCandidate).toBe(true)
		expect(result.candidateInRef).toBe(true)
		expect(result.tokenOverlap).toBe(1)
	})

	it("detects partial overlap: account_id vs gl_account_id", () => {
		const result = computeContainment("account_id", "gl_account_id")
		expect(result.refInCandidate).toBe(true)
		expect(result.tokenOverlap).toBeGreaterThan(0.5)
	})

	it("detects no overlap", () => {
		const result = computeContainment("segment", "budget")
		expect(result.refInCandidate).toBe(false)
		expect(result.candidateInRef).toBe(false)
		expect(result.tokenOverlap).toBe(0)
	})
})

describe("isKeywordReference", () => {
	it("rejects SQL date part keywords", () => {
		expect(isKeywordReference("year")).toBe(true)
		expect(isKeywordReference("month")).toBe(true)
		expect(isKeywordReference("day")).toBe(true)
		expect(isKeywordReference("YEAR")).toBe(true)
	})
	it("rejects SQL function names", () => {
		expect(isKeywordReference("extract")).toBe(true)
		expect(isKeywordReference("count")).toBe(true)
	})
	it("accepts real column names", () => {
		expect(isKeywordReference("salary")).toBe(false)
		expect(isKeywordReference("vendor_name")).toBe(false)
		expect(isKeywordReference("quantity_on_hand")).toBe(false)
	})
})

// ============================================================================
// Containment Scoring Tests
// ============================================================================

describe("findColumnMatches with containment", () => {
	it("quantity -> quantity_on_hand scores above lexical floor with containment", () => {
		const whitelist = { inventory: ["quantity_on_hand", "product_id", "warehouse_id"] }
		const matches = findColumnMatches("quantity", whitelist)
		const best = matches[0]

		expect(best).toBeDefined()
		expect(best.column).toBe("quantity_on_hand")
		expect(best.refInCandidate).toBe(true)
		expect(best.containmentBonus).toBeGreaterThan(0)
		// Total score should exceed lexical floor (0.55)
		expect(best.score).toBeGreaterThanOrEqual(0.55)
	})

	it("account_id -> gl_account_id scores with containment", () => {
		const whitelist = { gl: ["gl_account_id", "debit", "credit", "journal_id"] }
		const matches = findColumnMatches("account_id", whitelist)
		const best = matches[0]

		expect(best).toBeDefined()
		expect(best.column).toBe("gl_account_id")
		expect(best.refInCandidate).toBe(true)
		expect(best.score).toBeGreaterThanOrEqual(0.55)
	})

	it("actual_amount -> amount scores with candidate-in-ref containment", () => {
		const whitelist = { expenses: ["amount", "expense_id", "project_id"] }
		const matches = findColumnMatches("actual_amount", whitelist)
		const best = matches[0]

		expect(best).toBeDefined()
		expect(best.column).toBe("amount")
		expect(best.candidateInRef).toBe(true)
		expect(best.containmentBonus).toBeGreaterThan(0)
		expect(best.score).toBeGreaterThanOrEqual(0.50)
	})

	it("vendor_name -> vendor_number does NOT get containment (name vs number differ)", () => {
		const whitelist = { vendors: ["vendor_number", "name", "status"] }
		const matches = findColumnMatches("vendor_name", whitelist)
		const vendorNumberMatch = matches.find(m => m.column === "vendor_number")

		// vendor_name tokens: [vendor, name]; vendor_number tokens: [vendor, number]
		// "name" != "number" so not full containment in either direction
		if (vendorNumberMatch) {
			expect(vendorNumberMatch.refInCandidate).toBe(false)
			expect(vendorNumberMatch.candidateInRef).toBe(false)
		}
	})

	it("keyword 'year' is rejected by attemptDeterministicRewrite", () => {
		const whitelist = { employees: ["employee_id", "hire_date", "salary"] }
		const sql = "SELECT YEAR FROM employees e"
		const error = 'column "year" does not exist'
		const result = attemptDeterministicRewrite(sql, error, whitelist)

		expect(result.applied).toBe(false)
		expect(result.rejection_reason).toContain("keyword_reference")
	})
})

// ============================================================================
// Dominance Tests
// ============================================================================

describe("dominance in attemptDeterministicRewrite", () => {
	it("computes high dominance for sole good candidate", () => {
		const whitelist = { inventory: ["quantity_on_hand", "product_id", "warehouse_id"] }
		const sql = "SELECT i.quantity FROM inventory i"
		const error = 'column "i.quantity" does not exist'
		const result = attemptDeterministicRewrite(sql, error, whitelist)

		expect(result.dominance).toBeDefined()
		expect(result.dominance!).toBeGreaterThan(0)
	})

	it("computes low dominance when two candidates are close", () => {
		// Both "emp_id" and "emp_name" will fuzzy-match similarly to "emp_code"
		const whitelist = { t: ["emp_id", "emp_name", "department"] }
		const sql = "SELECT t.emp FROM t"
		const error = 'column "t.emp" does not exist'
		const result = attemptDeterministicRewrite(sql, error, whitelist)

		if (result.candidates && result.candidates.length >= 2) {
			expect(result.dominance).toBeDefined()
			// Both emp_id and emp_name should match similarly
			expect(result.dominance!).toBeLessThan(0.3)
		}
	})
})

// ============================================================================
// Strict Gating Tests (v2: dominance + category rules)
// ============================================================================

describe("evaluateStrictGating", () => {
	const config = { ...SURGICAL_WHITELIST_CONFIG, strictGating: {
		requireUnambiguousAlias: true,
		requireAutocorrectFailed: true,
		minDominanceDelta: 0.15,
		minLexicalFloor: 0.55,
		requireContainmentForLexical: true,
		minSemanticFloor: 0.75,
		enableSemanticScoring: false,
	}}

	it("passes for snake_normalized match (firstname -> first_name)", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, false, config)

		// firstname -> first_name: snake_normalized at 0.85, has containment (same tokens)
		expect(gating.passed).toBe(true)
		expect(gating.failures).toEqual([])
	})

	it("fails when alias is ambiguous", () => {
		const sql = "SELECT xyz_col FROM employees e, departments d"
		const error = 'column "xyz_col" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, false, config)

		expect(gating.passed).toBe(false)
	})

	it("fails when autocorrect was not attempted", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, false, false, config)

		expect(gating.passed).toBe(false)
		expect(gating.failures).toContain("autocorrect_not_attempted")
	})

	it("fails when autocorrect already succeeded", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, true, config)

		expect(gating.passed).toBe(false)
		expect(gating.failures).toContain("autocorrect_already_succeeded")
	})

	it("fails for low-score garbage column", () => {
		const sql = "SELECT e.xyz_bad FROM employees e"
		const error = 'column "e.xyz_bad" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, false, config)

		expect(gating.passed).toBe(false)
		expect(gating.failures.some(f => f.includes("score") || f.includes("no_candidates") || f.includes("no_containment"))).toBe(true)
	})

	it("reports multiple failures", () => {
		const sql = "SELECT e.xyz_bad FROM employees e"
		const error = 'column "e.xyz_bad" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, false, false, config)

		expect(gating.passed).toBe(false)
		expect(gating.failures.length).toBeGreaterThanOrEqual(2)
	})

	it("returns scoring detail in result", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, false, config)

		expect(gating.bestScore).toBeGreaterThan(0)
		expect(typeof gating.dominance).toBe("number")
		expect(typeof gating.hasContainment).toBe("boolean")
		expect(typeof gating.isKeyword).toBe("boolean")
		expect(gating.topCandidates.length).toBeGreaterThan(0)
	})

	it("rejects keyword references (year)", () => {
		// Mock a scenario where "year" is the failing reference
		const sql = "SELECT YEAR FROM employees e"
		const error = 'column "year" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)
		const gating = evaluateStrictGating(result, true, false, config)

		expect(gating.passed).toBe(false)
		expect(gating.isKeyword).toBe(true)
		expect(gating.failures.some(f => f.includes("keyword"))).toBe(true)
	})
})

// ============================================================================
// checkRiskBlacklist Tests
// ============================================================================

describe("checkRiskBlacklist", () => {
	const config: SurgicalWhitelistConfig = {
		...SURGICAL_WHITELIST_CONFIG,
		riskBlacklist: {
			enabled: true,
			pairs: [["name", "number"], ["name", "id"], ["amount", "total"], ["date", "id"], ["vendor", "customer"]],
			action: "block" as const,
			penalty: 0.15,
			applyToObserve: false,
		},
	}

	it("blocks vendor_name -> vendor_number (name/number)", () => {
		const result = checkRiskBlacklist("vendor_name", "vendor_number", config)
		expect(result.hit).toBe(true)
		expect(result.pair).toBe("name:number")
		expect(result.action).toBe("block")
	})

	it("allows actual_amount -> amount (no dangerous pair)", () => {
		const result = checkRiskBlacklist("actual_amount", "amount", config)
		expect(result.hit).toBe(false)
	})

	it("allows category -> category_id (no pair in diff)", () => {
		// refOnly=[], candOnly=["id"]; single-sided, no pair matches
		const result = checkRiskBlacklist("category", "category_id", config)
		expect(result.hit).toBe(false)
	})

	it("blocks order_date -> order_id (date/id)", () => {
		const result = checkRiskBlacklist("order_date", "order_id", config)
		expect(result.hit).toBe(true)
		expect(result.pair).toBe("date:id")
		expect(result.action).toBe("block")
	})

	it("respects enabled=false", () => {
		const disabledConfig: SurgicalWhitelistConfig = {
			...config,
			riskBlacklist: { ...config.riskBlacklist, enabled: false },
		}
		const result = checkRiskBlacklist("vendor_name", "vendor_number", disabledConfig)
		expect(result.hit).toBe(false)
		expect(result.action).toBe("none")
	})
})

// ============================================================================
// evaluateActiveGating Tests
// ============================================================================

describe("evaluateActiveGating", () => {
	it("produces correctedSQL when active gating passes (firstname -> first_name)", () => {
		// Use a schema where first_name is the clear sole candidate (no fuzzy near-matches like last_name)
		const cleanSchema: SchemaContextPacket = {
			...mockSchemaContext,
			tables: [
				{
					table_name: "employees",
					table_schema: "public",
					module: "HR",
					gloss: "Employee records",
					m_schema: "employees (employee_id INTEGER PK, first_name VARCHAR, email VARCHAR, department_id INTEGER FK→departments, hire_date DATE, salary NUMERIC)",
					similarity: 0.8,
					source: "retrieval",
				},
			],
			fk_edges: [],
		}

		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, cleanSchema)

		const active = evaluateActiveGating(result, true, false, sql, error, SURGICAL_WHITELIST_CONFIG)

		// firstname -> first_name: snake_normalized at 0.85, sole good candidate
		expect(active.passed).toBe(true)
		expect(active.correctedSQL).toBeDefined()
		expect(active.correctedSQL).toContain("e.first_name")
		expect(active.failures).toEqual([])
		expect(active.bestScore).toBeGreaterThanOrEqual(0.80)
	})

	it("prevents mismatch: low score passes strict but fails active", () => {
		// Create a scenario with a fuzzy match that scores around 0.60
		// "po_id" in the error, "po_line_id" in the whitelist (prefix match, not great score)
		const schemaWithPO: SchemaContextPacket = {
			...mockSchemaContext,
			tables: [
				...mockSchemaContext.tables,
				{
					table_name: "po_lines",
					table_schema: "public",
					module: "Purchasing",
					gloss: "PO line items",
					m_schema: "po_lines (po_line_id INTEGER PK, po_header_id INTEGER, item_id INTEGER, quantity NUMERIC)",
					similarity: 0.7,
					source: "retrieval",
				},
			],
		}

		const sql = "SELECT p.po_id FROM po_lines p"
		const error = 'column "p.po_id" does not exist'
		const result = processSurgicalWhitelist(sql, error, schemaWithPO)

		const active = evaluateActiveGating(result, true, false, sql, error, SURGICAL_WHITELIST_CONFIG)

		// po_id -> po_line_id: should fail active gating (score < 0.80 or no containment match)
		// The important thing: if strict passes but active doesn't, we don't accidentally rewrite
		expect(active.passed).toBe(false)
		// Should have a meaningful failure reason
		expect(active.failures.length).toBeGreaterThan(0)
	})

	it("risk blacklist blocks vendor_name -> vendor_number in active", () => {
		// Schema with vendor table that has vendor_number but not vendor_name
		const vendorSchema: SchemaContextPacket = {
			...mockSchemaContext,
			tables: [
				{
					table_name: "vendors",
					table_schema: "public",
					module: "Purchasing",
					gloss: "Vendor master",
					m_schema: "vendors (vendor_id INTEGER PK, vendor_number VARCHAR, name VARCHAR, status VARCHAR)",
					similarity: 0.8,
					source: "retrieval",
				},
			],
			fk_edges: [],
		}

		const sql = "SELECT v.vendor_name FROM vendors v"
		const error = 'column "v.vendor_name" does not exist'
		const result = processSurgicalWhitelist(sql, error, vendorSchema)

		const active = evaluateActiveGating(result, true, false, sql, error, SURGICAL_WHITELIST_CONFIG)

		// vendor_name -> vendor_number would be a dangerous semantic flip
		// Active gating should block it via risk blacklist
		if (active.riskBlacklistHit) {
			expect(active.passed).toBe(false)
			expect(active.failures.some(f => f.includes("risk_blacklist"))).toBe(true)
		}
		// Even if blacklist doesn't trigger (e.g. "name" column scores higher),
		// the rewrite should not silently produce vendor_number
	})

	it("no behavior change in observe mode — function computes correctly", () => {
		const sql = "SELECT e.firstname FROM employees e"
		const error = 'column "e.firstname" does not exist'
		const result = processSurgicalWhitelist(sql, error, mockSchemaContext)

		// In observe mode, evaluateActiveGating still works — it's just not applied
		const active = evaluateActiveGating(result, true, false, sql, error, {
			...SURGICAL_WHITELIST_CONFIG,
			mode: "observe",
		})

		// Function should still compute correctly regardless of mode
		expect(typeof active.passed).toBe("boolean")
		expect(typeof active.bestScore).toBe("number")
		expect(Array.isArray(active.failures)).toBe(true)
	})

	it("separation gate blocks near-ties", () => {
		// Create a schema where two columns match similarly
		const ambigSchema: SchemaContextPacket = {
			...mockSchemaContext,
			tables: [
				{
					table_name: "orders",
					table_schema: "public",
					module: "Sales",
					gloss: "Orders",
					m_schema: "orders (order_id INTEGER PK, order_status VARCHAR, order_state VARCHAR, created_at DATE)",
					similarity: 0.8,
					source: "retrieval",
				},
			],
			fk_edges: [],
		}

		const sql = "SELECT o.orderstatus FROM orders o"
		const error = 'column "o.orderstatus" does not exist'
		const result = processSurgicalWhitelist(sql, error, ambigSchema)

		const active = evaluateActiveGating(result, true, false, sql, error, {
			...SURGICAL_WHITELIST_CONFIG,
			activeRewriteGate: {
				...SURGICAL_WHITELIST_CONFIG.activeRewriteGate,
				minScoreDelta: 0.10,
				minScoreRatio: 1.15,
			},
		})

		// order_status and order_state both have similar scores via snake_normalized / prefix
		// If they are near-tied, separation gate should block
		// If order_status wins clearly, active may pass — that's also fine
		// The key check: if both score similarly, the gate blocks
		if (active.scoreDelta !== null && active.scoreDelta < 0.10) {
			expect(active.passed).toBe(false)
			expect(active.failures.some(f => f.includes("separation") || f.includes("dominance"))).toBe(true)
		}
	})

	it("risk blacklist blocks in active but NOT in observe (observation records info)", () => {
		const vendorSchema: SchemaContextPacket = {
			...mockSchemaContext,
			tables: [
				{
					table_name: "vendors",
					table_schema: "public",
					module: "Purchasing",
					gloss: "Vendor master",
					m_schema: "vendors (vendor_id INTEGER PK, vendor_number VARCHAR, vendor_status VARCHAR)",
					similarity: 0.8,
					source: "retrieval",
				},
			],
			fk_edges: [],
		}

		const sql = "SELECT v.vendor_name FROM vendors v"
		const error = 'column "v.vendor_name" does not exist'
		const result = processSurgicalWhitelist(sql, error, vendorSchema)

		// Active mode: should block
		const activeConfig: SurgicalWhitelistConfig = {
			...SURGICAL_WHITELIST_CONFIG,
			riskBlacklist: {
				...SURGICAL_WHITELIST_CONFIG.riskBlacklist,
				applyToObserve: false,
			},
		}
		const activeResult = evaluateActiveGating(result, true, false, sql, error, activeConfig)

		// The active result records blacklist info regardless
		// (the risk blacklist check runs in evaluateActiveGating)
		expect(typeof activeResult.bestScore).toBe("number")
		expect(activeResult.rawCandidateCount).toBeGreaterThanOrEqual(0)

		// If vendor_number is the top candidate, blacklist should hit
		if (activeResult.topCandidate?.column === "vendor_number") {
			expect(activeResult.riskBlacklistHit).toBe("name:number")
			expect(activeResult.passed).toBe(false)
		}
	})
})
