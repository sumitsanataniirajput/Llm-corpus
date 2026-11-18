# Performance: what is measured, what the budgets are, how to check them

CORPUS ULTIMATE is judged on one feeling: **a click answers immediately and the
app never freezes**. This document records the mechanisms that keep it that way,
the numbers they were built against, and how to re-measure.

Nothing here is a guess: every figure came from `scripts/perf-probe.mjs` or from
the suites listed at the end.

---

## 1. The four things that used to freeze the UI

| Cause | What it looked like | Where it is fixed |
|---|---|---|
| Navigation awaited the page's network work and **dropped clicks while waiting** (`if (isNavigating) return`) | "I click a button and nothing happens, then it jumps two pages later" | `frontend/js/router.js` — navigation sequence numbers; the newest navigation paints, older ones are abandoned |
| Every page re-fetched every collection, and Dashboard alone made five calls | seconds of dead UI on a cold Render backend, again on every visit | `frontend/js/api.js` — short-TTL read cache + in-flight de-duplication + invalidation on writes |
| Whole collections were rendered as one giant `innerHTML` with one `addEventListener` per row and `data-aos` on every card | clicking Models with a few hundred models stalled the main thread | `frontend/js/components.js` — `renderPagedList`, `delegate`, `guard`; no per-card AOS observers |
| Every training metric event wrote a log node, the tiles and **two animated charts** | Training page unresponsive during a run | `frontend/js/training.js` — one flush per animation frame, log capped at 300 lines, chart updates without animation |

## 2. Budgets

| Interaction | Budget | Enforced by |
|---|---|---|
| Navigation (click → data on screen), local backend | < 200 ms average | `scripts/perf-probe.mjs` |
| API requests per full navigation cycle (14 pages) | ≤ 12 first cycle, ≤ 6 repeat cycle | `scripts/perf-probe.mjs` |
| Rows rendered in one frame | ≤ 40 cards | `frontend/tests/performance.test.mjs` |
| Chart updates per metric burst | ≤ 4 for 60 metrics | `frontend/tests/performance.test.mjs` |
| Collection endpoints, 300 datasets / 200 models | < 1500 ms (measured: 28 / 10 ms) | `backend/tests/test_api_performance.py` |
| Metric history payload | windowed to 200 steps (measured 75 KB → 25 KB) | `backend/tests/test_api_performance.py` |

## 3. How to re-measure

```bash
# frontend, real router + real page modules, simulated backend latency
node scripts/perf-probe.mjs                        # 120 ms latency
node scripts/perf-probe.mjs --latency=1200         # cold Render backend
node scripts/perf-probe.mjs --datasets=500 --models=300 --jobs=100 --latency=0
node scripts/perf-probe.mjs --json                 # machine readable

# in the browser (production build):
#   https://corpus-ultimate-web.onrender.com/?debug=1
#   console: CORPUS_PERF.print()
#   console: CORPUS_APP.getDiagnostics().perf
```

`CORPUS_PERF` reports first paint, DOMContentLoaded/load, time-to-interactive,
per-route navigation time, per-endpoint API latency, long tasks (> 50 ms),
failures/timeouts, heap usage and the current cache size. It records route paths
only — never headers, bodies, tokens or user data — and keeps everything in
fixed-size ring buffers.

## 4. Invariants to preserve when changing the frontend

1. **Never await page data in the router.** A page may await internally, but the
   router must be ready for the next navigation at any moment.
2. **Every request from a page is abortable** — `api.js` attaches the router's
   page signal automatically. Do not pass a signal that outlives the page.
3. **A page may not paint after it was left.** Guard late work with the
   navigation sequence (`seq !== navSeq`) or by checking that the element you
   are updating still exists.
4. **Reads are cached, writes invalidate.** Adding a new collection endpoint
   means nothing; adding a new *mutation* means nothing either — every non-GET
   clears the cache. If a page shows live state, pass `{ noCache: true }`.
5. **Render lists through `ui.renderPagedList`** and attach behaviour with
   `ui.delegate`, never one listener per row and never `data-aos` on list items.
6. **Long-running actions go through `ui.guard(element, fn)`** so a double tap
   performs one action; `ui.guard` never changes `disabled` (the page owns that).
7. **Batch live data with `requestAnimationFrame`**, cap any log/list DOM, and
   destroy charts on `dispose()`.
8. **Live charts update with `{ animate: false }`** — the entry animation is for
   first render only.

## 5. Suites

```bash
npm test                                    # 99 tests (frontend incl. performance.test.mjs)
cd backend && pytest                        # 74 tests (incl. test_api_performance.py)
```

## 6. Measured before/after

Measured on **the same merged codebase**: `main` at `4247572` versus this branch,
same machine, same fixtures, `scripts/perf-probe.mjs`. `main` had no probe, so the
same probe files were copied into a worktree of `main` to measure it.

| Scenario | `main` | this branch |
|---|---|---|
| Navigation cycle, 120 ms backend latency — average | 167 ms | **136 ms** |
| Navigation cycle, 1200 ms backend latency — average / worst | 1256 / 4871 ms | **823 / 2459 ms** |
| Training page alone, 1200 ms latency (4 sequential round trips → 2) | 4843 ms | **2459 ms** |
| API requests per cycle (14 pages) | 24 | **11–12** |
| API requests on an immediate repeat cycle | 24 | **5–6** |
| Models page, 300 models | 1112 ms | **205 ms** |
| Datasets page, 500 datasets | (part of 1112 ms worst) | **158 ms** |
| CPU time for one cycle, 500/300/100 rows | 3431 ms | **1389 ms** |
| DOM nodes after a full cycle | 4067 (19 427 with 500 datasets) | **1095** |
| Click during a pending navigation | swallowed (`#/models`) | **honoured (`#/datasets`)** |
| Leftover timers after the cycle | 0 | **0** |
| Chart updates for 60 metric events | 1 per event, animated | **≤ 4** |
| Training log DOM | unbounded | **≤ 300 lines** |
| Backend `GET /datasets/` (300 rows), `/models/` (200), `/training/` (150) | not measurable | **28 / 10 / 8 ms** |
| Metrics payload, 600-step run | 75 KB per poll | **25 KB** (newest 200) |

jsdom's parse/layout is much slower than a real browser's, so absolute
milliseconds overstate production. The request counts, the DOM sizes, the
swallowed-click result and the ratios are the load-bearing evidence. **No
Android device or real-browser measurement has been taken** — that needs the
deploy; read `CORPUS_PERF` on the deployed build.
