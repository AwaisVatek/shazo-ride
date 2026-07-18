-- The customer app's ride category tabs (Bike/Rickshaw/Car/Ambulance) and
-- PRODUCT.md both treat rickshaw as a real, core vehicle type, but
-- service_settings never had a row for it — the frontend was papering over
-- this by hardcoding a fake rickshaw/car_mini/car_ac/car_luxury fallback
-- with made-up prices directly in RideBookingScreen.tsx. Also adding real
-- seats/display_name columns: the frontend hardcoded "4 seats" for every
-- vehicle (including bike) since no seat-count data existed anywhere.
ALTER TABLE service_settings ADD COLUMN IF NOT EXISTS seats INTEGER;
ALTER TABLE service_settings ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);

UPDATE service_settings SET seats = 1, display_name = 'Bike' WHERE service_type = 'bike' AND display_name IS NULL;
UPDATE service_settings SET seats = 4, display_name = 'Car' WHERE service_type = 'car' AND display_name IS NULL;
UPDATE service_settings SET display_name = 'Ambulance' WHERE service_type = 'ambulance' AND display_name IS NULL;
UPDATE service_settings SET display_name = 'Food Delivery' WHERE service_type = 'food_delivery' AND display_name IS NULL;
UPDATE service_settings SET display_name = 'Restaurant' WHERE service_type = 'restaurant' AND display_name IS NULL;

INSERT INTO service_settings (id, service_type, display_name, seats, base_fare, per_km_rate, per_minute_rate, minimum_fare)
SELECT 'svc_rickshaw', 'rickshaw', 'Rickshaw', 3, 100.00, 45.00, 4.00, 150.00
WHERE NOT EXISTS (SELECT 1 FROM service_settings WHERE service_type = 'rickshaw');
