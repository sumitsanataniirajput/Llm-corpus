# CORPUS ULTIMATE — Project Notes

## How to run

### Frontend
Static files in `frontend/` — open `index.html` or deploy to Hopeweb.

### Backend (local development — same device only)
```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Backend (LAN / Android access — same Wi-Fi network)
```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
Then set `API_BASE_URL` in `frontend/js/config.js` to `http://<your-computer-lan-ip>:8000`.

### Tests
```bash
cd backend
pytest corpus_engine/tests/
```

## Supabase
- Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL Editor.
- Create private bucket `corpus-storage`.
- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` in backend `.env`.
- Get `DATABASE_URL` from: Supabase Dashboard → Settings → Database → Connection string → URI.

## Frontend config
- Edit `frontend/js/config.js` with your Supabase URL, anon key, and backend API URL.
- For Android: set `API_BASE_URL` to `http://<your-computer-lan-ip>:8000` (NOT localhost).
- For production: set `API_BASE_URL` to `https://your-backend-domain.com`.

## Key architectural decisions
- Custom decoder-only transformer in `backend/corpus_engine/` (pure Python + PyTorch engine).
- Two training engines: custom numerical engine (Tensor autodiff) and PyTorch.
- Supabase Auth + RLS on all user tables.
- Hash-based frontend router; no build step required.
- Backend binds to `0.0.0.0` by default for LAN/Android access.

## Pitfalls
- Do not nest template literals inside template literals in frontend JS.
- PyTorch is CPU-only by default; install CUDA wheel separately for GPU.
- Never commit `.env` with real secrets.
- `DATABASE_URL` in `.env` must be a real Supabase PostgreSQL connection string, not a placeholder.
- On Android, `localhost` refers to the phone itself — use your computer's LAN IP.