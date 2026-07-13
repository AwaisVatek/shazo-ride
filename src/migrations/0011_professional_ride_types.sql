-- Migration: Add Professional Ride Types

-- 1. Deactivate the generic "car" type so it doesn't show up in the booking UI
UPDATE service_settings SET is_active = false WHERE service_type = 'car';

-- 2. Insert new professional car sub-types
INSERT INTO service_settings 
  (id, service_type, base_fare, per_km_rate, per_minute_rate, minimum_fare, commission_percentage, commission_fixed, is_active)
VALUES
  ('set_car_mini', 'car_mini', 150, 60, 0, 250, 0, 0, true),
  ('set_car_go', 'car_go', 200, 75, 0, 350, 0, 0, true),
  ('set_car_business', 'car_business', 350, 110, 0, 600, 0, 0, true),
  ('set_car_luxury', 'car_luxury', 800, 250, 0, 1500, 0, 0, true),
  ('set_rickshaw', 'rickshaw', 100, 45, 0, 150, 0, 0, true)
ON CONFLICT (service_type) 
DO UPDATE SET 
  is_active = true,
  base_fare = EXCLUDED.base_fare,
  per_km_rate = EXCLUDED.per_km_rate,
  minimum_fare = EXCLUDED.minimum_fare;
