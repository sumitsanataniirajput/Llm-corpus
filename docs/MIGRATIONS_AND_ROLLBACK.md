# Supabase migrations and rollback playbook

These are **forward-only SQL files**, not an Alembic revision graph. The FastAPI
process does not create tables at startup. A human applies them in the Supabase
SQL editor, in filename order, after taking a database snapshot.

No migration in this repository has been applied to production by the P2 work.
The list below is the reviewed source of truth; `scripts/check-migrations.mjs`
fails CI if a SQL file is missing from this document or contains a destructive
forward statement.

## Before any migration

1. Record the current backend `build_id` and commit from `GET /api/v1/version`.
2. Take a Supabase database snapshot / point-in-time restore point.
3. Read the target SQL file in full. Several files are explicitly marked
   `FORWARD-ONLY` and require owner approval.
4. Apply to a staging project first when the migration changes column types,
   policies, or existing rows.
5. Deploy backend and frontend together only after the schema step succeeds;
   compare `/api/v1/version` and `/version.json` afterwards.

## Forward order

| # | File | Purpose | Data risk |
|---|------|---------|-----------|
| 001 | `001_initial_schema.sql` | Base tables, RLS policies, `uuid` owner columns | New project only; creates schema |
| 002 | `002_add_api_key_hash.sql` | Adds `api_keys_metadata.key_hash` | Additive column; approval required |
| 003 | `003_dataset_upload_status.sql` | Makes file-less datasets `pending` | Updates status semantics; approval required |
| 004 | `004_normalize_models_owner_id.sql` | Normalises legacy `models.owner_id` text → uuid | **Type change**; snapshot mandatory |
| 005 | `005_safe_production_alignment.sql` | Default/status and trigger search-path alignment | Non-destructive, review required |
| 006 | `006_fk_indexes_and_rls_initplan.sql` | FK indexes and initPlan RLS rewrites | Index/policy only |
| 007 | `007_training_progress_and_job_delete.sql` | Training progress columns and soft-delete | Additive columns |
| 008 | `008_training_devices.sql` | Device registrations and preprocessing leases | New tables only |
| 010 | `010_teacher_network_and_distillation.sql` | Teacher network / distillation tables | New tables; encrypted credentials |
| 011 | `011_student_models_and_training_telemetry.sql` | Student configs and runtime telemetry | New tables only |

There is intentionally **no `009` migration file** in this checkout. Do not
invent one or renumber the later files: their names match existing deployment
notes and tests.

## Rollback strategy

There is no automatic `downgrade` command and no down-migration SQL that is safe
to run unattended. Rollback is a decision, not a script:

1. **Application rollback:** redeploy the previous backend/frontend build. The
   deployed build ids are the observable proof; see
   [PRODUCTION_VERIFICATION.md](PRODUCTION_VERIFICATION.md).
2. **Additive objects (002, 006–008, 010–011):** the previous build ignores new
   columns/tables/indexes. Leave them in place unless storage or compliance
   requires removal. If removal is unavoidable, restore the pre-migration
   snapshot rather than issuing ad-hoc `DROP` statements.
3. **Semantic/status changes (003, 005):** previous code may interpret status
   differently. Restore a snapshot or write a reviewed data-fix migration; do
   not bulk-edit rows from the dashboard.
4. **Type change (004):** only a snapshot restore is considered safe. Converting
   `uuid` back to `text` can break ownership comparisons and RLS policies.
5. **Credentials (010):** encrypted provider credentials use
   `CREDENTIAL_ENCRYPTION_KEY`. Rotating or restoring that key changes which
   rows can be decrypted; keep the key stable across a rollback.
6. **After rollback:** verify health/readiness, run
   `GET /api/v1/models/ownership-diagnostics` for a known account, and create a
   tiny model/dataset to prove the old build still works.

## CI guard

`npm run check:migrations` runs `scripts/check-migrations.mjs`. It enforces that
every SQL filename is documented here, that numbering is unique, that the `009`
gap is explained, that a rollback section exists, and that forward SQL contains
no `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` or `DELETE FROM`. It never connects
to Supabase.
