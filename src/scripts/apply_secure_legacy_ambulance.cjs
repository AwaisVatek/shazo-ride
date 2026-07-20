require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.ambulance_requests') IS NOT NULL THEN
          ALTER TABLE public.ambulance_requests ENABLE ROW LEVEL SECURITY;
          REVOKE ALL PRIVILEGES ON TABLE public.ambulance_requests FROM anon, authenticated;
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
    console.log('Legacy ambulance table secured.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
