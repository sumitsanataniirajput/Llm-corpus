-- 010 — AI teacher network, distillation and student training telemetry
--
-- Adds the entities the teacher/distillation pipeline needs:
--   * ai_provider_connections  — encrypted external provider credentials
--   * ai_teacher_models        — discovered or manually entered teacher models
--   * ai_provider_requests     — one row per outbound teacher request (usage/budgets)
--   * distillation_jobs        — a generation/validation run
--   * distillation_records     — generated examples with provenance + validation
--   * distillation_evaluations — evaluator verdicts for later review/analysis
--
-- Credentials: the raw key is never stored. `credential_ciphertext` holds an
-- AES-256-GCM envelope produced by the backend (see app/services/crypto.py) and
-- `credential_hint` holds only the last four characters for display.
--
-- Forward-only and non-destructive: new tables only, nothing is dropped,
-- rewritten or back-filled. Existing models/datasets/jobs/checkpoints/metrics are
-- reused and referenced, never duplicated.

create table if not exists ai_provider_connections (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- openai | gemini | anthropic | openrouter | groq | together | deepseek | fireworks | custom
  provider_type text not null,
  name text not null,
  base_url text,
  -- v1:<base64(nonce || ciphertext || tag)> — never the raw key
  credential_ciphertext text not null,
  credential_hint text,
  credential_fingerprint text,
  enabled boolean not null default true,
  -- unverified | connected | error | disabled
  status text not null default 'unverified',
  last_error text,
  last_tested_at timestamptz,
  default_teacher_model text,
  -- owner-maintained limits for this provider: max_requests_per_day,
  -- max_tokens_per_day, max_spend_usd_per_day, max_concurrent_requests
  budget jsonb not null default '{}'::jsonb,
  -- capability labels advertised at connection time (teacher inference, model
  -- discovery, provider-managed fine-tuning when the provider actually offers it)
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_ai_provider_connections_owner
  on ai_provider_connections (owner_id);
create unique index if not exists ux_ai_provider_connections_owner_fingerprint
  on ai_provider_connections (owner_id, credential_fingerprint);

alter table ai_provider_connections enable row level security;

drop policy if exists "Owners manage their provider connections" on ai_provider_connections;
create policy "Owners manage their provider connections"
  on ai_provider_connections for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists ai_teacher_models (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null references ai_provider_connections(id) on delete cascade,
  model_id text not null,
  display_name text,
  -- NULL means "the provider did not report it": never guessed.
  context_window bigint,
  max_output_tokens bigint,
  capabilities jsonb not null default '{}'::jsonb,
  -- Pricing is only ever what the owner entered or a provider returned. NULL = unknown.
  input_price_per_million numeric,
  output_price_per_million numeric,
  price_source text,
  price_updated_at timestamptz,
  discovered boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_ai_teacher_models_provider_model
  on ai_teacher_models (provider_id, model_id);
create index if not exists ix_ai_teacher_models_owner on ai_teacher_models (owner_id);

alter table ai_teacher_models enable row level security;

drop policy if exists "Owners manage their teacher models" on ai_teacher_models;
create policy "Owners manage their teacher models"
  on ai_teacher_models for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists ai_provider_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null references ai_provider_connections(id) on delete cascade,
  job_id text,
  model_id text,
  -- success | error | rate_limited | budget_blocked
  status text not null,
  http_status integer,
  input_tokens bigint,
  output_tokens bigint,
  cached_tokens bigint,
  estimated_cost numeric,
  latency_ms bigint,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists ix_ai_provider_requests_owner_created
  on ai_provider_requests (owner_id, created_at desc);
create index if not exists ix_ai_provider_requests_provider
  on ai_provider_requests (provider_id, created_at desc);
create index if not exists ix_ai_provider_requests_job
  on ai_provider_requests (job_id);

alter table ai_provider_requests enable row level security;

drop policy if exists "Owners read their provider requests" on ai_provider_requests;
create policy "Owners read their provider requests"
  on ai_provider_requests for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists distillation_jobs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  dataset_id text references datasets(id) on delete set null,
  source_dataset_name text,
  -- draft | queued | generating | validating | review | completed | failed | cancelled
  status text not null default 'draft',
  -- single | multi | evaluator | competition | specialized
  mode text not null,
  teacher_config jsonb not null default '{}'::jsonb,
  generation_config jsonb not null default '{}'::jsonb,
  quality_config jsonb not null default '{}'::jsonb,
  budget jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  student_dataset_id text references datasets(id) on delete set null,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_distillation_jobs_owner_created
  on distillation_jobs (owner_id, created_at desc);
create index if not exists ix_distillation_jobs_status on distillation_jobs (status);

alter table distillation_jobs enable row level security;

drop policy if exists "Owners manage their distillation jobs" on distillation_jobs;
create policy "Owners manage their distillation jobs"
  on distillation_jobs for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists distillation_records (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references distillation_jobs(id) on delete cascade,
  instruction text,
  input text,
  target text,
  chosen text,
  rejected text,
  task_type text,
  difficulty text,
  language text,
  subject text,
  output_format text,
  -- provider_id / provider_type / model_id / request_id / usage / generation params
  provenance jsonb not null default '{}'::jsonb,
  -- score, per-check results, status and human-readable reasons
  validation jsonb not null default '{}'::jsonb,
  quality_score double precision,
  content_hash text,
  -- 64-bit simhash of the normalised text, used for near-duplicate detection
  simhash bigint,
  -- pending | accepted | rejected | duplicate
  status text not null default 'pending',
  reviewed_by_human boolean not null default false,
  review_note text,
  created_at timestamptz not null default now()
);

create index if not exists ix_distillation_records_job on distillation_records (job_id, status);
create index if not exists ix_distillation_records_owner on distillation_records (owner_id);
create index if not exists ix_distillation_records_hash on distillation_records (job_id, content_hash);
create index if not exists ix_distillation_records_task on distillation_records (job_id, task_type);

alter table distillation_records enable row level security;

drop policy if exists "Owners manage their distillation records" on distillation_records;
create policy "Owners manage their distillation records"
  on distillation_records for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists distillation_evaluations (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references distillation_jobs(id) on delete cascade,
  record_id text not null references distillation_records(id) on delete cascade,
  evaluator_provider_id text references ai_provider_connections(id) on delete set null,
  evaluator_model_id text,
  -- accuracy / relevance / completeness / instruction_following / overall
  scores jsonb not null default '{}'::jsonb,
  verdict text,
  rationale text,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_distillation_evaluations_record
  on distillation_evaluations (record_id);
create index if not exists ix_distillation_evaluations_job
  on distillation_evaluations (job_id);

alter table distillation_evaluations enable row level security;

drop policy if exists "Owners manage their distillation evaluations" on distillation_evaluations;
create policy "Owners manage their distillation evaluations"
  on distillation_evaluations for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

comment on table ai_provider_connections is
  'External AI teacher connections; the API key is stored only as an AES-256-GCM envelope';
comment on column ai_provider_connections.capabilities is
  'Capability labels that were actually observed (discovery, fine-tuning endpoints), never assumed';
comment on table ai_provider_requests is
  'One row per outbound teacher request: usage, cost estimate and latency for budgets';
comment on table distillation_records is
  'Generated training examples with provenance and validation; nothing here is auto-accepted as correct';
