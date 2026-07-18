-- Customer wallet (mirrors the rider_wallets / manual_topup_requests pattern,
-- scoped to users.id directly since there's no separate customer_profiles table).
CREATE TABLE IF NOT EXISTS customer_wallets (
  id VARCHAR(80) PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_wallet_ledger (
  id VARCHAR(80) PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  transaction_type TEXT NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_manual_topup_requests (
  id TEXT PRIMARY KEY DEFAULT ('ctopup_' || replace(gen_random_uuid()::text, '-', '')),
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
  transaction_id TEXT,
  screenshot_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- rider_wallet_ledger is referenced by existing code (finance.routes.ts's topup
-- approval, rides.routes.ts's ride-completion earnings entries) but was never
-- actually created — confirmed missing against the live database. Adding it now
-- so those existing code paths stop throwing "relation does not exist".
CREATE TABLE IF NOT EXISTS rider_wallet_ledger (
  id VARCHAR(80) PRIMARY KEY,
  rider_id VARCHAR(80) NOT NULL REFERENCES rider_profiles(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  transaction_type TEXT NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
