-- Migration: 0009_alter_file_url_to_text
-- Description: Convert URL columns to TEXT to support base64 strings

ALTER TABLE IF EXISTS rider_documents ALTER COLUMN file_url TYPE TEXT;
ALTER TABLE IF EXISTS rider_vehicles ALTER COLUMN registration_document_url TYPE TEXT;
ALTER TABLE IF EXISTS rider_vehicles ALTER COLUMN vehicle_images TYPE TEXT;
