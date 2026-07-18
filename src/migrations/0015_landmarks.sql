-- Local landmarks table, supplementing Mapbox's geocoding for Karachi.
-- Mapbox's own POI/landmark index was verified to have almost no coverage
-- for Karachi (malls, hospitals, even large neighborhoods return nothing or
-- wrong-country results) — this table is searched first, before falling
-- back to Mapbox, for exactly the "landmark someone would search for as a
-- pickup/dropoff" case. `source` distinguishes an initial OpenStreetMap
-- import from any manually-supplied entries added later.
CREATE TABLE IF NOT EXISTS landmarks (
  id VARCHAR(120) PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  address TEXT,
  lat NUMERIC(10,7) NOT NULL,
  lng NUMERIC(10,7) NOT NULL,
  source TEXT NOT NULL DEFAULT 'osm',
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_landmarks_name_lower ON landmarks (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_landmarks_lat_lng ON landmarks (lat, lng);
