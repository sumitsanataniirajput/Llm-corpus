# Critical dataset upload & authentication repair — engineering report

Build: `2026-11-16.7` (frontend) · branch `arena/5959197e-llm-corpus` (base `fae0531`)
Date: 2026-11-17 · Status: **implemented and tested, not committed/deployed — awaiting PHASE H approval**

---

## 1. Exact root causes (code, not guesses)

### 1.1 "I get logged out after uploading / reloading"

`frontend/js/api.js`, the 401 branch of `request()`:

```js
try {
  const { data } = await CORPUS_SUPABASE.getSession();   // ← inside this try
  ...
  throw new Error('Backend authentication failed ... misconfigured');  // ← thrown here
} catch (err) {
  state.clearUser();                                     // ← its own catch ran
  throw new Error('Session expired. Please sign in again.');
}
```

The "backend misconfigured" error was thrown **inside** the `try` whose `catch` was written to
handle "Supabase session unavailable". So every backend 401 took the *catch* path:
`state.clearUser()` + "Session expired". Any valid Supabase session was destroyed by a
single 401 from the API — an expired access token, a cold Render backend, or an API whose
`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` does not match the project the frontend signs into.
That is why the symptom appeared "after upload": a 100 MB upload takes minutes, the access
token expires mid-flight, the next request 401s, and the user is signed out.

### 1.2 "After reloading (or after upload) it throws me to the Dashboard"

`frontend/js/auth.js`:

```js
CORPUS_SUPABASE.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN') { ...; router.navigate('dashboard'); }
```

supabase-js emits `SIGNED_IN` not only for a real login but also when it **restores or
refreshes** a stored session: page reload, token refresh, and returning from Android's system
file picker (which recreates the web process). Every one of those events navigated to
`dashboard`, so the page the user was on — typically Datasets, mid-upload — was replaced.

### 1.3 "The upload does not complete"

`uploadDatasetFile` / `uploadDatasetFileWithProgress` used `XMLHttpRequest` with **no
`timeout`**, **no token refresh**, and a single generic `'Upload failed'`. On a mobile network
this meant: token expires at minute 2 → 401 → the (bug in 1.1) wipes the session → the queue
is lost; or the connection stalls → the XHR waits forever with a frozen progress bar; or the
transfer is interrupted → the user gets one opaque sentence and re-selects the file, creating
a duplicate dataset record.

### 1.4 Backend: the upload blocked the whole API

`backend/app/api/endpoints/datasets.py` and `backend/app/services/training_worker.py` called the
**synchronous** Supabase SDK directly inside `async` functions
(`storage.from_(bucket).upload(...)`, `.download(...)`). The event loop was blocked for the
duration of the transfer, so while one upload ran, `/api/v1/health`, token resolution,
dataset listing and every other request stalled — and the frontend turned those stalls into
"backend unavailable" and 401s (see 1.1). This is the reason a *single* upload made the whole
app look broken, and why the failure was not reproducible with small files.

### 1.5 Backend: an orphan could be left in private storage

If the bytes reached Storage but the `dataset_files` insert failed, the object stayed in the
private bucket forever while the dataset had no file metadata: storage cost with no record,
and the object was unreachable from the UI.

### 1.6 Re-checked: the historical `checkpoints.owner_id` error

No live schema change was made and none is needed. The live `checkpoints` table has **no**
`owner_id`; ownership is resolved through the owning model (`models.owner_id`). Backend
checkpoint reads/writes already join through the model, and two test fixtures that still
assumed `checkpoints.owner_id` were corrected earlier. Nothing in this change touches it.

---

## 2. Files changed

| File | Change |
|---|---|
| `frontend/js/api.js` | Rewritten 401 path (`currentSupabaseToken`, `authError`, `finishResponse`); session is cleared **only** when Supabase itself has no session; idempotent requests refresh + retry once; otherwise a `backendAuthError` that keeps the user signed in. Upload block rewritten around `uploadTimeoutMs()` / `uploadUrl()` / `parseUploadFailure()` / `uploadOnce()`; both upload entry points refresh once and retry the **same dataset id**. |
| `frontend/js/auth.js` | `interactiveSignIn` flag (set only by `handleLogin`/`handleSignup`, always cleared in `finally`); `SIGNED_IN` only toasts/closes the modal/navigates to Dashboard when the sign-in was interactive, otherwise it calls `router.render()` — i.e. re-renders the current route in place. |
| `frontend/js/config.js` | `UPLOAD_TIMEOUT_MS: 600000` (documented separately from the 15 s JSON `REQUEST_TIMEOUT`); `BUILD_ID` → `2026-11-16.7`. |
| `backend/app/api/endpoints/datasets.py` | Storage upload and preview download run via `asyncio.to_thread`; a failed `dataset_files` insert rolls back, deletes the just-uploaded object and marks the dataset `failed` with a clear 500 instead of reporting success. |
| `backend/app/services/training_worker.py` | Dataset download and checkpoint/tokenizer upload moved into `asyncio.to_thread` so training I/O no longer blocks the API. |
| `frontend/index.html`, `frontend/version.json` | Build `2026-11-16.7` (meta tag, every `?v=`, release notes). |
| `frontend/tests/session-and-upload.test.mjs` | **New** — 6 tests (401 must not log out; 401 with no session does; GET 401 refresh+retry; upload 401 refresh+retry with one record; upload timeout present; failed upload keeps id and retries). |
| `frontend/tests/app-boot.test.mjs` | +2 auth-route tests (`SIGNED_IN` on reload keeps the page; `TOKEN_REFRESHED` keeps page+user) and +1 last-route restore test; Supabase stub moved *after* script evaluation (the real `supabase-client.js` was overwriting it). |
| `backend/tests/test_datasets_api.py` | +2 tests (storage transfer runs off the event loop; metadata-write failure removes the orphaned object and marks the dataset failed). |
| `docs/PRODUCTION_VERIFICATION.md` | Build references updated; new §9 regression checklist mapping the required test table to its automated coverage. |

No secrets, no service-role key, no credentials added anywhere in the frontend. `git diff` scanned for
`service_role`/`sb_secret`/`sk-`: only the existing `signIn(email, password)` form fields match.

---

## 3. Database / storage changes

**None required.** No migration, no DDL, no data update, no RLS change. Ownership rules are
unchanged (`datasets.owner_id`, `dataset_files` RLS through the owning dataset, storage objects
under `<owner-uuid>/datasets/<dataset-id>/…`). The service-role key remains backend-only.

---

## 4. Test results (executed, this working tree)

| Suite | Result |
|---|---|
| `npm test` (frontend jsdom + scripts) | **87 / 87 passed** (baseline was 78) |
| `pytest` (backend, real PostgreSQL via `pgserver`) | **71 / 71 passed** (baseline was 69) |
| `node --check frontend/js/*.js` | clean |

Required test table:

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | Login | ✅ automated | `app-boot.test.mjs` (interactive sign-in navigates once); `session-and-upload.test.mjs` |
| 2 | Upload CSV / JSON / JSONL / TXT | ✅ automated (format matrix) | `dataset-upload.test.mjs`; `backend/tests/test_datasets_api.py` (txt/md/csv/json/jsonl/pdf) |
| 3 | Reload after login | ✅ automated | `app-boot.test.mjs`, `session-and-upload.test.mjs` (session kept) |
| 4 | Reload after upload | ✅ automated (list shows file metadata, not `pending`) | `test_list_datasets_includes_latest_file_metadata` |
| 5 | Reload on dataset page restores that page | ✅ automated | `app-boot.test.mjs` last-route restore |
| 6 | Upload failure → clear error + safe retry | ✅ automated | `dataset-upload.test.mjs`, `session-and-upload.test.mjs` (no duplicate record) |
| 7 | Expired access token → refresh / clear prompt | ✅ automated | `session-and-upload.test.mjs` (401 → refresh → retry; no-session → `sessionExpired`) |
| 8 | Dataset listing | ✅ automated | `test_datasets_api.py` |
| 9 | Start training can access the dataset | ✅ automated | `test_training_worker_flow.py`, `test_full_training_flow.py` (download + checksum + extract) |
| 10 | User ownership isolation | ✅ automated | `test_datasets_api.py` (foreign user 403/404) |
| 11 | Real Android Chrome, deployed page | ❌ **not run** | requires the deploy in §6 plus a physical device |

Not verified on a real device: the Android picker + long-upload path on the deployed bundle.
Nothing in this report claims otherwise.

---

## 5. Remaining problems / honest limitations

1. **The live site is still build `2026-11-16.5`** (`GET /version.json` at 2026-11-17), i.e. two
   releases behind the repository branch. Nothing fixed here is live until Render redeploys
   `corpus-ultimate-web` **and** `corpus-ultimate-api`.
2. **Supabase project access is unavailable from this environment** (connector returns 403;
   only an inactive `Adulthood` project is visible). The bucket `corpus-storage` policy,
   the `SUPABASE_PUBLISHABLE_KEY` value on Render, and the live `dataset_files` rows could not be
   inspected. Diagnostics for a persistent 401 therefore have to be read from Render logs.
3. If the API's `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` genuinely disagree with the frontend's
   project, uploads now fail with an explicit, non-destructive error instead of a logout — but
   the environment still has to be corrected on Render.
4. Tests are jsdom + a real PostgreSQL server; they cannot reproduce a mobile radio dropping
   mid-transfer. The timeout/retry paths are covered, the radio is not.

---

## 6. Deployment safety (PHASE H gate)

Safe to deploy **only after approval**, and only in this order:

1. Deploy `corpus-ultimate-api` (backend) — additive, non-blocking I/O, no schema change.
2. Deploy `corpus-ultimate-web` (frontend, root `frontend`) — build `2026-11-16.7`.
3. Verify `GET /version.json` shows `2026-11-16.7` and `GET /api/v1/version` responds, then run
   the manual Android pass (docs/PRODUCTION_VERIFICATION.md §9).

No production data is deleted, overwritten or migrated; no RLS is disabled; no credentials are
introduced. A rollback is a Render redeploy of the previous build — there is no DB step to undo.
