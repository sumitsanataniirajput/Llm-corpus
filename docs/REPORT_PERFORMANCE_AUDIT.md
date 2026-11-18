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

Same machine, same fixtures, jsdom + real PostgreSQL.

| Scenario | Before | After |
|---|---|---|
| Navigation cycle, 120 ms latency — average | 155 ms | **103 ms** |
| Navigation cycle, 120 ms latency — worst page | 420 ms | **254 ms** |
| Navigation cycle, 1200 ms latency — average | 1170 ms | **728 ms** |
| API requests per cycle (14 pages) | 30 | **9** |
| API requests on an immediate repeat cycle | 30 | **4** |
| Models page, 300 models | 1089 ms / 1587 ms CPU | **178 ms / 285 ms CPU** |
| Datasets page, 500 datasets | 858 ms / 1175 ms CPU | **104 ms / 186 ms CPU** |
| DOM nodes after a full cycle | 19 435 | **1 094** |
| Click during a pending navigation | swallowed (route stays on the first page) | **lands on the clicked page** |
| Leftover timers after a full cycle | 3 | **0** |
| Chart updates for 60 metric events | 120 (2 per event, animated) | **≤ 4** |
| Training log DOM | unbounded | **≤ 300 lines** |
| `GET /datasets/` with 300 rows | not previously measurable | **28 ms** |
| `GET /models/` 200 · `GET /training/` 150 | not previously measurable | **10 ms · 8 ms** |
| Metrics payload, 600-step run | 75 KB per poll | **25 KB** (newest 200) |

Honest caveat: jsdom's layout/parse is far slower than Chrome's, so absolute
milliseconds overstate production. The request counts, the DOM sizes, the
swallowed-click result and the ratios are the load-bearing evidence. **No
Android device measurement has been taken** — that requires the deploy.

---

## 5. Tests executed

| Suite | Result |
|---|---|
| `npm test` (frontend, jsdom + scripts) | **99 / 99 passed** (was 87; +12 new performance regressions) |
| `pytest` (backend, real PostgreSQL) | **74 / 74 passed** (was 71; +3 measured performance tests) |
| `node --check frontend/js/*.js` | clean |

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

Required interaction table from the brief, against the automated evidence:

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
