-- VehicleDetailsScreen.tsx collects color and year, and POST /api/rider/
-- vehicle has always tried to write them — neither column existed, so every
-- vehicle-details save has failed with "column does not exist" since this
-- flow was built.
ALTER TABLE rider_vehicles ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE rider_vehicles ADD COLUMN IF NOT EXISTS year TEXT;
