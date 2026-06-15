-- Migration: Smart Fare Engine + Ride Chat Foundation

-- 1. Update Service Settings for Peak & Smart Fares
ALTER TABLE service_settings 
ADD COLUMN IF NOT EXISTS peak_factor_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
ADD COLUMN IF NOT EXISTS recommended_fare_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.20;

-- 2. Ride Messages (Chat System)
CREATE TABLE IF NOT EXISTS ride_messages (
  id VARCHAR(80) PRIMARY KEY,
  ride_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  sender_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role VARCHAR(50) NOT NULL, -- rider, customer
  content TEXT NOT NULL,
  message_type VARCHAR(50) NOT NULL DEFAULT 'text', -- text, image, voice
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ride_messages_ride_id ON ride_messages(ride_id);

-- 3. Food Delivery Enhancements (Variations/Addons)
CREATE TABLE IF NOT EXISTS restaurant_item_variations (
  id VARCHAR(80) PRIMARY KEY,
  menu_item_id VARCHAR(80) NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL, -- e.g., Size
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_item_variation_options (
  id VARCHAR(80) PRIMARY KEY,
  variation_id VARCHAR(80) NOT NULL REFERENCES restaurant_item_variations(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL, -- e.g., Half, Full
  price_adjustment NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
