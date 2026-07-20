-- This legacy Demo Repo table is not used by the Shazo Express API. Keep it
-- backend-only like the production ambulance_bookings table so it cannot be
-- reached through Supabase's public Data API.
DO $$
BEGIN
  IF to_regclass('public.ambulance_requests') IS NOT NULL THEN
    ALTER TABLE public.ambulance_requests ENABLE ROW LEVEL SECURITY;
    REVOKE ALL PRIVILEGES ON TABLE public.ambulance_requests FROM anon, authenticated;
  END IF;
END $$;
