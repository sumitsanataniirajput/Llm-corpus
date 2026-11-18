-- 011 — Student model configs, runtime telemetry and dataset analytics
--
-- The Training Intelligence dashboard must show numbers that came from the
-- loader/runtime, not from frontend constants. These tables persist:
--   * student_training_configs     — the inspected architecture + method + config
--   * training_runtime_snapshots   — hardware samples captured during a run
--   * training_dataset_analytics   — per-job dataset statistics and splits
--
-- Forward-only and non-destructive: new tables only.

create table if not exists student_training_configs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  model_id text references models(id) on delete set null,
  -- corpus | huggingface | local
  base_source text not null,
  base_ref text,
  -- name, architecture, parameter counts, layer/head/vocab/context, precision, sizes
  architecture jsonb not null default '{}'::jsonb,
  -- sft | lora | qlora | dpo | continued
  method text not null default 'sft',
  method_config jsonb not null default '{}'::jsonb,
  training_config jsonb not null default '{}'::jsonb,
  -- availability + reasons captured when the config was created
  capability jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_student_training_configs_owner
  on student_training_configs (owner_id);
create index if not exists ix_student_training_configs_model
  on student_training_configs (model_id);

alter table student_training_configs enable row level security;

drop policy if exists "Owners manage their student configs" on student_training_configs;
create policy "Owners manage their student configs"
  on student_training_configs for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists training_runtime_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references training_jobs(id) on delete cascade,
  captured_at timestamptz not null default now(),
  stage text,
  step bigint,
  device text,
  cpu_count integer,
  cpu_model text,
  cpu_utilization double precision,
  ram_used_mb bigint,
  ram_total_mb bigint,
  gpu_name text,
  gpu_memory_used_mb bigint,
  gpu_memory_total_mb bigint,
  gpu_utilization double precision,
  cpu_temperature_c double precision,
  battery_percent double precision,
  worker_count integer,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists ix_training_runtime_snapshots_job
  on training_runtime_snapshots (job_id, captured_at desc);
create index if not exists ix_training_runtime_snapshots_owner
  on training_runtime_snapshots (owner_id);

alter table training_runtime_snapshots enable row level security;

drop policy if exists "Owners read their runtime snapshots" on training_runtime_snapshots;
create policy "Owners read their runtime snapshots"
  on training_runtime_snapshots for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists training_dataset_analytics (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references training_jobs(id) on delete cascade,
  dataset_id text references datasets(id) on delete set null,
  records bigint,
  accepted_records bigint,
  rejected_records bigint,
  duplicate_records bigint,
  tokens bigint,
  train_tokens bigint,
  validation_tokens bigint,
  test_tokens bigint,
  avg_tokens_per_sample double precision,
  max_sample_length integer,
  min_sample_length integer,
  language_distribution jsonb not null default '{}'::jsonb,
  subject_distribution jsonb not null default '{}'::jsonb,
  source_distribution jsonb not null default '{}'::jsonb,
  cleaning_status text,
  tokenization_status text,
  checksum text,
  split jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_training_dataset_analytics_job
  on training_dataset_analytics (job_id);

alter table training_dataset_analytics enable row level security;

drop policy if exists "Owners read their dataset analytics" on training_dataset_analytics;
create policy "Owners read their dataset analytics"
  on training_dataset_analytics for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

comment on table student_training_configs is
  'Inspected architecture and training method for a student model; availability reasons are stored, not re-guessed';
comment on table training_runtime_snapshots is
  'Hardware samples captured by the worker during a run; NULL means the value could not be read';
comment on table training_dataset_analytics is
  'Per-job dataset statistics, including the real train/validation/test split the run used';
