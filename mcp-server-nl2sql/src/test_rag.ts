import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://postgres:1219@172.28.91.130:5432/enterprise_erp'
});

async function test() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT COUNT(*) FROM rag.schema_embeddings');
    console.log('Count:', result.rows[0].count);
  } finally {
    client.release();
    await pool.end();
  }
}

test().catch(e => console.error('Error:', e.message));
