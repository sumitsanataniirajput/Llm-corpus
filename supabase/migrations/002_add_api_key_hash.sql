-- ========================================
-- CORPUS ULTIMATE — Migration 002
-- Add key_hash column to api_keys_metadata
-- ========================================
-- FORWARD-ONLY MIGRATION — Requires explicit owner approval before execution.
-- Do NOT run automatically during deployment.
--
-- Purpose: Add a key_hash column to the existing api_keys_metadata table so
-- that API keys can be securely stored as hashes and verified on subsequent
-- requests. Without this column, full API keys are returned once to the user
-- but are not persisted for verification.
--
-- This migration is safe to run on existing data — it only adds a nullable
-- column. Existing rows will have NULL key_hash until keys are recreated.
-- ========================================

-- Add key_hash column (nullable — existing rows get NULL)
ALTER TABLE api_keys_metadata ADD COLUMN IF NOT EXISTS key_hash text;

-- Add index for key_hash lookups
CREATE INDEX IF NOT EXISTS ix_api_keys_metadata_key_hash ON api_keys_metadata(key_hash);

-- Comment for documentation
COMMENT ON COLUMN api_keys_metadata.key_hash IS 'SHA-256 hash of the full API key (for verification)';
