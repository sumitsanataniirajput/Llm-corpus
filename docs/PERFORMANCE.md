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

## 6. Measured before/after (jsdom + Node, same machine, same fixtures)

| Scenario | Before | After |
|---|---|---|
| Navigation cycle, 120 ms backend latency (avg / worst) | 155 / 420 ms | 103 / 254 ms |
| Navigation cycle, 1200 ms backend latency (avg / worst) | 1170 / 2462 ms | 728 / 2414 ms |
| API requests per cycle (first / repeat) | 30 / 30 | 9 / 4 |
| Models page, 300 models | 1089 ms, 1587 ms CPU | 178 ms, 285 ms CPU |
| Datasets page, 500 datasets | 858 ms, 1175 ms CPU | 104 ms, 186 ms CPU |
| DOM nodes after a full cycle | 19 435 | 1 094 |
| Click during a pending navigation | swallowed (stays on the first page) | honoured (lands on the clicked page) |
| Leftover timers/intervals after the cycle | 3 / 0 | 0 / 0 |
| Backend `GET /datasets/` (300 rows) | not measured before (no harness) | 28 ms |
| Backend metrics payload (600 steps) | 75 KB every poll | 25 KB (newest 200) |

jsdom is considerably slower than a real browser at layout, so the absolute
milliseconds overstate production; the ratios and the request counts are the
meaningful part. Real-device numbers must be read from `CORPUS_PERF` on the
deployed build — until that has been done on a phone, no claim about Android is
made in this repository.
