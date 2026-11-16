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

## Deployment verification

A merged commit on `main` is not proof that the live Render services run it.
Check what the deployment actually executes:

- backend: `GET https://corpus-ultimate-api.onrender.com/api/v1/version`
  (`build_id`, `commit`, `features`)
- frontend: `GET https://corpus-ultimate-web.onrender.com/version.json`

See [docs/PRODUCTION_VERIFICATION.md](docs/PRODUCTION_VERIFICATION.md) for the
full playbook (deployment identity, `403 Not authorized` diagnostics, database
migration `004`, and the real-device Android file-picker checklist).

## UI documentation

Design tokens, mobile/layout contract, data-honesty rules, dataset formats and
test commands are documented in [docs/UI_MODERNIZATION.md](docs/UI_MODERNIZATION.md).

## License

MIT License — see LICENSE file.

## Aria — Android floating AI voice assistant (included)

The repository also vendors **Aria**, a floating AI voice assistant for Android
(screen reading and phone task automation), imported from a Google AI Studio
export, together with an experimental training pipeline under `training/`
(dataset generation, QLoRA fine-tuning, evaluation, and a from-scratch CPU
trainer with a hybrid slot layer).

- Android app sources: the Gradle project rooted at this directory (`app/src/main/…`, `settings.gradle.kts`, `gradle/`)
- Training pipeline: `training/`
- AI Studio project: https://ai.studio/apps/29fa7b70-bfe7-473a-95cd-8341d54fa805
- `.env.example` documents `GEMINI_API_KEY`. Real keys stay in a local, gitignored `.env` — never commit them.

### Run Aria locally

**Prerequisites:** [Android Studio](https://developer.android.com/studio)

1. Open Android Studio
2. Select **Open** and choose this repository's root directory (it is the Android Gradle project root)
3. Allow Android Studio to fix any incompatibilities as it imports the project
4. Create a file named `.env` in the project directory and set `GEMINI_API_KEY` to your Gemini API key (see `.env.example`)
5. Remove this line from the app's `app/build.gradle.kts` file: `signingConfig = signingConfigs.getByName("debugConfig")`
6. Run the app on an emulator or physical device

> Aria is an independent component tracked in this repository alongside CORPUS
> ULTIMATE (frontend/backend). The two share no build system: Android Studio
> opens the Gradle project rooted here, while CORPUS ULTIMATE is run as
> described in the sections above.
