import { db } from "./db/index";

async function run() {
  try {
    await db.query(`
      INSERT INTO service_settings (id, service_type, base_fare, per_km_rate, per_minute_rate, minimum_fare, commission_percentage, commission_fixed) VALUES
       ('srv_rickshaw', 'rickshaw', 80.00, 20.00, 2.00, 120.00, 10.00, 0.00),
       ('srv_car_mini', 'car_mini', 120.00, 25.00, 2.50, 150.00, 12.00, 0.00),
       ('srv_car_business', 'car_business', 180.00, 45.00, 3.50, 300.00, 12.00, 0.00),
       ('srv_car_luxury', 'car_luxury', 300.00, 60.00, 5.00, 500.00, 15.00, 0.00)
       ON CONFLICT (service_type) DO NOTHING;
    `);
    console.log("Added new ride types");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
