-- Migration: 0009_alter_file_url_to_text
-- Description: Convert URL columns to TEXT to support base64 strings

-- Rename doc_type to document_type if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'rider_documents' AND column_name = 'doc_type'
  ) THEN
    ALTER TABLE rider_documents RENAME COLUMN doc_type TO document_type;
  END IF;
END $$;

-- Rename doc_url to file_url if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'rider_documents' AND column_name = 'doc_url'
  ) THEN
    ALTER TABLE rider_documents RENAME COLUMN doc_url TO file_url;
  END IF;
END $$;

ALTER TABLE IF EXISTS rider_documents ALTER COLUMN file_url TYPE TEXT;
ALTER TABLE IF EXISTS rider_vehicles ALTER COLUMN registration_document_url TYPE TEXT;
ALTER TABLE IF EXISTS rider_vehicles ALTER COLUMN vehicle_images TYPE TEXT;
