-- ========================================
-- CORPUS ULTIMATE — Supabase Schema (Migration 001)
-- ========================================
-- Run this in the Supabase SQL Editor.
-- Creates all required tables with RLS.

-- Enable extensions
create extension if not exists "pgcrypto";

-- -----------------------------------------------------
-- profiles
-- -----------------------------------------------------
create table profiles (
  id uuid references auth.users not null primary key,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

-- -----------------------------------------------------
-- user_devices
-- -----------------------------------------------------
create table user_devices (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null,
  device_name text,
  os text,
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

alter table user_devices enable row level security;

create policy "Users can manage own devices"
  on user_devices for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- models
-- -----------------------------------------------------
-- owner_id is uuid, not text: auth.users.id is uuid, so a text column cannot
-- even carry the foreign key (PostgreSQL rejects it: "foreign key constraint
-- cannot be implemented"), and a text column breaks UUID comparisons in the
-- API. Existing databases are normalized by 004_normalize_models_owner_id.sql.
create table models (
  id text primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  config jsonb not null,
  version text default '1.0',
  status text default 'idle',
  tokenizer_ref text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table models enable row level security;

create policy "Users can manage own models"
  on models for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- model_versions
-- -----------------------------------------------------
create table model_versions (
  id uuid default gen_random_uuid() primary key,
  model_id text references models(id) on delete cascade,
  version text not null,
  config jsonb,
  storage_ref text,
  created_at timestamptz default now()
);

alter table model_versions enable row level security;

create policy "Users can manage own model versions"
  on model_versions for all
  using (auth.uid() in (select owner_id from models where id = model_id));

-- -----------------------------------------------------
-- model_architectures
-- -----------------------------------------------------
create table model_architectures (
  id uuid default gen_random_uuid() primary key,
  model_id text references models(id) on delete cascade,
  architecture jsonb not null,
  parameter_count bigint,
  created_at timestamptz default now()
);

alter table model_architectures enable row level security;

create policy "Users can manage own model architectures"
  on model_architectures for all
  using (auth.uid() in (select owner_id from models where id = model_id));

-- -----------------------------------------------------
-- datasets
-- -----------------------------------------------------
create table datasets (
  id text primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  format text,
  size bigint default 0,
  status text default 'ready',
  token_count bigint default 0,
  checksum text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table datasets enable row level security;

create policy "Users can manage own datasets"
  on datasets for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- dataset_files
-- -----------------------------------------------------
create table dataset_files (
  id uuid default gen_random_uuid() primary key,
  dataset_id text references datasets(id) on delete cascade,
  storage_path text not null,
  file_name text,
  file_size bigint,
  checksum text,
  uploaded_at timestamptz default now()
);

alter table dataset_files enable row level security;

create policy "Users can manage own dataset files"
  on dataset_files for all
  using (auth.uid() in (select owner_id from datasets where id = dataset_id));

-- -----------------------------------------------------
-- dataset_versions
-- -----------------------------------------------------
create table dataset_versions (
  id uuid default gen_random_uuid() primary key,
  dataset_id text references datasets(id) on delete cascade,
  version text not null,
  preprocessing_log jsonb,
  created_at timestamptz default now()
);

alter table dataset_versions enable row level security;

create policy "Users can manage own dataset versions"
  on dataset_versions for all
  using (auth.uid() in (select owner_id from datasets where id = dataset_id));

-- -----------------------------------------------------
-- training_jobs
-- -----------------------------------------------------
create table training_jobs (
  id text primary key,
  owner_id uuid references auth.users not null,
  model_id text references models(id),
  dataset_id text references datasets(id),
  status text default 'queued',
  engine text default 'pytorch',
  compute text default 'local',
  config jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

alter table training_jobs enable row level security;

create policy "Users can manage own training jobs"
  on training_jobs for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- training_job_events
-- -----------------------------------------------------
create table training_job_events (
  id uuid default gen_random_uuid() primary key,
  job_id text references training_jobs(id) on delete cascade,
  event text not null,
  data jsonb,
  created_at timestamptz default now()
);

alter table training_job_events enable row level security;

create policy "Users can manage own training job events"
  on training_job_events for all
  using (auth.uid() in (select owner_id from training_jobs where id = job_id));

-- -----------------------------------------------------
-- training_metrics
-- -----------------------------------------------------
create table training_metrics (
  id uuid default gen_random_uuid() primary key,
  job_id text references training_jobs(id) on delete cascade,
  step bigint,
  loss double precision,
  learning_rate double precision,
  tokens_per_second double precision,
  created_at timestamptz default now()
);

alter table training_metrics enable row level security;

create policy "Users can manage own training metrics"
  on training_metrics for all
  using (auth.uid() in (select owner_id from training_jobs where id = job_id));

-- -----------------------------------------------------
-- checkpoints
-- -----------------------------------------------------
create table checkpoints (
  id text primary key,
  model_id text references models(id) on delete cascade,
  job_id text references training_jobs(id),
  storage_path text not null,
  step bigint,
  loss double precision,
  created_at timestamptz default now()
);

alter table checkpoints enable row level security;

create policy "Users can manage own checkpoints"
  on checkpoints for all
  using (auth.uid() in (select owner_id from models where id = model_id));

-- -----------------------------------------------------
-- storage_objects
-- -----------------------------------------------------
create table storage_objects (
  id text primary key,
  owner_id uuid references auth.users not null,
  bucket text not null,
  path text not null,
  file_name text,
  file_size bigint,
  mime_type text,
  checksum text,
  created_at timestamptz default now()
);

alter table storage_objects enable row level security;

create policy "Users can manage own storage objects"
  on storage_objects for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- experiments
-- -----------------------------------------------------
create table experiments (
  id text primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  description text,
  status text default 'active',
  config jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table experiments enable row level security;

create policy "Users can manage own experiments"
  on experiments for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- evaluation_runs
-- -----------------------------------------------------
create table evaluation_runs (
  id text primary key,
  owner_id uuid references auth.users not null,
  model_id text references models(id),
  test_type text,
  score double precision,
  status text default 'completed',
  created_at timestamptz default now()
);

alter table evaluation_runs enable row level security;

create policy "Users can manage own evaluation runs"
  on evaluation_runs for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- evaluation_results
-- -----------------------------------------------------
create table evaluation_results (
  id uuid default gen_random_uuid() primary key,
  run_id text references evaluation_runs(id) on delete cascade,
  metric_name text,
  metric_value double precision,
  details jsonb,
  created_at timestamptz default now()
);

alter table evaluation_results enable row level security;

create policy "Users can manage own evaluation results"
  on evaluation_results for all
  using (auth.uid() in (select owner_id from evaluation_runs where id = run_id));

-- -----------------------------------------------------
-- conversations
-- -----------------------------------------------------
create table conversations (
  id text primary key,
  owner_id uuid references auth.users not null,
  title text,
  model_id text references models(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table conversations enable row level security;

create policy "Users can manage own conversations"
  on conversations for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- messages
-- -----------------------------------------------------
create table messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id text references conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

alter table messages enable row level security;

create policy "Users can manage own messages"
  on messages for all
  using (auth.uid() in (select owner_id from conversations where id = conversation_id));

-- -----------------------------------------------------
-- api_keys_metadata
-- -----------------------------------------------------
create table api_keys_metadata (
  id text primary key,
  owner_id uuid references auth.users not null,
  name text,
  prefix text,
  created_at timestamptz default now(),
  last_used timestamptz,
  revoked boolean default false
);

alter table api_keys_metadata enable row level security;

create policy "Users can manage own api keys"
  on api_keys_metadata for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- compute_workers
-- -----------------------------------------------------
create table compute_workers (
  id text primary key,
  owner_id uuid references auth.users not null,
  name text not null,
  os text,
  cpu text,
  ram bigint,
  gpu text,
  vram bigint,
  backend text,
  status text default 'offline',
  last_heartbeat timestamptz,
  created_at timestamptz default now()
);

alter table compute_workers enable row level security;

create policy "Users can manage own compute workers"
  on compute_workers for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- worker_heartbeats
-- -----------------------------------------------------
create table worker_heartbeats (
  id uuid default gen_random_uuid() primary key,
  worker_id text references compute_workers(id) on delete cascade,
  cpu_usage double precision,
  ram_usage double precision,
  gpu_usage double precision,
  created_at timestamptz default now()
);

alter table worker_heartbeats enable row level security;

create policy "Users can manage own worker heartbeats"
  on worker_heartbeats for all
  using (auth.uid() in (select owner_id from compute_workers where id = worker_id));

-- -----------------------------------------------------
-- notifications
-- -----------------------------------------------------
create table notifications (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null,
  title text,
  message text,
  read boolean default false,
  created_at timestamptz default now()
);

alter table notifications enable row level security;

create policy "Users can manage own notifications"
  on notifications for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- activity_logs
-- -----------------------------------------------------
create table activity_logs (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb,
  created_at timestamptz default now()
);

alter table activity_logs enable row level security;

create policy "Users can manage own activity logs"
  on activity_logs for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- user_preferences
-- -----------------------------------------------------
create table user_preferences (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users not null unique,
  theme text default 'dark',
  settings jsonb default '{}',
  updated_at timestamptz default now()
);

alter table user_preferences enable row level security;

create policy "Users can manage own preferences"
  on user_preferences for all
  using (auth.uid() = owner_id);

-- -----------------------------------------------------
-- Indexes
-- -----------------------------------------------------
create index idx_models_owner on models(owner_id);
create index idx_datasets_owner on datasets(owner_id);
create index idx_training_jobs_owner on training_jobs(owner_id);
create index idx_training_jobs_model on training_jobs(model_id);
create index idx_training_metrics_job on training_metrics(job_id);
create index idx_checkpoints_model on checkpoints(model_id);
create index idx_conversations_owner on conversations(owner_id);
create index idx_messages_conversation on messages(conversation_id);
create index idx_compute_workers_owner on compute_workers(owner_id);
create index idx_storage_objects_owner on storage_objects(owner_id);
create index idx_api_keys_owner on api_keys_metadata(owner_id);

-- -----------------------------------------------------
-- Updated-at triggers (helper)
-- -----------------------------------------------------
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  for t in ('profiles','models','datasets','training_jobs','experiments','conversations','compute_workers','user_preferences') loop
    execute format('create trigger update_%s_updated_at before update on %s for each row execute function update_updated_at_column()', t, t);
  end loop;
end $$;