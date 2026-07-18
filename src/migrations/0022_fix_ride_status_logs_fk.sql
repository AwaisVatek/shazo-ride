-- ride_status_logs.ride_id had a foreign key pointing at `rides(id)` — a
-- completely separate, abandoned legacy table (0 rows, disconnected from
-- the real booking system: passenger_id/driver_id/pickup/dropoff instead of
-- ride_bookings' customer_id/rider_id/pickup_address/dropoff_address). The
-- table actually used for every real ride is ride_bookings. Because of the
-- wrong FK, every attempt to log a ride's initial status has failed since
-- this feature was built (confirmed: ride_status_logs has 0 rows in
-- production). Repointing at the real table; ride_status_logs itself is
-- empty so there's nothing to reconcile.
ALTER TABLE ride_status_logs DROP CONSTRAINT IF EXISTS ride_status_logs_ride_id_fkey;
ALTER TABLE ride_status_logs
  ADD CONSTRAINT ride_status_logs_ride_id_fkey
  FOREIGN KEY (ride_id) REFERENCES ride_bookings(id) ON DELETE CASCADE;
