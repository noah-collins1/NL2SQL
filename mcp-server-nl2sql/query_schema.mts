import { Pool } from 'pg'
const pool = new Pool({ host: 'localhost', database: 'enterprise_erp_2000', user: 'postgres', password: 'postgres' })

const res = await pool.query(`
  SELECT table_name, embed_text FROM rag.schema_embeddings
  WHERE table_name IN ('customers','vendors','sales_opportunities','rtl_pos_line_items',
    'payroll_run_hdr','payroll_run_line','finance_ar_invoices','rtl_promo_products','employees')
  AND entity_type = 'table'
  ORDER BY table_name
`)
for (const r of res.rows) {
  console.log(`=== ${r.table_name} ===`)
  console.log(r.embed_text.substring(0, 500))
  console.log()
}
await pool.end()
