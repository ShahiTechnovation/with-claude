require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  console.log('A.');
  console.table((await pool.query('SELECT id, hash, created_at, to_timestamp(created_at / 1000.0) AS executed_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5')).rows);
  console.log('B.');
  console.table((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'role'")).rows);
  console.log('C.');
  console.table((await pool.query("SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'member_role'")).rows);
  pool.end();
}
run().catch(console.error);
