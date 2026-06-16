-- Migration: 0008_rider_vehicles_upgrade

-- 1. Rename existing vehicles table to rider_vehicles
ALTER TABLE IF EXISTS vehicles RENAME TO rider_vehicles;

-- 2. Add missing columns to rider_vehicles
ALTER TABLE rider_vehicles 
  ADD COLUMN IF NOT EXISTS vehicle_category VARCHAR(50),
  ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ownership_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS registration_document_url VARCHAR(512),
  ADD COLUMN IF NOT EXISTS vehicle_images TEXT, -- Can store JSON array of URLs
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 3. Backfill vehicle_category from rider_profiles where possible
UPDATE rider_vehicles rv
SET vehicle_category = rp.vehicle_type
FROM rider_profiles rp
WHERE rv.rider_id = rp.user_id AND rv.vehicle_category IS NULL;

-- 4. Add ride_bookings negotiation fields
ALTER TABLE ride_bookings
  ADD COLUMN IF NOT EXISTS vehicle_category VARCHAR(50),
  ADD COLUMN IF NOT EXISTS system_estimated_fare NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS customer_offer_fare NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS rider_counter_fare NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS accepted_fare NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS negotiation_status VARCHAR(50) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS customer_rating NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS rider_rating NUMERIC(3,2);
