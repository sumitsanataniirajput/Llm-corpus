-- 007 — Real training progress + safe job-history deletion
--
-- Every value here is written by the worker from the training engine itself
-- (completed optimizer steps, epoch, tokens, loss). Nothing is estimated in the
-- database: a column that the engine cannot measure stays NULL so the UI can say
-- "not available" instead of showing a fabricated number.
--
-- deleted_at is a soft delete for job *history*: the row, its metrics, events
-- and checkpoints stay in place (models, datasets and checkpoints are separate
-- resources and are never touched by deleting a job record).
--
-- Forward-only and non-destructive: adding nullable columns with defaults.

alter table training_jobs
  add column if not exists stage text default 'queued',
  add column if not exists progress_percent double precision default 0,
  add column if not exists total_steps bigint,
  add column if not exists completed_steps bigint default 0,
  add column if not exists total_epochs integer,
  add column if not exists current_epoch integer default 0,
  add column if not exists processed_tokens bigint default 0,
  add column if not exists last_loss double precision,
  add column if not exists progress_updated_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists failure_reason text;

-- Listing "my jobs, not deleted, newest first" is the hot path.
create index if not exists ix_training_jobs_owner_created_live
  on training_jobs (owner_id, created_at desc)
  where deleted_at is null;

-- Progress consumers read a single row by id; no extra index needed.
comment on column training_jobs.stage is
  'queued|preparing|tokenizing|loading_model|initializing|training|saving_checkpoints|validating|finalizing|completed';
comment on column training_jobs.progress_percent is
  'completed_steps / total_steps * 100, written by the worker; NULL-free once training starts';
comment on column training_jobs.deleted_at is
  'Soft delete of the job history record; models, datasets and checkpoints are untouched';
