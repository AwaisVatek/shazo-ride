-- rider_vehicles.rider_id was a foreign key to a `drivers` table — a
-- completely separate, abandoned legacy schema (2 old demo rows, disconnected
-- from the real users/rider_profiles system every other part of the app
-- uses). No real rider's id could ever satisfy that constraint, so
-- POST /api/rider/vehicle has failed with a foreign key violation for every
-- actual rider since this flow was built. The 2 existing legacy rows
-- (vhc_bike/vhc_car, pointing at drv_bike/drv_car) are left alone — NOT
-- VALID means this constraint doesn't require them to satisfy it
-- retroactively, only enforces it for new rows going forward.
ALTER TABLE rider_vehicles DROP CONSTRAINT IF EXISTS vehicles_driver_id_fkey;
ALTER TABLE rider_vehicles
  ADD CONSTRAINT rider_vehicles_rider_id_fkey
  FOREIGN KEY (rider_id) REFERENCES rider_profiles(id) ON DELETE CASCADE
  NOT VALID;
