# CORPUS ULTIMATE — Deployment Guide

> Read [STATUS_AND_LIMITATIONS.md](STATUS_AND_LIMITATIONS.md) first. This guide
> describes the code in this checkout, not a service that has been redeployed.

## Overview

CORPUS ULTIMATE has two parts:

1. **Frontend** — static HTML/CSS/JS, deployable on any static host.
2. **Backend** — Python FastAPI server, run locally, on a Linux server, or on a
   container host.

They communicate via REST (`/api/v1`) and authenticated WebSockets. Browser
sockets send the Supabase token as the **first frame**, never in a query string.

---

## Part 1: Supabase Setup (required for auth + private storage)

1. Create a project at https://supabase.com.
2. Apply **all** SQL migrations in `supabase/migrations/` in filename order. See
   [MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md) before migration
   `004` (it changes a column type and requires a snapshot).
3. Go to **Authentication > Settings** and note:
   - Project URL
   - `anon` / `publishable` key (safe for frontend)
   - `service_role` key (backend only — NEVER expose)
4. Go to **Storage** and create a private bucket named `corpus-storage`.
5. Verify **Row Level Security** policies are active; the migrations create them.

---

## Part 2: Backend Deployment

### A. Prepare Python environment (Windows / macOS / Linux)

```bash
cd backend
python3 -m venv venv

# macOS / Linux
source venv/bin/activate

# Windows
venv\Scripts\activate

pip install --upgrade pip
pip install -r requirements.txt
```

### B. Configure environment

```bash
cp .env.example .env
# Edit .env with your Supabase URL, keys, and secrets
```

Required `.env` values:
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_ANON_KEY` — anon / publishable key
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (backend only)
- `DATABASE_URL` — Supabase PostgreSQL connection string
- `SECRET_KEY` — strong random string for JWT
- `WORKER_AUTH_SECRET` — secret for worker registration
- `CREDENTIAL_ENCRYPTION_KEY` — 32-byte hex key for encrypted provider credentials
- `TRUSTED_PROXY_IPS` — proxy IPs allowed to supply forwarded client addresses

### C. Run database migrations

Apply the SQL files manually in the Supabase SQL editor, in filename order.
The FastAPI app does **not** call `Base.metadata.create_all` or Alembic on
startup. See [MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md).

### D. Start the FastAPI server

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Verify: `http://127.0.0.1:8000/api/v1/health` reports liveness and
`/ready` reports database/Supabase readiness. API docs are at
`http://127.0.0.1:8000/api/v1/docs`.

### E. Worker registration, honestly

`/api/v1/compute/workers/register` exists and requires `WORKER_AUTH_SECRET`,
but registered workers **do not execute gradient training**. Training runs
in-process on the backend CPU. Device endpoints coordinate dataset-shard
preprocessing only. There is no `compute="cloud"` mode.

---

## Part 3: Frontend Deployment (static host)

Upload the **entire `frontend/` directory**, preserving its `js/` and `css/`
subdirectories. `index.html` loads build-stamped files from those directories;
there is no root `style.css`, `script.js`, or `assets/` directory. Keep
`version.json` at the site root.

| File | Static-host location |
|------|----------------------|
| `frontend/index.html` | project root |
| `frontend/version.json` | project root |
| `frontend/js/*.js` | `js/` folder |
| `frontend/css/*.css` | `css/` folder |

### Configure the frontend

Edit `frontend/js/config.js`:

```javascript
window.CORPUS_CONFIG.SUPABASE_URL = 'https://your-project.supabase.co';
window.CORPUS_CONFIG.SUPABASE_ANON_KEY = 'your-anon-key';
window.CORPUS_CONFIG.API_BASE_URL = 'https://your-backend-url.com';
```

### Verify

1. Open the static site URL.
2. Sign up / sign in (Supabase Auth).
3. Create a model, upload a dataset, start a short CPU training job.
4. After it completes, select the trained model in Chat or Prediction Lab.
5. Check the browser console and `GET /api/v1/version` / `/version.json`.

---

## Part 4: Local compute (Windows / macOS / Linux)

1. Follow Part 2 (backend setup).
2. Create a training job from the Training page; the only accepted compute mode
   is `local`.
3. The backend runs the real PyTorch `CorpusTransformerPT` in-process on CPU and
   writes metrics, a checkpoint and tokenizer to private storage.
4. Monitor progress through the authenticated `/api/v1/training/ws/{job_id}`
   socket. Inference reads the saved checkpoint after the job completes.

### Hardware detection

The API reports CPU/host telemetry. The pinned runtime uses CPU PyTorch; a CUDA
wheel is a manual, separate installation and is not required for the default
training path.

---

## Part 5: Cloud / distributed workers — not implemented

There is no cloud gradient worker, parameter server, federated averaging, or
device-side backpropagation in this checkout. Do not set `compute=cloud`; the
backend rejects it. Deploying a second container does not distribute a training
job. See [DEVICE_TRAINING.md](DEVICE_TRAINING.md) for what connected devices
actually do.

---

## Android / iOS Mobile

- Open the static site in Chrome (Android) or Safari (iOS).
- Navigation is one hamburger-opened sidebar at every screen size; the old
  bottom navigation was removed.
- A phone can register as a preprocessing device and manage jobs, but it does
  not run gradient training locally.
- For LAN development, use the computer's LAN IP in `API_BASE_URL`, not
  `localhost`.

---

## Verifying what a Render deployment is actually running

A merged commit on `main` does **not** mean the live services run it. Use
[PRODUCTION_VERIFICATION.md](PRODUCTION_VERIFICATION.md):

* backend: `GET https://corpus-ultimate-api.onrender.com/api/v1/version`
  (`build_id`, `commit` from `RENDER_GIT_COMMIT`, `features`),
* frontend: `GET https://corpus-ultimate-web.onrender.com/version.json`.

Both must match `main`. If they do not, the deployment is stale — redeploy from
the Render dashboard and check the build log.

## Database migrations

Run all ten SQL files once, in filename order:

`001_initial_schema.sql`, `002_add_api_key_hash.sql`,
`003_dataset_upload_status.sql`, `004_normalize_models_owner_id.sql`,
`005_safe_production_alignment.sql`, `006_fk_indexes_and_rls_initplan.sql`,
`007_training_progress_and_job_delete.sql`, `008_training_devices.sql`,
`010_teacher_network_and_distillation.sql`,
`011_student_models_and_training_telemetry.sql`.

There is no `009` file. The full forward/rollback playbook is
[MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md); `npm run
check:migrations` verifies the list in CI.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Supabase not configured | Check `js/config.js` values match your Supabase project |
| Backend connection refused | Ensure `API_BASE_URL` points to a running uvicorn instance |
| CORS error | Add your frontend URL to `CORS_ORIGINS` in backend `.env` |
| Training fails | Verify model config passes validation (`d_model % n_heads == 0`) and the dataset has a stored file |
| Inference says unavailable | Train the model first; untrained models have no checkpoint/tokenizer |
| RLS blocks access | Apply the migration SQL in order; verify policies are enabled |
| WebSocket closes with 1008 | The client must send `{"type":"auth","token":"..."}` as the first frame |

---

## Security Notes

- Never commit `.env` with real secrets.
- The Supabase `anon` / publishable key is public-safe when RLS is enabled.
- The `service_role` key must stay backend-only.
- API keys are stored hashed in the database, never in browser LocalStorage.
