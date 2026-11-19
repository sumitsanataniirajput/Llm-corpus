# CORPUS ULTIMATE

Personal LLM development, training, experimentation, and monitoring platform.

## Product identity

- **Product:** CORPUS ULTIMATE
- **AI/model name:** CORPUS
- **Category:** Personal LLM development, training, experimentation, and monitoring platform

## What it is

A self-hostable AI workspace that currently lets you:

- Create custom transformer model configurations from randomly initialized weights
- Train a small decoder-only model with the real in-process PyTorch CPU engine
- Store datasets, checkpoints, tokenizers and configurations in private Supabase Storage
- Register devices for dataset-shard preprocessing and heartbeat/lease coordination
- Monitor genuine optimizer-step metrics, job events and checkpoints
- Chat with a **trained** model through checkpoint-backed inference (no external model API)
- Inspect the real tokenizer and next-token logits in Prediction Lab
- Inspect architecture, computed parameter counts and training history
- Export the stored model configuration and private-object references

See [docs/STATUS_AND_LIMITATIONS.md](docs/STATUS_AND_LIMITATIONS.md) for the
explicit list of what is not implemented. Device-side/cloud gradient training,
hosted-model fine-tuning, evaluation scoring and one-click model deployment are
not part of the running backend.

## Technology stack

**Frontend:** HTML5, CSS3, Vanilla JavaScript ES6+, Font Awesome, Material Design 3-inspired, Chart.js, SweetAlert2, WebSocket, Fetch API, IndexedDB, LocalStorage

**Backend:** Python 3.11+, FastAPI, Pydantic, SQLAlchemy, PyTorch, Hugging Face Transformers/tokenizers, WebSocket endpoints, background job workers

**Database & Cloud:** Supabase Auth, Supabase PostgreSQL, Supabase Storage, Supabase Row Level Security, Supabase client SDK

## Repository structure

```
Llm-corpus/
├── frontend/                 # static frontend (no build step)
│   ├── index.html
│   ├── version.json
│   ├── css/                  # variables, layout, components, pages, responsive
│   ├── js/                   # route modules, API client, shared UI helpers
│   └── tests/                # jsdom regression suites
├── backend/                  # Python FastAPI training + inference server
│   ├── app/
│   ├── corpus_engine/
│   ├── tests/
│   ├── requirements.txt
│   └── .env.example
├── supabase/                 # forward-only SQL migrations and seed
│   └── migrations/
├── scripts/                  # deployment verification + repo hygiene checks
├── docs/                     # architecture, deployment, migration and status docs
├── package.json              # frontend test tooling only
├── package-lock.json
├── README.md
├── AGENTS.md
└── .gitignore
```

## Quick start

### 1. Configure Supabase

1. Create a project at https://supabase.com
2. Copy your Project URL and `anon` (public) key
3. Apply the SQL migrations in `supabase/migrations/` **in filename order**; see
   [docs/MIGRATIONS_AND_ROLLBACK.md](docs/MIGRATIONS_AND_ROLLBACK.md)
4. Verify Row Level Security (RLS) policies are active (migrations include them)

### 2. Deploy the frontend (Hopeweb)

Upload the **entire `frontend/` directory** to a static host, preserving its
`js/` and `css/` subdirectories. There is no root `style.css` or `script.js`:
`frontend/index.html` loads the stamped files under `js/` and `css/` and must
also serve `version.json`.

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
# apply the SQL migrations manually (the app does NOT call create_all on startup)
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

## Local verification

```bash
npm ci --no-audit --no-fund
npm run test:ci              # migration manifest, docs, baseline-aware jsdom gate
cd backend
pytest -q                   # real SQLAlchemy models + throw-away pgserver PostgreSQL
pytest corpus_engine/tests -q
```

`npm test` still contains 11 known pre-existing failures; `npm run test:baseline`
fails only when a **new** failure appears. See
[docs/STATUS_AND_LIMITATIONS.md](docs/STATUS_AND_LIMITATIONS.md).

## UI documentation

Design tokens, mobile/layout contract, data-honesty rules, dataset formats and
test commands are documented in [docs/UI_MODERNIZATION.md](docs/UI_MODERNIZATION.md).

Navigation is one hamburger-opened drawer at every screen size, with every page
declared once in `frontend/js/routes.js`; the shell, the route registry and the
automated route/module checks are documented in
[docs/NAVIGATION.md](docs/NAVIGATION.md).

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
