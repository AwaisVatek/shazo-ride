-- ==========================================
-- SHAZO RIDE SYSTEM INITIAL POSTGRES SCHEMA
-- ==========================================

-- --- CORE ---

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(80) PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50) UNIQUE,
  avatar_url VARCHAR(512),
  role VARCHAR(50) NOT NULL DEFAULT 'customer', -- customer, rider, restaurant, admin, support_agent, finance_admin, operations_manager
  is_verified BOOLEAN NOT NULL DEFAULT false,
  password_hash VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL, -- email, phone_otp, google, facebook
  provider_user_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id VARCHAR(80) PRIMARY KEY,
  phone VARCHAR(50) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_delivery_logs (
  id VARCHAR(80) PRIMARY KEY,
  phone VARCHAR(50) NOT NULL,
  channel VARCHAR(50) NOT NULL, -- whatsapp, email, sms
  provider VARCHAR(50) NOT NULL, -- evolution, smtp, mock
  status VARCHAR(50) NOT NULL, -- sent, failed, pending
  external_id VARCHAR(255),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  role VARCHAR(50) NOT NULL,
  action VARCHAR(255) NOT NULL,
  target_table VARCHAR(100),
  target_row_id VARCHAR(100),
  notes TEXT,
  ip_address VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_settings (
  id VARCHAR(80) PRIMARY KEY,
  service_type VARCHAR(50) UNIQUE NOT NULL, -- bike, car, ambulance, food_delivery
  base_fare NUMERIC(10,2) NOT NULL,
  per_km_rate NUMERIC(10,2) NOT NULL,
  per_minute_rate NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  minimum_fare NUMERIC(10,2) NOT NULL,
  commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  commission_fixed NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS city_zones (
  id VARCHAR(80) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL DEFAULT 'Karachi',
  polygon_coordinates TEXT, -- storage block for polygon boundaries
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coverage_areas (
  id VARCHAR(80) PRIMARY KEY,
  zone_id VARCHAR(80) REFERENCES city_zones(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS places_cache (
  query TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS geocode_cache (
  address_or_coords TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS route_cache (
  origin_destination TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- CUSTOMER ---

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id VARCHAR(80) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  completed_rides_count INTEGER NOT NULL DEFAULT 0,
  emergency_contact_phone VARCHAR(50),
  emergency_contact_name VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_addresses (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL, -- Home, Office, Gym, Mom's
  address VARCHAR(512) NOT NULL,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  place_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- RIDER ---

CREATE TABLE IF NOT EXISTS rider_profiles (
  user_id VARCHAR(80) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, verified, rejected, suspended
  license_number VARCHAR(100),
  cnic_number VARCHAR(100),
  vehicle_type VARCHAR(50), -- bike, car
  is_online BOOLEAN NOT NULL DEFAULT false,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  last_location_update TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id VARCHAR(80) PRIMARY KEY,
  rider_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make_model VARCHAR(255) NOT NULL,
  color VARCHAR(50) NOT NULL,
  license_plate VARCHAR(50) UNIQUE NOT NULL,
  year VARCHAR(10) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rider_documents (
  id VARCHAR(80) PRIMARY KEY,
  rider_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type VARCHAR(100) NOT NULL, -- cnic_front, cnic_back, license_front, vehicle_reg
  file_url VARCHAR(512) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending_review', -- pending_review, approved, rejected
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rider_wallets (
  rider_id VARCHAR(80) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rider_wallet_ledger (
  id VARCHAR(80) PRIMARY KEY,
  rider_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL, -- positive for credits, negative for debits
  transaction_type VARCHAR(50) NOT NULL, -- trip_earnings, platform_commission, manual_topup, bonus, penalty, payout
  reference_id VARCHAR(80), -- references a booking_id or payout_request_id
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- RESTAURANT ---

CREATE TABLE IF NOT EXISTS restaurant_profiles (
  id VARCHAR(80) PRIMARY KEY,
  owner_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name VARCHAR(255) NOT NULL,
  cuisine_type VARCHAR(255) NOT NULL,
  address VARCHAR(512) NOT NULL,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  service_radius_meters NUMERIC(10,2) NOT NULL DEFAULT 5000.00,
  opening_hours VARCHAR(100) NOT NULL DEFAULT '09:00 - 23:00',
  is_active BOOLEAN NOT NULL DEFAULT true,
  image_url VARCHAR(512),
  rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_menu_categories (
  id VARCHAR(80) PRIMARY KEY,
  restaurant_id VARCHAR(80) NOT NULL REFERENCES restaurant_profiles(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_menu_items (
  id VARCHAR(80) PRIMARY KEY,
  category_id VARCHAR(80) NOT NULL REFERENCES restaurant_menu_categories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  urdu_name VARCHAR(255),
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  image_url VARCHAR(512),
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- RIDE BOOKINGS ---

CREATE TABLE IF NOT EXISTS ride_bookings (
  id VARCHAR(80) PRIMARY KEY,
  customer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rider_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  pickup_address VARCHAR(512) NOT NULL,
  pickup_lat NUMERIC(10,7) NOT NULL,
  pickup_lng NUMERIC(10,7) NOT NULL,
  pickup_place_id VARCHAR(255),
  dropoff_address VARCHAR(512) NOT NULL,
  dropoff_lat NUMERIC(10,7) NOT NULL,
  dropoff_lng NUMERIC(10,7) NOT NULL,
  dropoff_place_id VARCHAR(255),
  distance_km NUMERIC(6,2) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  route_polyline TEXT,
  ride_type VARCHAR(50) NOT NULL, -- bike, car
  fare NUMERIC(10,2) NOT NULL,
  commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'cash', -- cash, wallet
  promo_code_used VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'requested', -- requested, accepted, arrived, in_transit, completed, cancelled
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ride_status_logs (
  id VARCHAR(80) PRIMARY KEY,
  ride_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ride_offers (
  id VARCHAR(80) PRIMARY KEY,
  ride_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  by_role VARCHAR(50) NOT NULL, -- rider, customer
  offerer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_fare NUMERIC(10,2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, accepted, counter_offered, rejected
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- AMBULANCE BOOKINGS ---

CREATE TABLE IF NOT EXISTS ambulance_bookings (
  id VARCHAR(80) PRIMARY KEY,
  customer_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  patient_name VARCHAR(255) NOT NULL,
  contact_number VARCHAR(100) NOT NULL,
  pickup_address VARCHAR(512) NOT NULL,
  pickup_lat NUMERIC(10,7) NOT NULL,
  pickup_lng NUMERIC(10,7) NOT NULL,
  destination_hospital VARCHAR(255) NOT NULL,
  destination_lat NUMERIC(10,7),
  destination_lng NUMERIC(10,7),
  emergency_type VARCHAR(100) NOT NULL,
  notes TEXT,
  fare_estimate NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  assigned_driver_name VARCHAR(255),
  assigned_vehicle_plate VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'requested', -- requested, dispatched, arrived, completed, cancelled
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- FOOD SYSTEM ORDERS & CARTS ---

CREATE TABLE IF NOT EXISTS carts (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id VARCHAR(80) REFERENCES restaurant_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_items (
  id VARCHAR(80) PRIMARY KEY,
  cart_id VARCHAR(80) NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  menu_item_id VARCHAR(80) NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS food_orders (
  id VARCHAR(80) PRIMARY KEY,
  customer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restaurant_id VARCHAR(80) NOT NULL REFERENCES restaurant_profiles(id) ON DELETE RESTRICT,
  delivery_address VARCHAR(512) NOT NULL,
  delivery_lat NUMERIC(10,7) NOT NULL,
  delivery_lng NUMERIC(10,7) NOT NULL,
  delivery_instructions TEXT,
  items_total NUMERIC(10,2) NOT NULL,
  delivery_fee NUMERIC(10,2) NOT NULL,
  commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  grand_total NUMERIC(10,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'cash', -- cash, wallet
  status VARCHAR(50) NOT NULL DEFAULT 'ordered', -- ordered, accepted, preparing, ready, out_for_delivery, delivered, cancelled
  rider_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS food_order_items (
  id VARCHAR(80) PRIMARY KEY,
  order_id VARCHAR(80) NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  menu_item_id VARCHAR(80) NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE RESTRICT,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL
);

-- --- FINANCE / MANUAL PAYMENTS ---

CREATE TABLE IF NOT EXISTS manual_payment_accounts (
  id VARCHAR(80) PRIMARY KEY,
  bank_name VARCHAR(150) NOT NULL,
  account_title VARCHAR(150) NOT NULL,
  account_number VARCHAR(100) NOT NULL,
  instructions TEXT,
  min_topup VARCHAR(50) NOT NULL DEFAULT '200',
  max_topup VARCHAR(50) NOT NULL DEFAULT '50000',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manual_topup_requests (
  id VARCHAR(80) PRIMARY KEY,
  rider_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_account_id VARCHAR(80) REFERENCES manual_payment_accounts(id) ON DELETE SET NULL,
  amount NUMERIC(10,2) NOT NULL,
  method VARCHAR(100) NOT NULL, -- Bank Transfer, Easypaisa, JazzCash
  sender_name VARCHAR(150) NOT NULL,
  sender_phone VARCHAR(50) NOT NULL,
  transaction_id VARCHAR(100) UNIQUE NOT NULL,
  screenshot_url TEXT,
  note TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  rejection_reason TEXT,
  reviewed_by VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- FREE RIDE CAMPAIGNS ---

CREATE TABLE IF NOT EXISTS free_ride_campaigns (
  id VARCHAR(80) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  service_type VARCHAR(50) NOT NULL, -- bike, car, ambulance, food_delivery
  quota_total INTEGER NOT NULL,
  quota_used INTEGER NOT NULL DEFAULT 0,
  allowed_zones TEXT, -- comma separated ids or all
  start_at TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, paused, ended
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS free_ride_quota_reservations (
  id VARCHAR(80) PRIMARY KEY,
  campaign_id VARCHAR(80) NOT NULL REFERENCES free_ride_campaigns(id) ON DELETE CASCADE,
  customer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id VARCHAR(80) UNIQUE, -- nullable, links to final booking
  status VARCHAR(50) NOT NULL DEFAULT 'reserved', -- reserved, consumed, released
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS free_ride_usage_logs (
  id VARCHAR(80) PRIMARY KEY,
  campaign_id VARCHAR(80) NOT NULL REFERENCES free_ride_campaigns(id) ON DELETE CASCADE,
  customer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rider_locations (
  user_id VARCHAR(80) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  bearing NUMERIC(5,2),
  speed NUMERIC(5,2),
  is_online BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ride_location_updates (
  id VARCHAR(80) PRIMARY KEY,
  ride_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- SUPPORT & COMPLAINTS ---

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) REFERENCES users(id) ON DELETE CASCADE,
  source_type VARCHAR(5) NOT NULL, -- customer, rider, restaurant, admin-created => stored as code
  category VARCHAR(100) NOT NULL, -- ride issue, food issue, ambulance issue, payment/wallet, safety, account, documentation, refund
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  priority VARCHAR(50) NOT NULL DEFAULT 'medium', -- low, medium, high, urgent
  status VARCHAR(50) NOT NULL DEFAULT 'open', -- open, assigned, waiting_user, resolved, closed
  assigned_to VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id VARCHAR(80) PRIMARY KEY,
  ticket_id VARCHAR(80) NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS safety_reports (
  id VARCHAR(80) PRIMARY KEY,
  booking_id VARCHAR(80) REFERENCES ride_bookings(id) ON DELETE SET NULL,
  reported_by_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  is_emergency BOOLEAN NOT NULL DEFAULT false,
  investigation_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, investigating, resolved, archived
  admin_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- NOTIFICATIONS ---

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  data_payload TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- INDEXES FOR PERFORMANCE ---
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_ride_bookings_customer_id ON ride_bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_ride_bookings_rider_id ON ride_bookings(rider_id);
CREATE INDEX IF NOT EXISTS idx_ride_bookings_status ON ride_bookings(status);
CREATE INDEX IF NOT EXISTS idx_food_orders_customer_id ON food_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_restaurant_id ON food_orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_status ON food_orders(status);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_online ON rider_profiles(is_online);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_manual_topup_requests_status ON manual_topup_requests(status);
