# CORPUS ULTIMATE — Production verification playbook

This file exists because of two incidents where the repository contained a fix
but the live app still misbehaved. **A GitHub commit is not evidence that a
deployment is running it.** Use the checks below to prove what each Render
service is actually executing.

---

## 1. Render services

| Purpose | Service | Branch to deploy |
|---|---|---|
| FastAPI backend | `corpus-ultimate-api` | `main` |
| Static frontend | `corpus-ultimate-web` | `main` |

Both services must have:

* **Settings → Build & Deploy → Branch:** `main`
* **Auto-Deploy:** `On` (deploys every new commit on `main`)
* **Settings → Root Directory:** `backend` for the API service, `frontend` for
  the static site (a Render *Static Site* with Publish Directory `frontend`
  works too).
* **Environment** (`corpus-ultimate-api`): `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY`,
  `DATABASE_URL`, `SECRET_KEY`, `WORKER_AUTH_SECRET`, `CORS_ORIGINS` (must
  include the deployed frontend origin), `ALLOWED_HOSTS` (must include both
  onrender hostnames).

Render injects `RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH`, `RENDER_SERVICE_NAME`
into the running process. The API reports them, which is what makes the
deployed SHA checkable **without dashboard access**.

---

## 2. Prove the backend deployment

```bash
# 1) What is running right now?
curl -s https://corpus-ultimate-api.onrender.com/api/v1/version | python3 -m json.tool

# 2) What is on main?
gh api repos/sumitsanataniirajput/Llm-corpus/commits/main --jq .sha
```

Expected:

```json
{
  "service": "corpus-ultimate-api",
  "build_id": "2026-11-17.1",
  "commit": "<sha of the newest commit on main>",
  "branch": "main",
  "features": [
    "owner-id-normalization",
    "owner-column-type-agnostic",
    "owner-delete-authorized",
    "model-delete-cleanup",
    "ownership-diagnostics",
    "version-endpoint-present"
  ]
}
```

If `build_id` is missing or older, or `commit` does not match `main`, the
service is running an old build:

1. Render Dashboard → `corpus-ultimate-api` → **Events**: look for the newest
   deploy and its commit.
2. If the newest deploy is older than `main`, trigger
   **Manual Deploy → Deploy latest commit**.
3. If the newest deploy *failed*, read the build log (see §5).
4. If it succeeded but `/api/v1/version` is still old, the service is deploying
   a different repository/branch, or the request is hitting a different host —
   re-check *Settings → Repository* and the URL you curl.

A missing `/api/v1/version` route (404) is itself proof of an old build: the
route only exists from commit that introduced `build_id 2026-11-17.1` onward.

---

## 2b. Automated check (CI, every push and every 30 minutes)

`scripts/verify-deployment.mjs` performs §2 and §3 automatically and exits
non-zero when the live services are stale, so a red workflow — not a support
report — is how a stale deployment becomes visible.

```bash
npm run verify:deployment        # uses the two Render URLs by default
EXPECTED_COMMIT=$(git rev-parse HEAD) npm run verify:deployment
WAIT_SECONDS=900 npm run verify:deployment   # poll while Render builds
node scripts/verify-deployment.mjs --api http://localhost:8000 --web http://localhost:5500
```

It checks:

1. `GET <API>/api/v1/version` → `build_id` equals `BUILD_ID` in
   `backend/app/api/endpoints/version.py`, **every** `FEATURES` marker listed
   there is reported by the running process, and `commit` equals the expected
   SHA when one is supplied;
2. `GET <WEB>/version.json` → `buildId` equals `frontend/version.json`;
3. Served assets contain the shipped markers, i.e. the real code is live and
   not just a matching build id:
   * `GET <WEB>/js/datasets.js` → `drop-zone-input` (transparent overlay input)
     and `datasets-drop` (tap-to-open zone with the click fallback),
   * `GET <WEB>/css/responsive.css` → `min-aspect-ratio: 21/9` (large-display /
     TV scaling breakpoints),
   * `GET <WEB>/index.html` → `width=device-width` (responsive viewport).

   `index.html` also requests every local stylesheet/script with
   `?v=<buildId>`, so a stale browser cache can no longer hide a shipped fix.

Render's free-tier “Application loading” splash is retried, not reported as a
broken service. Output names the exact stale artefact, e.g.:

```
RESULT: the live deployment does NOT match this checkout.
- <api>/api/v1/version -> 404 Not Found. The running API does not expose the version route at all,
  so it is OLDER than build 2026-11-17.1: redeploy corpus-ultimate-api from main
```

`.github/workflows/verify-deployment.yml` runs it on every push to `main`
(waiting up to 15 minutes for Render to build), on demand, and on a 30-minute
schedule so a service that quietly stops deploying is still caught. Its tests
live in `scripts/tests/verify-deployment.test.mjs` (`npm run test:deployment`).

---

## 3. Prove the frontend deployment

```bash
curl -s https://corpus-ultimate-web.onrender.com/version.json | python3 -m json.tool
gh api repos/sumitsanataniirajput/Llm-corpus/contents/frontend/version.json \
  -H "Accept: application/vnd.github.raw" | python3 -m json.tool
```

The two `buildId` values must be identical. In the browser you can also open
`https://corpus-ultimate-web.onrender.com/version.json` directly, and use
DevTools → **Network** → hard reload to confirm the JS/CSS files are not served
from a stale service worker or browser cache.

---

## 4. Diagnose `403 Not authorized` on model deletion

The API never bypasses ownership, but it can now *explain* a refusal.

```bash
TOKEN='<Supabase access token from the browser session>'
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://corpus-ultimate-api.onrender.com/api/v1/models/ownership-diagnostics?model_id=model_abc123" \
  | python3 -m json.tool
```

Fields:

| Field | Meaning |
|---|---|
| `caller_user_id` | the UUID the backend resolved from the Supabase token |
| `models_owner_id_column_type` | live SQL type of `models.owner_id` (`uuid` or `text`) |
| `models_owned_by_caller` / `owned_model_ids` | models the API considers yours |
| `model.owner_matches_caller` / `model.verdict` | `owner` or `different_account` |
| `model.stored_owner_python_type` | `UUID` (uuid column) or `str` (text column) |
| `model.stored_owner_fingerprint` / `model.caller_fingerprint` | SHA-256 prefixes you can compare with the operator view |

Add the deployment's `WORKER_AUTH_SECRET` as `X-Debug-Secret` to reveal the raw
stored owner id (operator-only; it is never exposed to a normal caller who does
not own the row):

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Debug-Secret: $WORKER_AUTH_SECRET" \
  "https://corpus-ultimate-api.onrender.com/api/v1/models/ownership-diagnostics?model_id=model_abc123"
```

The same values are in the API runtime log at `WARNING` level, e.g.
`Denied delete_model for model=... stored owner=... caller=...`.

If `verdict` is `different_account`, the row genuinely belongs to another
account. **Do not reassign ownership automatically**; compare
`stored_owner_id` with the ids in Supabase → Authentication → Users to decide
what happened (a second sign-up, an anonymous session, or a row created before
auth was wired).

---

## 5. Build and runtime logs

* Render Dashboard → service → **Logs** (runtime) and **Events → deploy → Logs**
  (build).
* Backend build failures are usually a mistyped environment variable
  (the app refuses to boot with an empty `SECRET_KEY` or `WORKER_AUTH_SECRET`)
  or a `DATABASE_URL` without the `postgresql://` scheme (it is rewritten to
  `postgresql+asyncpg://` automatically).
* Runtime errors show up as `ERROR` lines from the `corpus` / `corpus.models`
  loggers. `Not authorized` denials are logged with both ids.

---

## 6. Database migration for existing projects

`models.owner_id` was created as `text` by the original schema. That makes the
legitimate owner fail ownership comparisons. Apply the normalization migration
once in the Supabase SQL editor:

```
supabase/migrations/004_normalize_models_owner_id.sql
```

It converts `public.models.owner_id` to `uuid` in place (preserving values),
recreates the `auth.users` foreign key, is idempotent, and refuses to run if any
row has a non-UUID `owner_id` (it never reassigns ownership).

Verify:

```sql
select data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'models' and column_name = 'owner_id';
-- expected: uuid
```

---

## 7. Android Chrome file-picker check (real device, not jsdom)

jsdom tests only prove the CSS/DOM contract. The picker must be tapped on a real
phone:

1. Open the deployed frontend in **Android Chrome** (not a WebView, not a
   desktop emulation).
2. Sign in → **Datasets** → **Upload dataset**.
3. Tap the middle of the drop zone (the icon/text area) → the native **Files**
   picker must open. Cancel, then tap again → it must open again (repeat 3×).
4. Tap each part of the zone in turn — the icon, the "Drop files here, or tap to
   browse" text, the format/size line, the "Tap to choose files" pill, and the
   empty gap between them. Every tap must open the picker, and **exactly one**
   dialog each time (the zone is a plain container plus a transparent overlay
   input, so there is no label/JS double activation).
4b. Hard-refresh (Chrome ⋮ → Reload) and repeat: local assets are requested as
   `css/…?v=<buildId>`, so the old stylesheet must not be reused. In DevTools
   remote debugging the network panel must show `?v=2026-11-17.1`.
5. Select one `.txt` file → it appears once in the upload queue → **Upload** →
   progress reaches 100% and the dataset shows `uploaded`.
6. Select a `.pdf` file → same flow.
7. Select two or more files at once (long-press / multi-select in Files) → all
   files appear in the queue and each gets its own dataset record.
8. Rotate to landscape and repeat step 3.

---

## 7b. Display-scaling check (phone → desktop → TV)

Sizing is driven by the root font size (16px phone, 17px ≥1440px, 19px ≥1920px,
22px ≥2560px) and `--page-max` (1280 → 1360 → 1680 → 2080px), so the same
layout scales instead of stretching. Check, at each size, that:

1. nothing overflows horizontally (no sideways scroll, no clipped card);
2. text lines stay readable — the ultra-wide (`min-aspect-ratio: 21/9`) rule
   caps body copy with `max-width: <n>ch` and centres a `min(2100px, 78vw)`
   column;
3. stat cards add **columns** (5 at ≥1280px, 6 at ≥1920px, 8 at ≥2560px),
   they do not grow into billboards;
4. charts stay capped (`max-height: … vh`) and the chat panel is not full-width
   on a TV;
5. keyboard/remote focus draws a 3px ring (`@media (min-width: 1600px)` and
   `(hover: none)`), so DPad navigation is visible from the sofa;
6. print preview (Ctrl+P) hides the sidebar, app bar and bottom nav.

`frontend/tests/responsive-layout.test.mjs` pins all of the above to the
stylesheet; it runs in `npm test`.

`GET https://corpus-ultimate-web.onrender.com/version.json` must already show
`buildId 2026-11-17.1` before you test — otherwise you are testing the old CSS.

---

## 8. Test commands

```bash
# frontend (jsdom) + deployment-verification tooling
npm install
npm test                        # = node --test frontend/tests/*.test.mjs scripts/tests/*.test.mjs

# backend (needs a Python env with backend/requirements.txt installed)
python -m venv /tmp/venv
/tmp/venv/bin/pip install -r backend/requirements.txt   # or the subset used in CI
/tmp/venv/bin/pytest backend/tests -v
```

The backend suite starts a throw-away PostgreSQL server via `pgserver`, so it
exercises the real SQLAlchemy models, real migrations-style DDL and real
endpoints. Run it from the repository root or from `backend/` — both work.

---

## Appendix — observed live state on 2026-11-16 (UTC)

Recorded right after merging the fix into `main`
(`8e6fe661465fa45b04b1e91d61d07306d4ad2978`), by fetching the deployed
services directly:

| Check | Result | What it proves |
|---|---|---|
| `GET https://corpus-ultimate-api.onrender.com/api/v1/version` | `{"detail":"Not Found"}` | the running API does not contain the version route, i.e. it is **older than the merged commit** |
| `GET https://corpus-ultimate-web.onrender.com/version.json` | `Not Found` | the deployed static site does not contain the file from `main` |
| `GET https://corpus-ultimate-web.onrender.com/js/datasets.js` | pre-modernisation file: single `fileInput.files[0]` upload, `SUPPORTED_DATASET_FORMATS: ['txt','pdf','csv','json','jsonl']`, no upload queue, no `drop-zone-input` | the deployed frontend predates the dataset/UI work merged earlier on `main` |
| `GET https://corpus-ultimate-web.onrender.com/js/models.js` | no `deletingIds` guard, no `409`/`stop_active` handling | same conclusion for the model-delete flow |
| `GET https://api.github.com/repos/sumitsanataniirajput/Llm-corpus/deployments` | `[]` | GitHub records **no** Render deployments for this repository |
| commit statuses on `main` | `total_count: 0` | Render reports no build status back to GitHub |
| `GET https://corpus-ultimate-api.onrender.com/api/v1/health` | Render “Application loading” splash first, JSON after ~60 s | free-tier instance sleeps; first request after idle is slow (not an error) |

Interpretation: both Render services are serving builds that are **several
merges behind `main`**, and nothing on GitHub shows a deployment at all. Until
the services are pointed at `sumitsanataniirajput/Llm-corpus` → branch `main`
(with auto-deploy on) and redeployed, every fix merged into `main` — including
this one — is invisible to users.

Both also need to be re-checked after the redeploy:

```bash
curl -s https://corpus-ultimate-api.onrender.com/api/v1/version   # build_id 2026-11-17.1 + commit == main
curl -s https://corpus-ultimate-web.onrender.com/version.json     # buildId 2026-11-17.1
```
