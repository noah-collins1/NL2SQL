/**
 * Tests for Multi-Candidate SQL Generation
 */

import { parseCandidates, scoreCandidate, classifyDifficulty, MULTI_CANDIDATE_CONFIG } from "./multi_candidate.js"

// Test parseCandidates
console.log("=== Testing parseCandidates ===\n")

// Test 1: Delimiter-separated candidates
const testOutput1 = `SELECT e.name, e.email FROM employees e WHERE e.department_id = 5;
---SQL_CANDIDATE---
SELECT e.name, e.email, d.name as dept FROM employees e JOIN departments d ON e.department_id = d.id WHERE d.id = 5;
---SQL_CANDIDATE---
SELECT name, email FROM employees WHERE department_id = (SELECT id FROM departments WHERE name = 'Sales');`

const candidates1 = parseCandidates(testOutput1)
console.log("Test 1: Delimiter-separated")
console.log(`  Input has ${testOutput1.split("---SQL_CANDIDATE---").length} parts`)
console.log(`  Parsed ${candidates1.length} candidates:`)
candidates1.forEach((c, i) => console.log(`  [${i + 1}] ${c.substring(0, 80)}...`))
console.log()

// Test 2: Code block format
const testOutput2 = `Here are the candidates:

\`\`\`sql
SELECT * FROM users WHERE id = 1;
\`\`\`
---SQL_CANDIDATE---
\`\`\`sql
SELECT u.*, p.name as profile_name FROM users u JOIN profiles p ON u.id = p.user_id WHERE u.id = 1;
\`\`\``

const candidates2 = parseCandidates(testOutput2)
console.log("Test 2: Code block format")
console.log(`  Parsed ${candidates2.length} candidates:`)
candidates2.forEach((c, i) => console.log(`  [${i + 1}] ${c.substring(0, 80)}...`))
console.log()

// Test 3: Single candidate fallback
const testOutput3 = `SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 10;`

const candidates3 = parseCandidates(testOutput3)
console.log("Test 3: Single candidate fallback")
console.log(`  Parsed ${candidates3.length} candidates:`)
candidates3.forEach((c, i) => console.log(`  [${i + 1}] ${c}`))
console.log()

// Test scoreCandidate
console.log("=== Testing scoreCandidate ===\n")

const testSQL1 = "SELECT department, COUNT(*) as cnt FROM employees GROUP BY department ORDER BY cnt DESC LIMIT 10"
const score1 = scoreCandidate(
	testSQL1,
	"Show me the top 10 departments by employee count",
	{ valid: true, issues: [], hasErrors: false, metadata: { aliases: new Map(), tablesReferenced: [], columnsSelected: [], hasAggregates: true, hasGroupBy: true, groupByColumns: [] } },
	true, // EXPLAIN passed
)
console.log("Test 1: Good query with matching heuristics")
console.log(`  SQL: ${testSQL1}`)
console.log(`  Question: "Show me the top 10 departments by employee count"`)
console.log(`  Score: ${score1.finalScore}`)
console.log(`  Bonuses: ${score1.heuristicBonuses.join(", ") || "none"}`)
console.log()

const testSQL2 = "SELECT * FROM employees"
const score2 = scoreCandidate(
	testSQL2,
	"Show me the top 10 departments by employee count",
	{ valid: true, issues: [{ code: "undefined_alias", severity: "error", message: "test" }], hasErrors: true, metadata: { aliases: new Map(), tablesReferenced: [], columnsSelected: [], hasAggregates: false, hasGroupBy: false, groupByColumns: [] } },
	false, // EXPLAIN failed
)
console.log("Test 2: Poor query with lint errors and EXPLAIN failure")
console.log(`  SQL: ${testSQL2}`)
console.log(`  Score: ${score2.finalScore}`)
console.log(`  Lint errors: ${score2.lintErrors}`)
console.log(`  EXPLAIN penalty: ${score2.explainPenalty}`)
console.log()

// Test classifyDifficulty
console.log("=== Testing classifyDifficulty ===\n")

const questions = [
	{ q: "What is the email for John Smith?", expected: "easy" },
	{ q: "Show me the total revenue by department for each year", expected: "hard" },
	{ q: "List all employees", expected: "easy" },
	{ q: "Compare the performance of sales and marketing teams", expected: "hard" },
	{ q: "Which projects have the highest budgets?", expected: "medium" },
]

for (const { q, expected } of questions) {
	const difficulty = classifyDifficulty(q, null)
	const status = difficulty === expected ? "✓" : "✗"
	console.log(`${status} "${q.substring(0, 50)}..."`)
	console.log(`  Expected: ${expected}, Got: ${difficulty}`)
}
console.log()

console.log("=== Configuration ===\n")
console.log(`enabled: ${MULTI_CANDIDATE_CONFIG.enabled}`)
console.log(`k_default: ${MULTI_CANDIDATE_CONFIG.k_default}`)
console.log(`k_easy: ${MULTI_CANDIDATE_CONFIG.k_easy}`)
console.log(`k_hard: ${MULTI_CANDIDATE_CONFIG.k_hard}`)
console.log(`delimiter: "${MULTI_CANDIDATE_CONFIG.sql_delimiter}"`)
console.log(`time_budget_ms: ${MULTI_CANDIDATE_CONFIG.per_query_time_budget_ms}`)
console.log(`explain_timeout_ms: ${MULTI_CANDIDATE_CONFIG.explain_timeout_ms}`)
console.log()

console.log("All tests completed!")
