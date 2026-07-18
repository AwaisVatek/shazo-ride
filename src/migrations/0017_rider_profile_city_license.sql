-- The rider registration flow (BasicProfileScreen, DocumentsScreen) collects
-- a city and a driving license expiry date, but rider_profiles had no columns
-- for either — this data had nowhere to be persisted regardless of what the
-- frontend sent.
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS license_expiry DATE;
