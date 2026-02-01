/**
 * Test autocorrect functionality with a single failing question
 */

import pg from "pg"
import { executeNLQuery } from "../src/nl_query_tool.js"

const { Pool } = pg

async function test() {
  const pool = new Pool({
    connectionString: "postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp"
  })

  const logger = {
    info: (msg: string, data?: any) => {
      if (msg.includes("Autocorrect")) {
        console.log("[INFO]", msg, JSON.stringify(data || {}, null, 2))
      }
    },
    debug: (msg: string, data?: any) => {
      if (msg.includes("Autocorrect") || msg.includes("autocorrect")) {
        console.log("[DEBUG]", msg, JSON.stringify(data || {}, null, 2))
      }
    },
    warn: (msg: string, data?: any) => {
      console.warn("[WARN]", msg, data ? JSON.stringify(data).substring(0, 300) : "")
    },
    error: (msg: string, data?: any) => {
      console.error("[ERROR]", msg, data ? JSON.stringify(data).substring(0, 300) : "")
    },
  }

  console.log("Testing autocorrect with: 'What fiscal years exist in the system?'")
  console.log("=" .repeat(70))

  const result = await executeNLQuery({
    question: "What fiscal years exist in the system?",
    max_rows: 10,
  }, { pool, logger })

  console.log("\n" + "=".repeat(70))
  console.log("RESULT")
  console.log("=".repeat(70))
  console.log("Executed:", result.executed)
  console.log("SQL:", result.sql_generated)
  console.log("Rows returned:", result.rows_returned)
  console.log("Notes:", result.notes)
  if (result.error) {
    console.log("Error:", result.error)
  }
  if (result.rows && result.rows.length > 0) {
    console.log("Sample rows:", JSON.stringify(result.rows.slice(0, 3), null, 2))
  }

  await pool.end()
}

test().catch(err => {
  console.error(err)
  process.exit(1)
})
