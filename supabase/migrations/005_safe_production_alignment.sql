-- ============================================================
-- CORPUS ULTIMATE — Migration 005
-- Safe production alignment for the Travell Supabase project
-- ============================================================
-- Review before execution. This migration is forward-only and does not
-- delete rows, files, buckets, users, or existing migration records.
--
-- Changes:
--   1. Align the database default for datasets.status with the API's
--      existing "pending" state for newly created, empty datasets.
--   2. Pin the updated-at trigger function search_path to avoid object
--      shadowing and address the Supabase function_search_path_mutable
--      security advisor finding.
--
-- It deliberately does NOT replay 001/004, rewrite existing dataset rows,
-- add broad Storage RLS policies, or change bucket size/MIME restrictions.
-- CORPUS uploads use the backend's service-role client; the service key
-- bypasses Storage RLS and must remain backend-only.
-- ============================================================

ALTER TABLE public.datasets
  ALTER COLUMN status SET DEFAULT 'pending';

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.update_updated_at_column() IS
  'Sets updated_at on row updates; search_path is pinned to public, pg_temp.';
