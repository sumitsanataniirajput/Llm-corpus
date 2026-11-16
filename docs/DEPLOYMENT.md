# CORPUS ULTIMATE — Deployment Guide

## Overview

CORPUS ULTIMATE has two parts:

1. **Frontend** — static HTML/CSS/JS, deployable on Hopeweb (or any static host).
2. **Backend** — Python FastAPI server, runs on your computer, Linux server, or cloud.

They communicate via REST API (`/api/v1`) and WebSockets.

---

## Part 1: Supabase Setup (required for auth + cloud storage)

1. Create a free project at https://supabase.com
2. Go to **SQL Editor** and run the migration:
   `supabase/migrations/001_initial_schema.sql`
3. Go to **Authentication > Settings** and note:
   - Project URL
   - `anon` / `public` key (safe for frontend)
   - `service_role` key (backend only — NEVER expose)
4. Go to **Storage** and create a private bucket named `corpus-storage`.
5. Enable **Row Level Security** (already in migration) — verify policies are active.

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
pip install --no-audit --no-fund --fetch-retries=3 -r requirements.txt
```

### B. Configure environment

```bash
cp .env.example .env
# Edit .env with your Supabase URL, keys, and secrets
```

Required `.env` values:
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_ANON_KEY` — anon key
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (backend only)
- `DATABASE_URL` — Supabase PostgreSQL connection string
- `SECRET_KEY` — strong random string for JWT
- `WORKER_AUTH_SECRET` — secret for worker registration

### C. Run database migrations

The migration SQL is in `supabase/migrations/001_initial_schema.sql`. Run it in the Supabase SQL Editor. The FastAPI app also attempts `Base.metadata.create_all` on startup (dev convenience).

### D. Start the FastAPI server

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Verify: open `http://127.0.0.1:8000/api/v1/health` — should return `{"status": "ok"}`.
API docs: `http://127.0.0.1:8000/api/v1/docs`

### E. Register a worker (local or cloud)

The backend exposes `/api/v1/compute/workers/register` (requires `WORKER_AUTH_SECRET`). A worker process sends heartbeats to `/api/v1/compute/workers/{id}/heartbeat`.

---

## Part 3: Frontend Deployment (Hopeweb)

Hopeweb hosts static sites. Upload the `frontend/` folder contents:

| File | Hopeweb location |
|------|-----------------|
| `index.html` | project root |
| `style.css` | project root |
| `script.js` | project root |
| `js/*.js` | `js/` folder |
| `css/*.css` | `css/` folder |
| `assets/*` | `assets/` folder |

### How to upload in Hopeweb

1. Log in to Hopeweb.
2. Create folders: `js`, `css`, `assets` (if not present).
3. Upload `index.html`, `style.css`, `script.js` to the root.
4. Upload all `js/` files to the `js` folder.
5. Upload all `css/` files to the `css` folder.
6. Upload assets to `assets`.

### Configure the frontend

Edit `frontend/js/config.js`:

```javascript
window.CORPUS_CONFIG.SUPABASE_URL = 'https://your-project.supabase.co';
window.CORPUS_CONFIG.SUPABASE_ANON_KEY = 'your-anon-key';
window.CORPUS_CONFIG.API_BASE_URL = 'https://your-backend-url.com';
```

### Verify

1. Open your Hopeweb site URL.
2. Sign up / sign in (Supabase Auth).
3. Create a model, upload a dataset, start training.
4. Check the browser console for errors.

---

## Part 4: Local Worker (Windows / macOS / Linux)

A local worker runs the Python training engine on your machine.

1. Follow Part 2 (backend setup).
2. Set `compute=local` when creating a training job in the frontend.
3. The backend runs training in-process using PyTorch (CPU) or the custom numerical engine.
4. Monitor progress via WebSocket in the Training Center.

### Hardware detection

The backend reports available device (`cpu`, `cuda`, `mps`) via the health/compute endpoints. GPU training requires CUDA-capable PyTorch (`pip install torch --index-url https://download.pytorch.org/whl/cu118`).

---

## Part 5: Cloud Worker

A cloud worker runs on a separate server:

1. Deploy the backend Docker image: `docker-compose up`.
2. Set `compute=cloud` when creating training jobs.
3. Jobs are queued and assigned to registered workers via heartbeats.
4. Checkpoints upload to Supabase Storage.

---

## Android / iOS Mobile

- Open the Hopeweb URL in Chrome (Android) or Safari (iOS).
- Use the bottom navigation (mobile-native feel).
- A phone can **manage** remote jobs but typically cannot train large models locally.
- To control a remote worker: register the worker on a Linux/cloud server, then use the phone's Compute Manager to view and assign jobs.

---

## Verifying what a Render deployment is actually running

A merged commit on `main` does **not** mean the live services run it. Use
[`docs/PRODUCTION_VERIFICATION.md`](PRODUCTION_VERIFICATION.md):

* backend: `GET https://corpus-ultimate-api.onrender.com/api/v1/version`
  (`build_id`, `commit` from `RENDER_GIT_COMMIT`, `features`),
* frontend: `GET https://corpus-ultimate-web.onrender.com/version.json`.

Both must match `main`. If they do not, the deployment is stale — redeploy from
the Render dashboard and check the build log.

## Database migrations

Run these once, in order, in the Supabase SQL editor:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_add_api_key_hash.sql`
3. `supabase/migrations/003_dataset_upload_status.sql`
4. `supabase/migrations/004_normalize_models_owner_id.sql` — converts
   `models.owner_id` from `text` to `uuid` (idempotent; never reassigns owners)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Supabase not configured | Check `js/config.js` values match your Supabase project |
| Backend connection refused | Ensure `API_BASE_URL` points to a running uvicorn instance |
| CORS error | Add your frontend URL to `CORS_ORIGINS` in backend `.env` |
| Training fails | Verify model config passes validation (d_model % n_heads == 0) |
| RLS blocks access | Run the migration SQL; ensure policies are enabled |

---

## Security Notes

- Never commit `.env` with real secrets.
- The Supabase `anon` key is public-safe when RLS is enabled.
- The `service_role` key must stay backend-only.
- API keys are stored hashed in the database, never in browser LocalStorage.