# SQL migrations

Apply these files manually, in filename order, from the Supabase SQL editor.
They are forward-only; the FastAPI app does **not** call
`Base.metadata.create_all` at startup.

Read [../../docs/MIGRATIONS_AND_ROLLBACK.md](../../docs/MIGRATIONS_AND_ROLLBACK.md)
before applying any file. It lists every migration, flags the `004` column-type
change, explains the intentional `009` gap, and gives the snapshot-based
rollback playbook. `npm run check:migrations` verifies that this directory and
that document stay in sync.
