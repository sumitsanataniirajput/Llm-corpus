# CORPUS ULTIMATE

Personal LLM development, training, experimentation, and monitoring platform.

## Product identity

- **Product:** CORPUS ULTIMATE
- **AI/model name:** CORPUS
- **Category:** Personal LLM development, training, experimentation, and monitoring platform

## What it is

A real, self-hostable AI platform that lets you:

- Create custom language models from randomly initialized weights
- Design and configure transformer architectures
- Train models with a genuine PyTorch engine and a custom numerical engine
- Fine-tune supported open-source models
- Store datasets, weights, checkpoints, and configurations in Supabase cloud storage
- Switch between devices and continue training
- Monitor genuine training metrics
- Chat with your trained model (real inference, no external API routing)
- Explore tokenization and next-token probabilities
- Inspect architecture, parameters, vocabulary, and training history
- Export and deploy models

## Technology stack

**Frontend:** HTML5, CSS3, Vanilla JavaScript ES6+, Font Awesome, Material Design 3-inspired, Chart.js, SweetAlert2, WebSocket, Fetch API, IndexedDB, LocalStorage

**Backend:** Python 3.11+, FastAPI, Pydantic, SQLAlchemy, PyTorch, Hugging Face Transformers/tokenizers, WebSocket endpoints, background job workers

**Database & Cloud:** Supabase Auth, Supabase PostgreSQL, Supabase Storage, Supabase Row Level Security, Supabase client SDK

## Repository structure

```
corpus-ultimate/
├── frontend/                 # Hopeweb-deployable static frontend
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   ├── assets/
│   ├── js/
│   └── css/
├── backend/                  # Python FastAPI training server
│   ├── app/
│   ├── corpus_engine/
│   ├── requirements.txt
│   ├── .env.example
│   ├── Dockerfile
│   └── docker-compose.yml
├── supabase/                 # Database migrations and seed
│   ├── migrations/
│   ├── seed.sql
│   └── config.toml
├── scripts/
├── docs/
├── README.md
├── LICENSE
└── .gitignore
```

## Quick start

### 1. Configure Supabase

1. Create a project at https://supabase.com
2. Copy your Project URL and `anon` (public) key
3. Run the SQL migrations in `supabase/migrations/` against your Supabase database
4. Enable Row Level Security (RLS) on all tables (migrations include policies)

### 2. Deploy the frontend (Hopeweb)

Upload the `frontend/` folder to Hopeweb:

- `index.html` → Hopeweb project root
- `style.css` → Hopeweb project root
- `script.js` → Hopeweb project root
- `js/*.js` → Hopeweb/js/
- `css/*.css` → Hopeweb/css/
- `assets/*` → Hopeweb/assets/

Edit `frontend/js/config.js` and set:
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_ANON_KEY` — your Supabase anon key
- `API_BASE_URL` — your backend API URL (e.g. `http://localhost:8000`)

### 3. Run the backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env with your Supabase credentials
alembic upgrade head  # or run supabase migrations manually
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4. Connect

Open the frontend in your browser. Sign up/sign in with Supabase Auth. Create a model, upload a dataset, and start training.

Datasets are read as text with per-format extraction: `.txt`, `.md`, `.csv`,
`.json`, `.jsonl` and text-layer `.pdf` (no OCR). Binary, empty and scanned files
are rejected with an explanation instead of being trained on as noise.

## UI documentation

Design tokens, mobile/layout contract, data-honesty rules, dataset formats and
test commands are documented in [docs/UI_MODERNIZATION.md](docs/UI_MODERNIZATION.md).

## License

MIT License — see LICENSE file.