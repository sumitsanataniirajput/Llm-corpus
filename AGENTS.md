# CORPUS ULTIMATE — Project Notes

Read [docs/STATUS_AND_LIMITATIONS.md](docs/STATUS_AND_LIMITATIONS.md) before
changing product copy: it is the source of truth for implemented vs. not
implemented features.

## How to run

### Frontend
Static files in `frontend/` — serve `index.html` over HTTP (opening `file://`
will not exercise Supabase Auth or the API). No build step.

### Backend (local development — same device only)
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# apply supabase/migrations/*.sql manually, in filename order
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Backend (LAN / Android access — same Wi-Fi network)
```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
Then set `API_BASE_URL` in `frontend/js/config.js` to `http://<your-computer-lan-ip>:8000`.

### Tests
```bash
# from repository root
npm ci --no-audit --no-fund
npm run test:ci              # migration manifest, docs, baseline-aware jsdom gate
npm test                     # full TAP output; 11 known baseline failures

cd backend
pytest -q                   # app tests against throw-away pgserver PostgreSQL
pytest corpus_engine/tests -q
```

## Supabase
- Apply **all** `supabase/migrations/*.sql` files in filename order. See
  [docs/MIGRATIONS_AND_ROLLBACK.md](docs/MIGRATIONS_AND_ROLLBACK.md); migration
  `004` changes a column type and needs a snapshot.
- Create private bucket `corpus-storage`.
- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` in backend `.env`.
- Get `DATABASE_URL` from: Supabase Dashboard → Settings → Database → Connection string → URI.
- The FastAPI app does **not** run `Base.metadata.create_all` or Alembic at startup.

## Frontend config
- Edit `frontend/js/config.js` with your Supabase URL, anon key, and backend API URL.
- For Android: set `API_BASE_URL` to `http://<your-computer-lan-ip>:8000` (NOT localhost).
- For production: set `API_BASE_URL` to `https://your-backend-domain.com`.

## Key architectural decisions
- Production training uses the real PyTorch `CorpusTransformerPT` in-process on CPU;
  the pure-Python numerical engine is experimental and is not the training endpoint.
- Checkpoint-backed inference loads the exact saved state dict + tokenizer from
  private storage. No external model API is called.
- Browser WebSockets authenticate with a first-frame auth message, never `?token=`.
- Supabase Auth + RLS on all user tables.
- Hash-based frontend router; no build step required.
- Connected devices preprocess dataset shards only; there is no cloud/device
  gradient training and no `compute="cloud"` mode.

## Pitfalls
- Do not nest template literals inside template literals in frontend JS.
- PyTorch is CPU-only by default; install a CUDA wheel separately for GPU.
- Never commit `.env` with real secrets. `package-lock.json` is committed for CI.
- `DATABASE_URL` in `.env` must be a real Supabase PostgreSQL connection string, not a placeholder.
- On Android, `localhost` refers to the phone itself — use your computer's LAN IP.
- `TRUSTED_PROXY_IPS` must be configured before trusting forwarded client IPs;
  the rate limiter is per-process, not shared across instances.
