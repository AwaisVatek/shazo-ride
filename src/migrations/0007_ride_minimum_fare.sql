-- Migration: Add minimum fare to ride bookings

ALTER TABLE IF EXISTS ride_bookings 
ADD COLUMN IF NOT EXISTS minimum_fare NUMERIC(10,2) DEFAULT 0;

ALTER TABLE IF EXISTS ride_offers
ADD COLUMN IF NOT EXISTS is_counter_offer BOOLEAN DEFAULT false;
