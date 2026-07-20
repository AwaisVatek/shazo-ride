require('dotenv').config();
const { Client } = require('pg');

const names = [
  'users', 'customer_profiles', 'rider_profiles', 'rider_vehicles',
  'rider_documents', 'ride_bookings', 'ride_offers', 'ride_messages',
  'rider_wallets', 'rider_wallet_ledger', 'customer_wallets',
  'customer_wallet_ledger', 'customer_manual_topup_requests',
  'customer_saved_places', 'manual_payment_accounts', 'service_settings',
  'ambulance_bookings', 'ambulance_requests', 'food_orders',
];

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  try {
    if (process.argv.includes('--all-security')) {
      const rlsDisabled = await client.query(`
        SELECT c.relname table_name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
           AND NOT c.relrowsecurity
         ORDER BY c.relname
      `);
      const publicGrants = await client.query(`
        SELECT table_name, grantee,
               string_agg(privilege_type, ',' ORDER BY privilege_type) privileges
          FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
         GROUP BY table_name, grantee ORDER BY table_name, grantee
      `);
      const exposedDefiners = await client.query(`
        SELECT p.proname function_name,
               pg_get_function_identity_arguments(p.oid) arguments
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND has_function_privilege('anon', p.oid, 'EXECUTE')
         ORDER BY p.proname
      `);
      console.log(JSON.stringify({
        rls_disabled: rlsDisabled.rows,
        public_grants: publicGrants.rows,
        anon_callable_security_definers: exposedDefiners.rows,
      }, null, 2));
      return;
    }
    if (process.argv.includes('--migration-state')) {
      const state = await client.query(`
        SELECT 'constraint' kind, conname name, convalidated::text detail
          FROM pg_constraint
         WHERE conname IN (
           'rider_vehicles_type_check','ride_bookings_pickup_pin_check',
           'manual_topup_requests_rider_id_fkey','manual_topup_requests_transaction_id_key',
           'rider_documents_rider_type_key','rider_vehicles_rider_id_key',
           'ride_bookings_status_check','ride_offers_status_check',
           'ambulance_bookings_status_check','customer_topups_status_check',
           'rider_vehicles_rider_id_fkey'
         )
        UNION ALL
        SELECT 'index', indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
           'idx_ride_bookings_dispatch','idx_rider_wallet_ledger_history',
           'idx_manual_topups_rider_status','rider_vehicle_orphan_archive_id_key'
         )
        UNION ALL
        SELECT 'table', c.relname, c.relrowsecurity::text
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'rider_vehicle_orphan_archive'
        ORDER BY kind, name
      `);
      console.log(JSON.stringify(state.rows, null, 2));
      return;
    }
    const version = await client.query(
      "SELECT current_database() db, current_setting('server_version') version"
    );
    const tables = await client.query(
      `SELECT c.relname table_name, c.relrowsecurity rls_enabled,
              COALESCE(s.n_live_tup, 0) estimated_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [names]
    );
    const columns = await client.query(
      `SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) columns
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        GROUP BY table_name ORDER BY table_name`,
      [names]
    );
    const grants = await client.query(
      `SELECT table_name, grantee,
              string_agg(privilege_type, ',' ORDER BY privilege_type) privileges
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = ANY($1)
          AND grantee IN ('anon', 'authenticated')
        GROUP BY table_name, grantee ORDER BY table_name, grantee`,
      [names]
    );
    const policies = await client.query(
      `SELECT tablename, policyname, roles, cmd
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1)
        ORDER BY tablename, policyname`,
      [names]
    );
    const constraints = await client.query(
      `SELECT c.relname table_name, pc.conname,
              pg_get_constraintdef(pc.oid) definition
         FROM pg_constraint pc
         JOIN pg_class c ON c.oid = pc.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname, pc.conname`,
      [names]
    );
    console.log(JSON.stringify({
      version: version.rows[0],
      tables: tables.rows,
      columns: columns.rows,
      grants: grants.rows,
      policies: policies.rows,
      constraints: constraints.rows,
    }, null, 2));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
