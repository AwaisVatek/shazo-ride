-- rider_profiles.vehicle_number had a database-level DEFAULT of the literal
-- string 'DEMO-VEH-000' — every new rider signup silently got a fake
-- placeholder vehicle number before ever submitting a real one. The column
-- is nullable, so there's no reason for a fabricated default; NULL
-- correctly represents "no vehicle submitted yet."
ALTER TABLE rider_profiles ALTER COLUMN vehicle_number DROP DEFAULT;
