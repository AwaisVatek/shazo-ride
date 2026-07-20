-- Customer/backend contract hardening and Supabase Data API lockdown.
-- Mobile clients use the Express API, not PostgREST, so public tables are backend-only.

ALTER TABLE public.service_settings
  ADD COLUMN IF NOT EXISTS maximum_fare_multiplier numeric NOT NULL DEFAULT 1.50;

ALTER TABLE public.ride_bookings
  ADD COLUMN IF NOT EXISTS maximum_fare numeric;

UPDATE public.ride_bookings
SET maximum_fare = GREATEST(
  COALESCE(maximum_fare, 0),
  COALESCE(minimum_fare, 0),
  COALESCE(system_estimated_fare, fare, total_fare, 0)
)
WHERE maximum_fare IS NULL;

CREATE TABLE IF NOT EXISTS public.customer_saved_places (
  id text PRIMARY KEY DEFAULT ('place_' || replace(gen_random_uuid()::text, '-', '')),
  customer_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  address text NOT NULL,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  place_type text NOT NULL DEFAULT 'other',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, label)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_bookings_customer_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM public.ride_bookings rb LEFT JOIN public.users u ON u.id = rb.customer_id WHERE rb.customer_id IS NOT NULL AND u.id IS NULL) THEN
    ALTER TABLE public.ride_bookings ADD CONSTRAINT ride_bookings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_bookings_rider_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM public.ride_bookings rb LEFT JOIN public.users u ON u.id = rb.rider_id WHERE rb.rider_id IS NOT NULL AND u.id IS NULL) THEN
    ALTER TABLE public.ride_bookings ADD CONSTRAINT ride_bookings_rider_id_fkey FOREIGN KEY (rider_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_bookings_status_check') THEN
    ALTER TABLE public.ride_bookings ADD CONSTRAINT ride_bookings_status_check
      CHECK (status IN ('requested','accepted','arrived','in_transit','completed','cancelled')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_offers_status_check') THEN
    ALTER TABLE public.ride_offers ADD CONSTRAINT ride_offers_status_check
      CHECK (status IN ('pending','accepted','rejected','withdrawn','expired')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ambulance_bookings_status_check') THEN
    ALTER TABLE public.ambulance_bookings ADD CONSTRAINT ambulance_bookings_status_check
      CHECK (status IN ('requested','dispatched','arrived','completed','cancelled')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_topups_status_check') THEN
    ALTER TABLE public.customer_manual_topup_requests ADD CONSTRAINT customer_topups_status_check
      CHECK (status IN ('pending','approved','rejected','cancelled')) NOT VALID;
  END IF;
END $$;

-- These tables are accessed only through the authenticated Express backend.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','customer_profiles','customer_saved_places','ride_bookings','ride_offers',
    'ride_messages','ride_status_logs','rider_profiles','rider_vehicles',
    'ambulance_bookings','customer_wallets','customer_wallet_ledger',
    'customer_manual_topup_requests','food_orders','restaurant_profiles',
    'manual_payment_accounts','notifications','safety_reports','service_settings','support_tickets'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated', table_name);
    END IF;
  END LOOP;
END $$;

