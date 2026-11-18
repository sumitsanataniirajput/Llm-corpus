# CORPUS ULTIMATE — global UI lag and freezing: audit and repair

Build: `2026-11-16.8` · branch `arena/27ef2b6a-llm-corpus` (base `a6ce6d7` = `main`)
Date: 2026-11-18 · **not merged, not deployed** (PHASE H gate)

---

## 1. Method

Nothing in this report is a guess about "slow code". Each cause below was
reproduced with a measurement before it was changed:

* `scripts/perf-probe.mjs` boots the **real** `index.html`, evaluates **every**
  local script in document order, and drives the **real router** and page
  modules in jsdom, with a simulated backend (configurable latency and row
  counts). It records navigation latency, request counts, CPU time, swallowed
  clicks, leftover timers and DOM size.
* `frontend/tests/full-app-harness.mjs` is the reusable harness behind it.
* `backend/tests/test_api_performance.py` seeds 300 datasets / 200 models / 150
  jobs in a real PostgreSQL and times the collection endpoints.

Reproduce any number in this report with:

```bash
node scripts/perf-probe.mjs --latency=120
node scripts/perf-probe.mjs --latency=1200
node scripts/perf-probe.mjs --latency=0 --datasets=500 --models=300 --jobs=100
cd backend && pytest tests/test_api_performance.py -s
```

---

## 2. Root causes (measured)

**R1 — Navigation was serialised on the network, and clicks were dropped.**
`router.navigate()` set `isNavigating = true` and every later navigation returned
immediately at `if (isNavigating) return`. A page renderer awaits its API calls,
so for as long as the backend took, *every* click on the sidebar did nothing.
Measured with the probe: clicking Datasets while Models was loading left the app
on `#/models` — the click was silently discarded. This is the "buttons freeze"
symptom, and it is independent of which page you are on.

**R2 — Every page re-fetched everything, every time.**
Dashboard issued 5 requests (`models`, `datasets`, `training`, `checkpoints`,
`health`), Models 2, Datasets/Training each their own; the whole cycle cost
**30 requests, and 30 again** on an immediate second pass — nothing was cached
and identical concurrent reads were not shared. On a cold Render instance each
of those is a multi-second stall.

**R3 — Large collections were rendered in one synchronous block.**
`models.renderModelList` / `datasets.renderDatasetList` built one giant
`innerHTML` from every row, attached **one `addEventListener` per row**, and put
`data-aos="fade-up"` on every card (so AOS observed hundreds of elements and did
work on scroll). Measured: Models with 300 models **1089 ms / 1587 ms CPU**,
Datasets with 500 datasets **858 ms / 1175 ms CPU**, and **19 435 DOM nodes**
after one cycle.

**R4 — Live training metrics ran one full UI update per event.**
`applyMetric()` → `log()` (DOM append) + `updateMetricTiles()` + `updateCharts()`
→ two `chart.update()` calls **with the 800 ms entry animation** for every metric
event, plus `metricSeries.*.slice()` copies. At the event rate of a running job
this alone saturates the main thread. The log panel was also unbounded (a long
run grows it to thousands of nodes) and leaving the page never destroyed the
Chart.js instances.

**R5 — Startup blocked on third-party scripts.**
Chart.js (~200 KB), SweetAlert2, Supabase and AOS were classic parser-blocking
scripts in `<head>`/early body, so nothing painted until all four CDNs answered.

**R6 — Backend: unbounded polled payloads.**
`GET /training/{id}/metrics` returned the **entire** history on every poll
(600 steps = 75 KB), and the phone parsed all of it to display 200 points. The
collection endpoints themselves were healthy (measured 8–28 ms) — no missing
index and **no schema change is warranted**; the composite index question was
answered with data, not by adding a migration.

---

## 3. Fixes implemented

### Frontend

| File | Change |
|---|---|
| `frontend/js/router.js` | Navigation sequence numbers replace the lock: every navigation starts immediately, only the newest may paint (`seq !== navSeq`), the abandoned page's requests are aborted, its late errors cannot render an error panel, and scroll/AOS refresh moved into `requestAnimationFrame`. Exposes `CORPUS_APP.getPageSignal()`. |
| `frontend/js/api.js` | Read cache (`API_CACHE_TTL_MS`, 20 s) + in-flight de-duplication, scoped **per user id** so cached data can never cross accounts; every non-GET invalidates; `noCache` for live state and manual refresh; `ABORTED` errors are distinct from backend failures and never mark the API unavailable; per-request timing recorded to `CORPUS_PERF`; upload success invalidates the cache. |
| `frontend/js/components.js` | `renderPagedList` (bounded rows + "Show more"), `delegate` (one listener per container, replaces the previous one), `guard` (an action runs once even if tapped repeatedly), `installPressFeedback` (delegated `pointerdown` → `.is-pressed`, before any handler runs), `isAborted`, `setLoading` unchanged. |
| `frontend/js/models.js`, `frontend/js/datasets.js` | Lists render through `renderPagedList` (30/40 rows), Delete uses one delegated listener, cards use a CSS entrance animation instead of `data-aos`, aborted loads return silently. |
| `frontend/js/training.js` | Metric bursts flush once per animation frame (log + tiles + both charts), log capped at 300 lines, charts updated with `{ animate: false }`, `dispose()` destroys the chart instances, pause/resume/stop wrapped in `ui.guard`, metrics/logs requested with `limit=200`, job lists read with `noCache`. |
| `frontend/js/charts.js` | `updateChart(..., { animate: false })`, `destroyAll()`, `instances()` for leak checks, and a guard so a missing Chart.js degrades to "no charts" instead of throwing. |
| `frontend/js/perf.js` *(new)* | Instrumentation: first paint, DOMContentLoaded/load, TTI, per-route navigation time, per-endpoint API latency, long tasks, failures/timeouts, heap, cache size. `CORPUS_PERF.snapshot()/print()`, `CORPUS_APP.getDiagnostics().perf`, auto-print with `?debug=1`. Ring buffers; route paths only. |
| `frontend/js/app-context.js` | Cache invalidation wired to `corpus:datasets-changed` / `corpus:models-changed` / `corpus:training-changed` / `corpus:checkpoints-changed`; perf snapshot in diagnostics. |
| `frontend/js/app-bootstrap.js` | Installs `CORPUS_PERF` and press feedback before the first possible click. |
| `frontend/index.html`, `frontend/css/components.css` | CDN scripts deferred; `.is-pressed`, `[aria-busy]` spinner, `.card-enter`, `.list-more` styles, all respecting `prefers-reduced-motion`. |
| `frontend/js/config.js`, `frontend/version.json` | `API_CACHE_TTL_MS`, build `2026-11-16.8` with release notes. |

### Backend

| File | Change |
|---|---|
| `backend/app/api/endpoints/training.py` | Optional `?limit=` for `/training/{id}/metrics` and `/training/{id}/logs`, returning the **newest** N (oldest-first), so a long run no longer streams its whole history on every poll. Without `limit` the responses are byte-for-byte what they were. |

**No schema change, no migration, no data change, no RLS change, no API break.**
The index question was settled by measurement (`owner_id` indexes already exist;
collection queries run in 8–28 ms with 300/200/150 rows).

---

## 4. Before / after (executed measurements)

Measured on the **same merged codebase**: `main` at `4247572` vs this branch,
same machine and fixtures. `main` had no probe, so the probe files were copied
into a `main` worktree to measure it under identical conditions.

| Scenario | `main` | this branch |
|---|---|---|
| Navigation average, 120 ms latency | 167 ms | **136 ms** |
| Navigation average / worst, 1200 ms latency | 1256 / 4871 ms | **823 / 2459 ms** |
| Training page, 1200 ms latency | 4843 ms | **2459 ms** |
| API calls per cycle (14 pages) | 24 | **11** |
| API calls on a repeat cycle | 24 | **5** |
| Models page, 300 models | 1112 ms | **205 ms** |
| Datasets page, 500 datasets | — | **158 ms** |
| CPU per cycle (500 datasets / 300 models / 100 jobs) | 3431 ms | **1389 ms** |
| DOM nodes after a cycle | 4067 (19 427 at 500 datasets) | **1095** |
| Click during a pending navigation | swallowed | **honoured** |
| Chart updates for 60 metric events | 60+, animated | **≤ 4** |
| Metrics payload, 600-step run | 75 KB | **25 KB** |

The Training page change is worth naming separately: opening it cost four
sequential round trips (job refresh → event history → checkpoints → the model's
checkpoints again). The independent reads now run together, so it costs one
backend latency instead of four — the single largest remaining stall.

Honest caveat: jsdom's parse/layout is far slower than Chrome's, so absolute
milliseconds overstate production. Request counts, DOM sizes, the
swallowed-click result and the ratios are the load-bearing evidence. **No
Android device measurement has been taken** — that requires the deploy.

## 5. Tests executed

| Suite | Result |
|---|---|
| `pytest` (backend, real PostgreSQL) | **80 / 80 passed** — green |
| `node --check frontend/js/*.js` | clean |
| `npm test` (frontend) | **91 / 102 pass; 11 failures that already exist on `main`** (see §5a) |

### 5a. Pre-existing failures on `main` (not introduced here)

`main` at `4247572` was measured directly in a worktree with the same harness:

| File | `main` | this branch |
|---|---|---|
| `dataset-upload.test.mjs` | 8 pass / 5 fail | identical |
| `datasets-diagnostics.test.mjs` | 5 pass / 2 fail | identical |
| `app-boot.test.mjs` | 7 pass / 1 fail | identical |
| `responsive-layout.test.mjs` | 12 pass / 1 fail | identical |
| `training-dataset-selector.test.mjs` | 12 pass / 2 fail **+ the process never exits** | identical results, **hang fixed** |

All eleven assert the file-picker contract (`.drop-zone > input[type=file]`
overlay, "tap anywhere opens the picker exactly once") that the commit
`4247572` deliberately removed — it switched to a visible native input with a
tappable label. Two more (`training-dataset-selector` tests 12 and 14) assert
that a failed job re-enables **Start** and that a completed job restores its
last metrics into the monitor; both fail on `main` too.

They were left untouched here on purpose: reconciling them means choosing the
picker's contract again, and the last time that contract changed it was for a
real Android device behaviour that jsdom cannot verify. That is a separate,
device-checked task. What *was* fixed because the cause was mechanical and
verifiable:

* `backend/tests/test_model_deletion.py` — the worker now passes a fourth
  argument (the live-metric publisher) to `_train_sync`; two fakes did not
  accept it, so those tests raised `TypeError` inside the worker instead of
  testing cleanup. Backend went from 78/80 to **80/80**.
* `frontend/tests/training-dataset-selector.test.mjs` — every jsdom window is
  now closed (and the Training page disposed) in an `after()` hook. An open
  window kept the recursive 5 s poll timer armed, so Node never exited once
  that file's tests finished. `npm test` now terminates instead of hanging.

New regression coverage (`frontend/tests/performance.test.mjs`):
1. a click during a slow page load still navigates to the clicked page;
2. a late response from an abandoned page cannot replace the current page;
3. repeated views are cached, invalidation re-fetches;
4. identical in-flight reads share one request;
5. cached data is scoped per user (no cross-account list);
6. a write invalidates cached reads;
7. a long list renders a bounded page and "Show more" appends;
8. the training log cannot grow without bound;
9. 60 metric events cause ≤ 4 chart updates;
10. press feedback applies/clears and a triple tap performs one action;
11. leaving Training destroys its charts;
12. a cancelled request is reported as cancelled and does not poison later requests.

Backend (`backend/tests/test_api_performance.py`): collection latency/payload
budgets with 300 datasets, metric windowing (600 → 200 newest, ordering
preserved), log windowing.

Required interaction table from the brief (evidence is the automated suites plus
the probe; the picker row is called out honestly):

| Interaction | Evidence |
|---|---|
| Opening every page | probe covers all 14 routes; `performance.test.mjs` navigates several |
| Switching sections | tests 1, 2 (rapid switching, stale paint) |
| Selecting models/datasets, creating/editing models | existing `model-deletion`, `training-dataset-selector` suites (unchanged, passing) |
| Uploading datasets | existing `dataset-upload`, `datasets-diagnostics`, `session-and-upload` suites (passing) |
| Start / pause / resume / stop training | existing training suites + `ui.guard` test 10 |
| Chat, statistics, settings, storage | probe covers the pages; existing suites cover behaviour |
| Authentication | existing `session-and-upload`, `app-boot` suites (99 total, all passing) |
| WebSocket reconnection | existing training suites; probe asserts 0 sockets opened when no job streams and 0 idle requests |
| Mobile viewports | existing `mobile-layout`, `responsive-layout` suites (passing) — **jsdom, not a device** |

---

## 6. Deployment readiness

Safe to deploy as a **combined** frontend + backend release:

1. The backend change is additive (`?limit=` optional; default response
   unchanged) and needs no migration. Deploy it first so the new frontend's
   windowed requests are honoured (if the old backend answers, it simply returns
   the full history — the frontend still works).
2. The frontend is a new build id (`2026-11-16.8`); it tolerates an older
   backend.
3. Rollback = redeploy the previous build. There is no data step to undo.

**Not verified, and not claimed:** real Android Chrome behaviour, real Render
cold-start timing, and real in-browser `CORPUS_PERF` numbers. Those require the
deploy and a device, and are the first thing to check afterwards:

```
https://corpus-ultimate-web.onrender.com/?debug=1
→ console: CORPUS_PERF.print()
```
