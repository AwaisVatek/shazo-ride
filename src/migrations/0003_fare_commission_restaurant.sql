CREATE TABLE IF NOT EXISTS fare_settings (
  id TEXT PRIMARY KEY,
  service_type TEXT NOT NULL UNIQUE,
  service_label TEXT NOT NULL,
  base_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
  per_km_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  per_minute_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  minimum_fare NUMERIC(10,2) NOT NULL DEFAULT 0,
  cancellation_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  night_surcharge NUMERIC(10,2) NOT NULL DEFAULT 0,
  peak_time_multiplier NUMERIC(10,2) NOT NULL DEFAULT 1,
  free_waiting_minutes INTEGER NOT NULL DEFAULT 0,
  waiting_charge_per_minute NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commission_settings (
  id TEXT PRIMARY KEY,
  service_type TEXT NOT NULL UNIQUE,
  service_label TEXT NOT NULL,
  commission_type TEXT NOT NULL DEFAULT 'percentage',
  commission_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  minimum_platform_cut NUMERIC(10,2) NOT NULL DEFAULT 0,
  driver_share_percentage NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_menu_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_price NUMERIC(10,2),
  image_url TEXT,
  is_available BOOLEAN NOT NULL DEFAULT true,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  prep_time_minutes INTEGER NOT NULL DEFAULT 15,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
