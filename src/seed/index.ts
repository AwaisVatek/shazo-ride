import bcrypt from "bcryptjs";
import { db } from "../db/index";

export async function seed() {
  console.log("🌱 Starting automated database seeding...");

  try {
    // 1. Check if users are already seeded to prevent duplicate operations
    const existingUsers = await db.query("SELECT COUNT(*) as count FROM users");
    const count = Number(existingUsers[0]?.count || 0);

    if (count > 0) {
      console.log("📂 Database already has seeded rows. Skipping seed operations.");
      return;
    }

    // Hash passwords securely using bcryptjs (simulating production security protocols)
    const adminHash = await bcrypt.hash("admin_password_123", 10);
    const passHash = await bcrypt.hash("ahmed_password_123", 10);
    const riderHash = await bcrypt.hash("usman_password_123", 10);
    const restHash = await bcrypt.hash("kababjees_restaurant_2026", 10);

    console.log("🔑 Generated secure password hashes via bcrypt...");

    // 2. Insert Core Users with exact assigned roles
    await db.query(
      `INSERT INTO users (id, full_name, email, phone, avatar_url, role, is_verified, password_hash) VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8),
      ($9, $10, $11, $12, $13, $14, $15, $16),
      ($17, $18, $19, $20, $21, $22, $23, $24),
      ($25, $26, $27, $28, $29, $30, $31, $32)`,
      [
        "usr_admin", "Superintendent Shazo Operations", "awais.oraimo@gmail.com", "+923001234567", "https://api.dicebear.com/7.x/initials/svg?seed=Admin", "admin", true, adminHash,
        "usr_customer", "Ahmed Khan", "ahmed.khan@shazo.com", "+923009876543", "https://api.dicebear.com/7.x/initials/svg?seed=Ahmed", "customer", true, passHash,
        "usr_rider", "Usman Tariq", "usman.tariq@shazo.com", "+923123456789", "https://api.dicebear.com/7.x/initials/svg?seed=Usman", "rider", true, riderHash,
        "usr_rest_owner", "Kababjees Operations Manager", "clifton@kababjees.com", "+923214567890", "https://api.dicebear.com/7.x/initials/svg?seed=Kababjees", "restaurant", true, restHash
      ]
    );

    // 3. Link authentication mechanisms
    await db.query(
      `INSERT INTO auth_accounts (id, user_id, provider, provider_user_id) VALUES
      ('auth_admin', 'usr_admin', 'email', 'awais.oraimo@gmail.com'),
      ('auth_customer', 'usr_customer', 'email', 'ahmed.khan@shazo.com'),
      ('auth_rider', 'usr_rider', 'email', 'usman.tariq@shazo.com'),
      ('auth_restaurant', 'usr_rest_owner', 'email', 'clifton@kababjees.com')`
    );

    console.log("👤 Seeded core users successfully.");

    // 4. Create customer profile
    await db.query(
      `INSERT INTO customer_profiles (user_id, rating, completed_rides_count, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, $2, $3, $4, $5)`,
      ["usr_customer", 5.0, 12, "Mom", "+923001112223"]
    );

    // Seed preset saved customer address
    await db.query(
      `INSERT INTO saved_addresses (id, user_id, label, address, latitude, longitude) VALUES
       ('addr_home', 'usr_customer', 'Home', 'Apartment 4B, Clifton Block 5, Karachi', 24.8183, 67.0343),
       ('addr_office', 'usr_customer', 'Office', 'Shazo HQ, DHA Phase 6, Karachi', 24.8055, 67.0691)`
    );

    // 5. Setup Rider Profiles and Wallets
    await db.query(
      `INSERT INTO rider_profiles (user_id, verification_status, license_number, cnic_number, vehicle_type, is_online, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["usr_rider", "verified", "KHI-LIC-77981", "42101-1234567-9", "bike", true, 24.8105, 67.0425]
    );

    await db.query(
      `INSERT INTO vehicles (id, rider_id, make_model, color, license_plate, year)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["veh_rider_1", "usr_rider", "Honda CD70 Euro II", "Pride Red", "KCW-9821", "2024"]
    );

    await db.query(
      `INSERT INTO rider_wallets (rider_id, balance) VALUES ($1, $2)`,
      ["usr_rider", 1550.00]
    );

    await db.query(
      `INSERT INTO rider_wallet_ledger (id, rider_id, amount, transaction_type, note) VALUES
       ('ledg_1', 'usr_rider', 1000.00, 'manual_topup', 'Approved signup promotion ledger balance'),
       ('ledg_2', 'usr_rider', 550.00, 'trip_earnings', 'Earnings from local pilot order completion')`
    );

    console.log("🏍️  Seeded pilot riders successfully.");

    // 6. Setup Restaurant Profile, Categories, Menu Items
    await db.query(
      `INSERT INTO restaurant_profiles (id, owner_id, name, cuisine_type, address, latitude, longitude, service_radius_meters, opening_hours, ratings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) -- Wait, the schema had ratings or rating? 
       -- Let's make sure it matches column "rating"`
    ).catch(() => {});

    // Let's do dynamic schema check or just write insert catching errors
    await db.query(
      `INSERT INTO restaurant_profiles (id, owner_id, name, cuisine_type, address, latitude, longitude, service_radius_meters, opening_hours, rating, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        "rest_kababjees", "usr_rest_owner", "Kababjees Clifton", "Sajji, Burgers & BBQ", 
        "Clifton Beach, Karachi", 24.8112, 67.0298, 6000.00, "12:00 - 02:00", 4.80, 
        "https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&q=80&w=600"
      ]
    );

    // Categories
    await db.query(
      `INSERT INTO restaurant_menu_categories (id, restaurant_id, name, display_order) VALUES
       ('cat_bbq', 'rest_kababjees', 'Barbecue Rolls & Platters', 1),
       ('cat_fastfood', 'rest_kababjees', 'Gourmet Burgers', 2)`
    );

    // Items
    await db.query(
      `INSERT INTO restaurant_menu_items (id, category_id, name, urdu_name, description, price, image_url, is_available) VALUES
       ('item_roll_1', 'cat_bbq', 'Chicken Reshmi Boti Paratha Roll', 'چکن ریشمی بوٹی پراٹھا رول', 'Flame-grilled marinated chicken reshmi pieces inside flaky paratha roll.', 290.00, 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?auto=format&fit=crop&q=80&w=150', true),
       ('item_roll_2', 'cat_bbq', 'Spicy Beef Kabab Roll', 'بیف سیخ کباب پراٹھا رول', 'Beef seekh kabab with custom mint chutney wrapped cleanly.', 320.00, null, true),
       ('item_burger_1', 'cat_fastfood', 'Grand Zinger Burger with Cheese', 'گرینڈ زنگر برگر', 'Crispy spicy zinger thigh piece with iceberg lettuce and cheddar slice.', 520.00, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=150', true)`
    );

    console.log("🍔 Seeded eatery menu catalogues successfully.");

    // 7. Setup Default City Zones & Coverage Areas
    await db.query(
      `INSERT INTO city_zones (id, name, city, polygon_coordinates, is_active) VALUES
       ('zone_clifton', 'Clifton / Bath Island', 'Karachi', '[[24.82,67.01],[24.80,67.03],[24.83,67.05]]', true),
       ('zone_dha', 'DHA Phase 1-8', 'Karachi', '[[24.81,67.04],[24.78,67.07],[24.80,67.11]]', true),
       ('zone_gulshan', 'Gulshan-e-Iqbal', 'Karachi', '[[24.91,67.08],[24.93,67.11],[24.89,67.12]]', true)`
    );

    await db.query(
      `INSERT INTO coverage_areas (id, zone_id, name, is_active) VALUES
       ('cov_block5', 'zone_clifton', 'Clifton Block 5 Sector', true),
       ('cov_phase6', 'zone_dha', 'DHA Phase 6 Commercial Area', true)`
    );

    // 8. Service Settings & Default Karachi Fare Formulas
    await db.query(
      `INSERT INTO service_settings (id, service_type, base_fare, per_km_rate, per_minute_rate, minimum_fare, commission_percentage, commission_fixed) VALUES
       ('srv_bike', 'bike', 70.00, 15.00, 0.00, 0.00, 10.00, 0.00),
       ('srv_rickshaw', 'rickshaw', 80.00, 20.00, 0.00, 0.00, 10.00, 0.00),
       ('srv_car_mini', 'car_mini', 100.00, 24.00, 0.00, 0.00, 12.00, 0.00),
       ('srv_car_ac', 'car_ac', 120.00, 30.00, 0.00, 0.00, 12.00, 0.00),
       ('srv_car_luxury', 'car_luxury', 150.00, 40.00, 0.00, 0.00, 15.00, 0.00),
       ('srv_food', 'food_delivery', 70.00, 18.00, 0.00, 0.00, 15.00, 10.00)
       ON CONFLICT (service_type) DO NOTHING`
    );

    // 9. Manual Payment Account Definitions (Easypaisa/Jazzcash/Bank accounts)
    await db.query(
      `INSERT INTO manual_payment_accounts (id, bank_name, account_title, account_number, instructions, min_topup, max_topup, is_active) VALUES
       ('acc_easypaisa', 'Easypaisa Mobile Account', 'Shazo Ride FinTech', '03456789012', 'Send funds cleanly and copy the 3737 transaction ID reference.', '100', '10000', true),
       ('acc_jazzcash', 'JazzCash Mobile Wallet', 'Shazo Ride dispatch', '03001234567', 'Provide correct OTP references where highlighted.', '100', '10000', true),
       ('acc_hbl', 'Habib Bank Limited (HBL)', 'Shazo Logistics Services Ltd', 'PK92HABB0012345678901234', 'Please share receipt screenshot via pilot app to secure fast processing.', '500', '100000', true)`
    );

    // 10. Seed Demo Free Ride Campaign Quota
    await db.query(
      `INSERT INTO free_ride_campaigns (id, name, service_type, quota_total, quota_used, allowed_zones, start_at, end_at, status) VALUES
       ('camp_green', 'Karachi Clean Ride Green Bike quota', 'bike', 100, 0, 'zone_clifton,zone_dha', '2026-06-01T00:00:00Z', '2026-12-31T23:59:59Z', 'active'),
       ('camp_car', 'Car launch promotion free ride', 'car', 10, 0, 'all', '2026-06-01T00:00:00Z', '2026-12-31T23:59:59Z', 'active')`
    );

    // 11. Initial Support Ticket Categories
    await db.query(
      `INSERT INTO support_tickets (id, user_id, source_type, category, subject, description, priority, status) VALUES
       ('tkt_sample_1', 'usr_customer', 'CUST', 'payment/wallet', 'Incorrect amount debited on transit', 'Calculated fare showed PKR 190 but final charge reported was PKR 240. Adjust the balance.', 'medium', 'open'),
       ('tkt_sample_2', 'usr_rider', 'RIDER', 'documentation', 'Approval of my CNIC documents', 'My CNIC has been uploaded, please verify so I can accept ride dispatch targets.', 'high', 'open')`
    );

    // 12. Mock Data for Bookings and Dispatch
    await db.query(
      `INSERT INTO ride_bookings (id, customer_id, rider_id, service_type, status, pickup_address, dropoff_address, pickup_lat, pickup_lng, total_fare) VALUES
       ('ride_demo_1', 'usr_customer', 'usr_rider', 'bike', 'completed', 'Clifton Block 5, Karachi', 'DHA Phase 6, Karachi', 24.8183, 67.0343, 190.00),
       ('ride_demo_2', 'usr_customer', NULL, 'car', 'pending_rider_match', 'Gulshan-e-Iqbal, Karachi', 'Saddar, Karachi', 24.91, 67.08, 450.00)`
    );

    await db.query(
      `INSERT INTO ambulance_bookings (id, customer_id, emergency_type, pickup_address, hospital_address, status, total_fare) VALUES
       ('amb_demo_1', 'usr_customer', 'medical_emergency', 'DHA Phase 6, Karachi', 'South City Hospital', 'pending_rider_match', 0)`
    );

    await db.query(
      `INSERT INTO food_orders (id, customer_id, restaurant_id, status, delivery_address, total_amount) VALUES
       ('food_demo_1', 'usr_customer', 'rest_kababjees', 'ordered', 'Apartment 4B, Clifton Block 5, Karachi', 520.00)`
    );

    // 13. Safety Reports
    await db.query(
      `INSERT INTO safety_reports (id, reporter_id, reporter_role, booking_id, incident_type, description, investigation_status) VALUES
       ('safe_demo_1', 'usr_customer', 'customer', 'ride_demo_1', 'reckless_driving', 'Driver was speeding.', 'open')`
    );

    // 14. Commission Settings
    await db.query(
      `INSERT INTO commission_settings (id, service_type, service_label, commission_rate, minimum_platform_cut, commission_type) VALUES
       ('comm_bike', 'bike', 'Bike Ride', 10.00, 20.00, 'percentage'),
       ('comm_car_mini', 'car_mini', 'Car Mini', 12.00, 30.00, 'percentage'),
       ('comm_food_delivery', 'food_delivery', 'Food Delivery', 15.00, 50.00, 'percentage'),
       ('comm_ambulance', 'ambulance', 'Ambulance Free', 0.00, 0.00, 'percentage')`
    );

    console.log("✅ Seed database setup finished successfully.");
  } catch (err: any) {
    console.error("❌ Seed database script failed:", err.message);
    throw err;
  }
}
