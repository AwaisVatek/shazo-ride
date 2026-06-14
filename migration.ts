import { db } from "./src/db/index.js";

async function run() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS fare_settings (
        id TEXT PRIMARY KEY,
        service_type TEXT NOT NULL UNIQUE,
        service_label TEXT NOT NULL,
        base_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
        per_km_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
        per_minute_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
        minimum_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
        cancellation_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
        night_surcharge NUMERIC(10,2) NOT NULL DEFAULT 0,
        peak_time_multiplier NUMERIC(10,2) NOT NULL DEFAULT 1,
        free_waiting_minutes INTEGER NOT NULL DEFAULT 0,
        waiting_charge_per_minute NUMERIC(10,2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS commission_settings (
        id TEXT PRIMARY KEY,
        service_type TEXT NOT NULL UNIQUE,
        service_label TEXT NOT NULL,
        commission_type TEXT NOT NULL DEFAULT 'percentage',
        commission_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
        minimum_platform_cut NUMERIC(10,2) NOT NULL DEFAULT 0,
        driver_share_percentage NUMERIC(10,2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log('Tables created successfully');
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
