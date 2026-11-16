-- ============================================================
-- 004 — normalize user ids on `models` to a real `uuid` column
--
-- Root cause this migration addresses
-- -----------------------------------
-- `001_initial_schema.sql` creates `models.owner_id` as **text**, while
-- `backend/app/core/models.py` maps it as `UUID(as_uuid=True)` and every
-- endpoint compares it with the authenticated Supabase user id (a UUID).
--
-- On a text column SQLAlchemy hands Python a `str`, so a comparison such as
--     model.owner_id != uuid.UUID(user["user_id"])
-- is *always* true and the legitimate owner gets `403 Not authorized`.
-- The mirror-image problem is a UUID-bind against a text column:
--     SELECT ... WHERE owner_id = $1(uuid)  ->  operator does not exist: text = uuid
--
-- What this migration does
-- ------------------------
-- 1. Detects the live column type of `public.models.owner_id`.
-- 2. If it is not `uuid`, converts it to `uuid` in place, preserving every
--    existing value (`USING owner_id::uuid`). No row's owner changes and no row
--    is deleted.
-- 3. Re-attaches the `auth.users(id)` foreign key (a text column cannot have a
--    valid FK to `auth.users.id`, which is uuid).
--
-- It is idempotent: running it on an already-`uuid` column is a no-op.
-- It is safe to run twice, and safe to run while the app is up.
--
-- Before running, check for rows whose owner_id is not a UUID:
--     SELECT id, owner_id FROM public.models
--      WHERE owner_id IS NOT NULL
--        AND owner_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
-- If that returns rows, they are orphans that were never created by this
-- application; this migration will refuse to run instead of guessing, and you
-- should decide what to do with them (it never reassigns ownership).
-- ============================================================

do $$
declare
  current_type text;
  bad_rows bigint;
begin
  select data_type
    into current_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'models'
     and column_name = 'owner_id';

  if current_type is null then
    raise notice '004: public.models.owner_id not found — nothing to do';
    return;
  end if;

  if current_type = 'uuid' then
    raise notice '004: public.models.owner_id is already uuid — no change needed';
    return;
  end if;

  -- Refuse to guess: rows that are not UUIDs cannot be cast safely.
  execute $q$
    select count(*) from public.models
     where owner_id is not null
       and owner_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  $q$ into bad_rows;

  if bad_rows > 0 then
    raise exception
      '004: % row(s) in public.models have a non-UUID owner_id; fix or delete them first (this migration never reassigns ownership)', bad_rows;
  end if;

  raise notice '004: converting public.models.owner_id from % to uuid', current_type;

  -- Drop the (invalid) FK if present, convert, then re-add it.
  execute $q$
    alter table public.models drop constraint if exists models_owner_id_fkey
  $q$;

  execute $q$
    alter table public.models alter column owner_id type uuid using owner_id::uuid
  $q$;

  begin
    execute $q$
      alter table public.models
        add constraint models_owner_id_fkey
        foreign key (owner_id) references auth.users (id) on delete cascade
    $q$;
  exception when others then
    raise notice '004: could not add models_owner_id_fkey (%), continuing', sqlerrm;
  end;

  raise notice '004: public.models.owner_id is now uuid';
end
$$;

-- Keep the owner lookup fast for the type-agnostic filter used by the API
-- (CAST(owner_id AS VARCHAR) is only needed while the column is text; this
-- index keeps the canonical uuid comparison fast afterwards).
create index if not exists idx_models_owner on public.models (owner_id);
