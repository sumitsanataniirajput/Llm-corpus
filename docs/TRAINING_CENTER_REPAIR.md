# Training Center crash: reproduction, root cause and repair

## Exact production symptom

The Training Center route rendered the router error panel:

```text
Page failed to load
Route: training
t is not iterable
```

The browser bundle loads Chart.js 4.4.0 from CDN as a deferred script. The
existing full-app jsdom harness replaced `window.Chart` with a trivial class, so
it could not reproduce the minified UMD failure. A dedicated reproduction used
`chart.js@4.4.0`'s real `dist/chart.umd.js`, a real 2D canvas renderer bridged
into jsdom, and the app's actual `frontend/js/*.js` files. It captured the exact
exception before making any source change:

```text
TypeError: t is not iterable
    at Je (chart.umd.js:13:22999)
    at eval (chart.umd.js:13:21511)
    at eval (chart.umd.js:13:21541)
    at eval (chart.umd.js:13:21893)
    at qe (chart.umd.js:13:22618)
    at Object.get (chart.umd.js:13:21187)
    at Xe (chart.umd.js:13:22512)
    at eval (chart.umd.js:13:21853)
    at eval (chart.umd.js:13:21893)
    at qe (chart.umd.js:13:22618)
    at Object.get (chart.umd.js:13:21187)
    at setScaleRange (frontend/js/charts.js:272:29)
    at applyView (frontend/js/charts.js:338:5)
    at Object.updateChart (frontend/js/charts.js:539:7)
    at updateCharts (frontend/js/training.js:1660:19)
    at renderCharts (frontend/js/training.js:1649:5)
    at Object.render (frontend/js/training.js:325:5)
    at renderModulePage (frontend/js/router.js:677:20)
    at renderPage (frontend/js/router.js:697:12)
    at Object.navigate (frontend/js/router.js:495:24)
```

Mapping the UMD positions through Chart.js 4.4.0's source map identifies the
first frame exactly:

| UMD position | Chart.js source | Code |
| --- | --- | --- |
| `13:22999` (`Je`) | `src/helpers/helpers.config.ts:343:24` (`parentScopes`) | `const allScopes = [...parentScopes, ...rootScopes];` |
| `13:21511` | `src/helpers/helpers.config.ts:270:12` (`createSubResolver`) | `value = createSubResolver(_proxy._scopes, _proxy, prop, value);` |
| `13:21541` | `src/helpers/helpers.config.ts:243:31` | `_resolveScriptable(prop, value, target, receiver);` |
| `13:21187` / `13:22618` | `src/helpers/helpers.config.ts:151:13` / `227:16` | resolver `get` / `_cached` |
| `13:22512` / `13:21853` | `src/helpers/helpers.config.ts:216:50` / `248:6` | `needsSubResolver` checks |

## Root cause

`window.training.render()` called `renderCharts()` before awaiting the Training
Center's three list reads. `renderCharts()` created the two empty line charts
and immediately called `updateCharts()`. For an empty series,
`frontend/js/charts.js` `setScaleRange()` executed:

```js
delete options.scales.x.min;
delete options.scales.x.max;
```

At that point `options` was `inst.options`: Chart.js 4's **live resolver
Proxy**, not the plain user config object. Deleting `min` through that Proxy
entered Chart.js's resolver cache/delete path, which created a sub-resolver
from a non-iterable scope. The spread `[...parentScopes, ...rootScopes]` in
`helpers.config.ts:343` then threw `TypeError: t is not iterable`. The router
caught the rejection and replaced the whole Training Center with the error
panel. This was not a backend payload bug, and no variable was randomly
renamed to hide it.

Chart.js keeps the editable plain object at `chart.config.options`; it rebuilds
`chart.options` as a resolver Proxy on every `update()`. The repair therefore:

- edits only `chart.config.options` (or a plain test-double options object),
  never the live `chart.options` Proxy;
- replaces config options with a fresh plain object on updates and clears
  Chart.js's resolver cache;
- guards `setScaleRange()` so Chart.js resolver proxies are never mutated;
- catches missing Chart.js, missing canvas contexts, constructor failures,
  update failures and destroy failures as optional-chart diagnostics;
- makes `createLineChart`, `updateChart`, `renderCharts`, `dispose()` and
  `destroyChart()` idempotent;
- normalizes bar/doughnut/probability labels, datasets and probabilities before
  passing them to Chart.js.

## API normalization and stale-request audit

The following Training Center paths were audited: `dispose()`,
`renderCharts()`, `updateCharts()`, `loadModels()`, `refreshDatasets()`,
`loadJobs()`/`loadJobsData()`, `refreshJob()`, `loadCheckpoints()`,
`applyMetric()`, `applyProgress()`, `applyStatus()`, `startPolling()`,
`connectJobStream()`, and the job/control action callbacks.

- Bare arrays and keyed envelopes (`models`, `datasets`, `jobs`, `items`,
  `data`, `results`) are accepted; strings, numbers, `null` and object-shaped
  non-arrays normalize to `[]` without iteration.
- Logs, metrics and checkpoints accept bare arrays or `events`, `logs`,
  `metrics`, `checkpoints`, `items`, `data` and `results` envelopes. Malformed
  values cannot reach `.forEach()`, `.map()`, `.slice()` or `.sort()`.
- `state.setModels`, `state.setDatasets` and `state.setTrainingJobs` also reject
  non-array assignments, so a malformed response cannot poison later pages.
- Every mounted Training Center gets a generation token. Router disposal
  advances that token; in-flight list reads, polling, WebSocket frames, metric
  flushes and action callbacks check the token before writing state or DOM.
  This makes repeated open → leave → reopen safe.
- Jobs, checkpoints, metrics and progress are still read from the same backend
  endpoints; the guards only discard writes from stale visits.

## Regression evidence

`frontend/tests/training-center-repair.test.mjs` uses the real Chart.js 4.4.0
UMD bundle plus a real canvas renderer for the crash cases. It covers:

1. first load with empty-label chart updates and no `t is not iterable`;
2. three open → leave → reopen cycles with no leaked Training chart instances;
3. repeated `renderCharts()` and `dispose()` calls;
4. missing Chart.js and a throwing Chart.js constructor, with controls intact;
5. empty, populated and malformed model/dataset/job/list shapes;
6. active and completed jobs with progress and malformed event envelopes;
7. a delayed stale list response that cannot overwrite a newly opened page.

`frontend/tests/chartjs-canvas.mjs` contains the test-only canvas bridge. The
production app still loads Chart.js from CDN; no app runtime dependency was
added. `chart.js` and `@napi-rs/canvas` are pinned dev dependencies used only
by jsdom regression tests.
