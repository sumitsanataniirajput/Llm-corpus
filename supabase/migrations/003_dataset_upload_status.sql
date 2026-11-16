-- ============================================================
-- CORPUS ULTIMATE — Migration 003
-- Dataset upload status: a record with no stored file is "pending"
-- ============================================================
-- FORWARD-ONLY MIGRATION — Requires explicit owner approval before execution.
-- Do NOT run automatically during deployment.
--
-- Background: datasets used to be created with status 'ready' before any file
-- had been uploaded, so the Training page could not tell a usable dataset from
-- an empty record. Uploading a file already sets status = 'uploaded'.
--
-- This migration:
--   1. changes the column default for new records to 'pending'
--   2. re-labels only those existing 'ready' rows that have no dataset_files row
-- Datasets that already have a stored file are left untouched.
-- ============================================================

ALTER TABLE datasets ALTER COLUMN status SET DEFAULT 'pending';

UPDATE datasets d
SET status = 'pending', updated_at = now()
WHERE d.status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM dataset_files df WHERE df.dataset_id = d.id
  );

COMMENT ON COLUMN datasets.status IS
  'pending = record created, no file stored; uploaded = file stored in Supabase Storage and trainable; failed = last upload failed';
