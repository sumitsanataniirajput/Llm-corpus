-- CORPUS ULTIMATE: safe performance hardening for Travell.
-- Adds only non-unique FK indexes and rewrites auth.uid() policy calls as initPlans.
-- No rows are inserted, updated, or deleted.

CREATE INDEX IF NOT EXISTS idx_activity_logs_owner_id ON public.activity_logs (owner_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_job_id ON public.checkpoints (job_id);
CREATE INDEX IF NOT EXISTS idx_conversations_model_id ON public.conversations (model_id);
CREATE INDEX IF NOT EXISTS idx_dataset_files_dataset_id ON public.dataset_files (dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_versions_dataset_id ON public.dataset_versions (dataset_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_run_id ON public.evaluation_results (run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_model_id ON public.evaluation_runs (model_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_owner_id ON public.evaluation_runs (owner_id);
CREATE INDEX IF NOT EXISTS idx_experiments_owner_id ON public.experiments (owner_id);
CREATE INDEX IF NOT EXISTS idx_model_architectures_model_id ON public.model_architectures (model_id);
CREATE INDEX IF NOT EXISTS idx_model_versions_model_id ON public.model_versions (model_id);
CREATE INDEX IF NOT EXISTS idx_notifications_owner_id ON public.notifications (owner_id);
CREATE INDEX IF NOT EXISTS idx_training_job_events_job_id ON public.training_job_events (job_id);
CREATE INDEX IF NOT EXISTS idx_training_jobs_dataset_id ON public.training_jobs (dataset_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_owner_id ON public.user_devices (owner_id);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_worker_id ON public.worker_heartbeats (worker_id);

DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') LIKE '%auth.uid()%'
        OR coalesce(with_check, '') LIKE '%auth.uid()%')
  LOOP
    IF p.qual IS NOT NULL THEN
      new_qual := replace(p.qual, 'auth.uid()', '(select auth.uid())');
      IF new_qual <> p.qual THEN
        EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)',
          p.policyname, p.schemaname, p.tablename, new_qual);
      END IF;
    END IF;
    IF p.with_check IS NOT NULL THEN
      new_check := replace(p.with_check, 'auth.uid()', '(select auth.uid())');
      IF new_check <> p.with_check THEN
        EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
          p.policyname, p.schemaname, p.tablename, new_check);
      END IF;
    END IF;
  END LOOP;
END $$;
