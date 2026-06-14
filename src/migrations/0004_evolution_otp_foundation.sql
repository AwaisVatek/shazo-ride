-- Migration 0004: Evolution WhatsApp API & OTP Foundation

-- 1. Create OTP Verifications Table
CREATE TABLE IF NOT EXISTS otp_verifications (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    role TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    otp_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast OTP lookup
CREATE INDEX IF NOT EXISTS idx_otp_verifications_phone ON otp_verifications(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_created_at ON otp_verifications(created_at);

-- 2. Create WhatsApp Event Logs Table for Webhooks
CREATE TABLE IF NOT EXISTS whatsapp_event_logs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'evolution',
    instance_name TEXT,
    event_type TEXT,
    remote_jid TEXT,
    message_id TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Add profile completion flag to users if not exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN NOT NULL DEFAULT false;

-- 4. Ensure customer_profiles has necessary emergency contact columns
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS default_city TEXT;
