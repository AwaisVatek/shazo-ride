-- Rider production security and integrity alignment.
-- Shazo mobile clients use Express rather than the Supabase Data API.

ALTER TABLE IF EXISTS public.rider_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rider_wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rider_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.manual_topup_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.rider_documents FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.rider_wallet_ledger FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.rider_wallets FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.manual_topup_requests FROM anon, authenticated;

ALTER TABLE IF EXISTS public.ride_bookings
  ADD COLUMN IF NOT EXISTS pickup_pin text,
  ADD COLUMN IF NOT EXISTS pickup_verified_at timestamptz;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_type_check') THEN
    ALTER TABLE public.rider_vehicles DROP CONSTRAINT vehicles_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rider_vehicles_type_check') THEN
    ALTER TABLE public.rider_vehicles ADD CONSTRAINT rider_vehicles_type_check
      CHECK (type IN ('bike','car','rickshaw','ambulance')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_bookings_pickup_pin_check') THEN
    ALTER TABLE public.ride_bookings ADD CONSTRAINT ride_bookings_pickup_pin_check
      CHECK (pickup_pin IS NULL OR pickup_pin ~ '^[0-9]{4}$') NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_topup_requests_rider_id_fkey')
     AND NOT EXISTS (
       SELECT 1 FROM public.manual_topup_requests m
       LEFT JOIN public.rider_profiles rp ON rp.id = m.rider_id
       WHERE m.rider_id IS NOT NULL AND rp.id IS NULL
     ) THEN
    ALTER TABLE public.manual_topup_requests ADD CONSTRAINT manual_topup_requests_rider_id_fkey
      FOREIGN KEY (rider_id) REFERENCES public.rider_profiles(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_topup_requests_transaction_id_key')
     AND NOT EXISTS (
       SELECT transaction_id FROM public.manual_topup_requests
       WHERE transaction_id IS NOT NULL GROUP BY transaction_id HAVING count(*) > 1
     ) THEN
    ALTER TABLE public.manual_topup_requests ADD CONSTRAINT manual_topup_requests_transaction_id_key UNIQUE (transaction_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rider_documents_rider_type_key')
     AND NOT EXISTS (
       SELECT rider_id, document_type FROM public.rider_documents
       GROUP BY rider_id, document_type HAVING count(*) > 1
     ) THEN
    ALTER TABLE public.rider_documents ADD CONSTRAINT rider_documents_rider_type_key UNIQUE (rider_id, document_type);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rider_vehicles_rider_id_key')
     AND NOT EXISTS (
       SELECT rider_id FROM public.rider_vehicles GROUP BY rider_id HAVING count(*) > 1
     ) THEN
    ALTER TABLE public.rider_vehicles ADD CONSTRAINT rider_vehicles_rider_id_key UNIQUE (rider_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ride_bookings_dispatch
  ON public.ride_bookings (status, rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rider_wallet_ledger_history
  ON public.rider_wallet_ledger (rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_topups_rider_status
  ON public.manual_topup_requests (rider_id, status, created_at DESC);

-- Preserve unusable legacy vehicle rows whose rider IDs no longer resolve to
-- either a rider profile or a profile's user ID. They cannot be shown to or
-- updated by any current Rider account, but remain recoverable for operations.
CREATE TABLE IF NOT EXISTS public.rider_vehicle_orphan_archive AS
  SELECT rv.*, now()::timestamptz AS archived_at,
         'unresolvable legacy rider_id'::text AS archive_reason
  FROM public.rider_vehicles rv
  WHERE false;
CREATE UNIQUE INDEX IF NOT EXISTS rider_vehicle_orphan_archive_id_key
  ON public.rider_vehicle_orphan_archive (id);
ALTER TABLE public.rider_vehicle_orphan_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.rider_vehicle_orphan_archive FROM anon, authenticated;

UPDATE public.rider_vehicles rv
SET rider_id = legacy.id
FROM public.rider_profiles legacy
WHERE legacy.user_id = rv.rider_id
  AND NOT EXISTS (SELECT 1 FROM public.rider_profiles current_profile WHERE current_profile.id = rv.rider_id)
  AND NOT EXISTS (SELECT 1 FROM public.rider_vehicles other WHERE other.rider_id = legacy.id AND other.id <> rv.id);

INSERT INTO public.rider_vehicle_orphan_archive
SELECT rv.*, now(), 'unresolvable legacy rider_id'
FROM public.rider_vehicles rv
LEFT JOIN public.rider_profiles rp ON rp.id = rv.rider_id
LEFT JOIN public.rider_profiles legacy ON legacy.user_id = rv.rider_id
WHERE rp.id IS NULL AND legacy.id IS NULL
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.rider_vehicles rv
WHERE NOT EXISTS (SELECT 1 FROM public.rider_profiles rp WHERE rp.id = rv.rider_id)
  AND NOT EXISTS (SELECT 1 FROM public.rider_profiles legacy WHERE legacy.user_id = rv.rider_id);

-- Repair the historical auth flag: earlier OTP verification issued sessions
-- without marking an existing password-signup user verified.
UPDATE public.users u
SET is_verified = true, updated_at = now()
WHERE u.is_verified IS DISTINCT FROM true
  AND (
    EXISTS (
      SELECT 1 FROM public.otp_verifications ov
      WHERE ov.normalized_phone = u.phone AND ov.role = u.role AND ov.verified_at IS NOT NULL
    )
    OR (u.role = 'rider' AND EXISTS (
      SELECT 1 FROM public.rider_profiles rp
      WHERE rp.user_id = u.id AND rp.verification_status = 'verified'
    ))
  );

-- Existing rows were audited before this migration. Validate the initially
-- non-blocking constraints now so Postgres guarantees the full historical set.
ALTER TABLE public.ride_bookings VALIDATE CONSTRAINT ride_bookings_status_check;
ALTER TABLE public.ride_bookings VALIDATE CONSTRAINT ride_bookings_pickup_pin_check;
ALTER TABLE public.ride_offers VALIDATE CONSTRAINT ride_offers_status_check;
ALTER TABLE public.ambulance_bookings VALIDATE CONSTRAINT ambulance_bookings_status_check;
ALTER TABLE public.customer_manual_topup_requests VALIDATE CONSTRAINT customer_topups_status_check;
ALTER TABLE public.rider_vehicles VALIDATE CONSTRAINT rider_vehicles_rider_id_fkey;
ALTER TABLE public.rider_vehicles VALIDATE CONSTRAINT rider_vehicles_type_check;
ALTER TABLE public.manual_topup_requests VALIDATE CONSTRAINT manual_topup_requests_rider_id_fkey;
