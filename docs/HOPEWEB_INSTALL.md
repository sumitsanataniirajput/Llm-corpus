# CORPUS ULTIMATE — Hopeweb Installation (Beginner-Friendly)

This guide walks you through uploading the frontend to Hopeweb, step by step.

## What is Hopeweb?

Hopeweb is a static website hosting service. The CORPUS frontend is pure HTML/CSS/JavaScript, so it works perfectly there. The Python backend runs separately on your computer or a server.

---

## Step 1: Understand the file structure

All frontend files are in the `frontend/` folder of this project:

```
frontend/
├── index.html          (root — the main page)
├── js/
│   ├── app-bootstrap.js     (NEW — starts the app)
│   ├── app-context.js       (NEW — shared page container)
│   ├── ai-information.js    (NEW — AI Information page)
│   ├── config.js            (Supabase + backend settings)
│   ├── supabase-client.js   (Supabase connection)
│   ├── api.js               (REST API calls)
│   ├── auth.js              (Sign in / sign up)
│   ├── state.js             (App state management)
│   ├── components.js        (UI helpers: toast, confirm, etc.)
│   ├── charts.js            (Chart.js charts)
│   ├── router.js            (Hash-based navigation)
│   ├── dashboard.js         (Dashboard page)
│   ├── models.js            (Models page)
│   ├── training.js          (Training Center page)
│   ├── statistics.js        (Statistics page)
│   ├── chat.js              (AI Chat page)
│   ├── prediction.js        (Prediction Lab page)
│   ├── neural-lab.js        (Neural Lab page)
│   ├── datasets.js          (Dataset Manager page)
│   ├── evaluation.js        (Evaluation Center page)
│   ├── compute.js           (Compute Manager page)
│   ├── storage.js           (Cloud Storage page)
│   ├── experiments.js       (Experiment Manager page)
│   └── settings.js          (Settings page)
├── css/
│   ├── variables.css   (Design tokens: colors, spacing, radius)
│   ├── layout.css      (Layout: app bar, sidebar, bottom nav)
│   ├── components.css  (Components: cards, buttons, stat cards)
│   ├── pages.css       (Page-specific styles)
│   └── responsive.css  (Mobile/responsive overrides)
└── assets/             (images, icons — if any)
```

**Important:** There is NO root-level `style.css` or `script.js`. All CSS is in `css/` and all JavaScript is in `js/`. The `index.html` file loads them from those subfolders.

---

## Step 2: Create folders in Hopeweb

1. Log in to your Hopeweb dashboard.
2. Create a new project (or open your existing one).
3. In the file manager, create these folders:
   - `js/`
   - `css/`
   - `assets/` (optional, only if you have images)

---

## Step 3: Upload files (in this order)

Upload files into the correct folders:

### Root (upload first)
1. `index.html` — from `frontend/index.html`

### `js/` folder (upload ALL of these)
From `frontend/js/`:
1. `app-bootstrap.js`
2. `app-context.js`
3. `ai-information.js`
4. `config.js`
5. `supabase-client.js`
6. `api.js`
7. `auth.js`
8. `state.js`
9. `components.js`
10. `charts.js`
11. `router.js`
12. `dashboard.js`
13. `models.js`
14. `training.js`
15. `statistics.js`
16. `chat.js`
17. `prediction.js`
18. `neural-lab.js`
19. `datasets.js`
20. `evaluation.js`
21. `compute.js`
22. `storage.js`
23. `experiments.js`
24. `settings.js`

### `css/` folder (upload ALL of these)
From `frontend/css/`:
1. `variables.css`
2. `layout.css`
3. `components.css`
4. `pages.css`
5. `responsive.css`

### `assets/` folder
Upload any image/icon files from `frontend/assets/` if present.

---

## Step 4: Configure Supabase and Backend URL

Edit `js/config.js` (download it first, edit, re-upload):

```javascript
window.CORPUS_CONFIG.SUPABASE_URL = 'https://your-project-ref.supabase.co';
window.CORPUS_CONFIG.SUPABASE_ANON_KEY = 'your-supabase-anon-key';
window.CORPUS_CONFIG.API_BASE_URL = 'https://your-backend-url.com';
```

- `SUPABASE_URL` and `SUPABASE_ANON_KEY`: from your Supabase project dashboard (Settings > API).
- `API_BASE_URL`: where your Python backend runs (e.g. `http://localhost:8000` for local, or your server URL).

If you don't have Supabase yet, leave the placeholder values. The app will run in limited demo mode — navigation and page viewing will work, but data features require a backend.

---

## Step 5: Configure Supabase (for data features)

1. In Supabase, go to SQL Editor.
2. Paste and run `supabase/migrations/001_initial_schema.sql`.
3. In Storage, create a private bucket named `corpus-storage`.
4. Enable Row Level Security (the migration does this automatically).

---

## Step 6: Verify it works

1. Open your Hopeweb site URL in a browser.
2. You should see the CORPUS ULTIMATE app with the purple brain logo.
3. Click each bottom navigation item — every section should display its content.
4. Try `?debug=1` at the end of your URL to see diagnostic information.
5. Check the browser's developer console (F12) for errors — should be clean.

---

## How to replace a file safely

1. Download the existing file from Hopeweb.
2. Edit it on your computer.
3. Upload the edited file, choosing "Replace" / "Overwrite".
4. Refresh your site to see changes.

---

## Diagnosing problems

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Blank white screen | Missing files or wrong folder | Re-upload `index.html` and all `js/`/`css/` files |
| Pages don't change when clicking nav | `router.js` not loaded | Verify `js/router.js` is in the `js/` folder |
| "Supabase not configured" toast | Wrong keys in `config.js` | Edit and re-upload `js/config.js` |
| API errors / CORS | Backend not running or wrong URL | Start backend; set `API_BASE_URL` |
| Styles broken | CSS files not in `css/` folder | Verify all CSS files are in `css/` |
| Console 404 on `.js` | JS file in wrong folder | Ensure all JS files are in `js/` folder |
| `pageContainer` errors | `app-context.js` missing | Upload `js/app-context.js` before `js/router.js` |

---

## Backend (separate)

The Python backend is NOT uploaded to Hopeweb. Deploy it separately per `docs/DEPLOYMENT.md`:

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env with your Supabase credentials
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Then set `API_BASE_URL` in `js/config.js` to your backend URL.