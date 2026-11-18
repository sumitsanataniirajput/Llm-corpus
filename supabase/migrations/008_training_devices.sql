-- 008 — Training devices, task leases and collaborative preprocessing shards
--
-- Two devices training together need (a) an identity with a heartbeat and
-- (b) a lease-backed task so a device that disappears cannot hold work forever.
-- This migration adds exactly those two tables; jobs, models and datasets keep
-- their existing tables and are referenced, never duplicated.
--
-- Training itself still runs where it always ran. These tables describe which
-- device was given which piece of work and whether that work is still alive.
--
-- Forward-only and non-destructive: no table is altered, dropped or rewritten.

create table if not exists training_devices (
  id text primary key,
  owner_id uuid not null references auth.users,
  name text not null,
  device_type text,                          -- mobile | tablet | laptop | desktop
  platform text,                             -- user agent family + OS, as reported
  capabilities jsonb not null default '{}'::jsonb,
  -- online | busy | paused | offline
  status text not null default 'offline',
  last_heartbeat timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_training_devices_owner on training_devices (owner_id);
create index if not exists ix_training_devices_heartbeat on training_devices (last_heartbeat desc);

alter table training_devices enable row level security;

drop policy if exists "Users manage their own training devices" on training_devices;
create policy "Users manage their own training devices"
  on training_devices for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists training_device_tasks (
  id text primary key,
  owner_id uuid not null references auth.users,
  device_id text not null references training_devices(id) on delete cascade,
  job_id text references training_jobs(id) on delete cascade,
  -- train   : the device runs/assists the training job it was assigned
  -- preprocess : the device tokenizes one shard of the job's dataset
  kind text not null default 'train',
  -- assigned | running | completed | failed | expired
  status text not null default 'assigned',
  lease_expires_at timestamptz,
  progress_percent double precision not null default 0,
  shard_index integer,
  shard_count integer,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_training_device_tasks_owner on training_device_tasks (owner_id);
create index if not exists ix_training_device_tasks_device on training_device_tasks (device_id, status);
create index if not exists ix_training_device_tasks_job on training_device_tasks (job_id);
-- The coordinator sweeps expired leases with this index.
create index if not exists ix_training_device_tasks_lease
  on training_device_tasks (status, lease_expires_at);

alter table training_device_tasks enable row level security;

drop policy if exists "Users manage their own device tasks" on training_device_tasks;
create policy "Users manage their own device tasks"
  on training_device_tasks for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

comment on table training_devices is
  'Devices that may contribute compute; heartbeat drives online/offline and lease expiry';
comment on table training_device_tasks is
  'Lease-backed assignment of a job (train) or a dataset shard (preprocess) to one device';
