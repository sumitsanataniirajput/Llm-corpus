# Action feedback and real-time status

Every interactive control in CORPUS ULTIMATE now goes through one global action
manager (`frontend/js/actions.js`). This document describes the contract it
enforces, what was broken before, how each page is wired, and how it is tested.

## The problem this replaces

The old pattern was `ui.setButtonLoading(btn, true)` … `try { … } catch { … }
finally { ui.setButtonLoading(btn, false) }`, repeated (or forgotten) per page.
It had five failure modes that match the symptoms reported:

| Symptom | Cause |
|---|---|
| Button stuck on "Working…" | a code path that never reached the reset (thrown before `try`, early `return`, aborted request) |
| Button label never restored | `setButtonLoading(true)` called twice: the second call overwrote `dataset.originalText` with the spinner markup, so the "original" text became "Working…" |
| A control came back *enabled* after an action | `setButtonLoading(false)` unconditionally set `disabled = false`, undoing a disabled state the page had just applied |
| Two clicks, two requests | no per-control re-entry guard; only some pages used `ui.guard` |
| No confirmation, or two of them | success toasts were not deduplicated and were sometimes emitted before the response was checked |

## States

```
idle ──► processing ──► success            (a request that finishes now)
                    └─► completed          (a tracked operation that settles)
                    └─► failed
                    └─► cancelled          (user navigated away / aborted)

background work:
idle ──► processing ──► queued ──► running ──► completed | failed | cancelled
```

`success`/`completed`/`failed`/`cancelled` are terminal: a terminal operation is
never revived by a stale event, and its notification is emitted at most once.

## API

```js
const outcome = await actions.run({
  name: 'Create model',           // human label, also used in the operation centre
  key: 'models:create',           // optional dedupe key (defaults to the control)
  element: submitButton,          // control that shows the work
  label: 'Creating…',             // text while processing
  success: 'Model created successfully!',
  failure: 'Could not create the model.',
  notifyFailure: true,            // false when the page phrases its own error
  track: true,                    // record in the operation centre
  timeoutMs: 120000,              // request timeout (races the work, aborts the signal)
  run: async (ctx) => api.createModel(config, token),
  onSuccess: async (value) => { /* update UI, refresh affected data */ },
  onFailure: (error) => { /* show inline detail */ },
});

outcome.state;      // 'success' | 'failed' | 'cancelled' | 'queued' …
outcome.ok;         // true only for success/completed
outcome.message;    // the exact text the user saw
outcome.error;      // the original error, for status-code branching
```

`actions.run` **never rejects**. A click handler can `await` it without an
unhandled rejection, and every path — including a timeout and an abort — ends by
restoring the control.

Helpers:

* `actions.refresh({ name, element, run })` — a reload control; shows the work,
  restores, no success toast (the refreshed data is the feedback).
* `actions.beginOperation / updateOperation / finishOperation` — tracked work
  with real timings, progress and result.
* `actions.syncJob(job, { name })` — reconcile a backend job; idempotent.
* `actions.notify(message, type, { key })` — deduplicated notification.
* `actions.cancel / cancelAll` — abort in-flight work (used on navigation).

## Guarantees

1. **Immediate feedback.** The control's label changes synchronously, before any
   `await`. `aria-busy="true"`, `aria-disabled="true"` and `data-busy="true"` are
   set; a capture-phase listener swallows presses on a busy control, so keyboard
   and pointer input both cannot start it twice.
2. **Exact restoration.** The manager snapshots `innerHTML`, `aria-busy` and
   `aria-disabled` before touching the control, reference-counts concurrent
   actions on it, and restores the snapshot when the last one settles. It never
   writes `disabled` — the page owns that (which is why Start Training no longer
   comes back enabled after a failed run).
3. **One execution per control.** A stable per-element key means a second press
   while the first is in flight returns the *same* promise; the work runs once.
4. **Honest outcomes.** A success notification is emitted only after
   `run()` resolved. A failure carries the backend's own message
   (`detail` / `data.detail` / `message`), never a fabricated one.
5. **One notification per outcome.** Deduplicated in `CORPUS_ACTIONS.notify`
   (1500 ms for success, 6 s for errors, keyed by action + text), so a double
   click, a duplicated WebSocket event and a polling retry cannot stack banners.
6. **Navigation-safe.** `hashchange` cancels in-flight actions: their signals
   abort, they settle as `cancelled`, and they never toast over the page the user
   opened.
7. **Timeouts are terminal.** A request that ignores its abort signal still ends
   the action (raced against a timeout), so no control spins forever.

## Long-running work

* Training: the create response, WebSocket events and the polling fallback all
  feed `syncJobOperation()`, which calls `actions.syncJob`. A job is `queued`
  when accepted, `running` while the worker streams metrics, and settles once —
  `completed` with its real final loss, `failed` with the worker's error text, or
  `cancelled`. Completion stops polling and closes the stream.
* Uploads: one operation with `creating → transferring (real tus/bytes
  percentage) → verifying and registering`, finished only after the backend has
  verified the stored object, and reported as failed if the bytes or the
  registration did not land.
* Evaluation smoke test: progress is prompts-answered / prompts-sent.

## Operation centre

A persistent panel (bottom-right, `#operation-center`) lists recent operations
with their state, start and finish times, real progress and result or error.
Records are stored in `localStorage` (`corpus:operations:v1`, last 25, no
tokens or user data) so a reload does not hide what happened. On reload, an
operation the browser owned that was still running is marked **cancelled**
("The page was reloaded before this operation finished") instead of showing a
permanent spinner. Jobs are left for the backend to reconcile, because the
worker may genuinely still be running.

## Backend: nothing stays "processing" forever

* Every dataset upload path ends in `uploaded` or `failed`, commits, and never
  reports success for a file it cannot serve.
* The training worker commits `completed` / `stopped` / `failed` plus a
  `training_job_events` row on every exit path.
* **New:** `reconcile_orphaned_jobs()` runs at API startup. A job runs inside
  the API process, so anything still `queued`/`running`/`paused` whose row has
  not been touched since this process started cannot belong to it — it is marked
  `failed` with an explanatory event. Without this, a redeploy during training
  left the row (and the monitor) saying "Running" forever.

## Page coverage

| Page | Actions wired |
|---|---|
| Models | create, clone, delete (409 → stop-and-delete confirmation, 403 → ownership diagnostics), refresh |
| Datasets | upload queue (progress + verification), file attach, preview, delete, refresh |
| Training | start (queued → tracked job), pause, resume, stop, refresh jobs |
| Settings | create API key, revoke key, export JSON, theme, backend recheck |
| Storage | download object |
| Evaluation | smoke test (real progress, real failures) |
| Prediction | run prediction |
| Chat | send message (inline pending state + confirmed reply) |
| Dashboard / Statistics / Experiments / Compute | refresh controls (busy state, no success spam) |

## Tests

`frontend/tests/actions.test.mjs` (19 tests) covers the matrix from the brief
against the real modules in jsdom:

| Scenario | Test |
|---|---|
| A successful operation | `A. success…` |
| A failed API request | `B. failed request…` |
| Network disconnected | `C. network disconnected…` |
| API timeout | `D. timeout…` |
| User navigates away mid-action | `E. navigating away…` |
| Double click | `F.` / `F2.` |
| Backend returns a queued job | `G. accepted background job…` |
| Background job completes later | `H.` + training integration test |
| Background job fails | `I.` |
| WebSocket drops during completion | `J.` |
| Button/state integrity, operation centre, cache invalidation | remaining tests |

Backend: `tests/test_worker_recovery.py` proves orphaned jobs are failed (and
that live/finished jobs are untouched).

Current results: `npm test` **110 / 121** (the 11 failures are pre-existing on
`main`, all about the removed file-picker overlay contract and two training
monitor assertions), `pytest` **83 / 83**.
