# Upgrade repair: teacher handoff, student console, provider mobile, spacing

Companion to [TRAINING_CENTER_REPAIR.md](TRAINING_CENTER_REPAIR.md) (the
`t is not iterable` crash). This document covers the remaining phases of the
same upgrade: what was broken, the exact root cause, and the repair evidence.

## Teacher Selection → Knowledge Distillation handoff

### Root cause

`teacherSelection.usePlan()` stored a plan, but the receiving side dropped most
of it:

1. `distillation.prefillFromPlan()` copied only `mode`, `generation.count` and
   `budget.max_spend_usd`. It never selected `plan.teachers`/`plan.evaluators`
   in `#kd-teachers`/`#kd-evaluator`, never synchronized chips or the payload,
   and never applied the plan's languages, subjects, difficulties, task types,
   output format, full budget or `subject_map`.
2. `teacherSelection.takePlan()` cleared `pendingPlan` when read, so async
   provider loading or a re-render could consume and lose the plan before the
   form was ready.
3. `fillTeacherSelects()` rendered exactly one option per provider (the default
   model), so a plan that referenced any non-default model could never match a
   DOM option and was silently discarded.
4. `teacherSelection.buildPayload()` set `allow_external_send: true` inside the
   plan, contradicting the rule that external-send consent must be explicit and
   per job.

### Repair

- `frontend/js/teacher-selection.js`: `buildPayload()` deduplicates
  teacher/evaluator entries, deep-copies the backend's quality/budget defaults,
  and no longer asserts consent (`allow_external_send: false`). `usePlan()`
  stores a deep copy and shows an informational toast (no premature "created"
  success). `takePlan()` returns a deep copy **without clearing**;
  `clearPlan()` (now exported) is called by Knowledge Distillation only after a
  successful prefill, and again after a job is created. `providerOption()`
  renders every enabled model ID per provider inside `<optgroup>`s so any
  selected model can be matched later.
- `frontend/js/distillation.js`: `prefillFromPlan()` takes ownership of the
  plan, waits for provider options, selects the exact teacher/evaluator entries
  in the DOM, applies mode/count/task/format/budget, and keeps the plan in
  module state so re-renders re-apply it. Plan entries are matched to real
  provider/model options by `provider_id::model_id`; an entry whose provider is
  not connected produces a selected, disabled `data-available="0"` option plus
  a blocking inline warning — it is never silently dropped. A summary block
  renders the mode, counts, languages, subjects, difficulties, budget and the
  selected teacher/evaluator chips so the payload is visible before submit.
- Validation UX: section-level error lists (`#kd-source-errors`,
  `#kd-plan-errors`, `#kd-consent-errors`) sit beside the form sections they
  belong to. Create Job stays disabled until a dataset is chosen, at least one
  available teacher is selected, mode-specific rules hold (C/D need a separate
  evaluator from a different provider, B needs two teacher providers, E needs
  subject routing), budget numbers are sane, and the external-send consent box
  is checked. The consent section explains exactly what leaves the account
  (the previewed dataset excerpt, at most 4000 characters per request) and
  which providers receive it. `createJob()` re-validates synchronously and
  makes no request when invalid, so no contradictory or premature toasts fire.
  The POST body carries the real `provider_id`/`model_id` pairs and
  `allow_external_send: true` only when the checkbox is ticked.
- Regression coverage: `frontend/tests/teacher-plan-handoff.test.mjs` (three
  end-to-end tests through the real page modules) — full plan transfer and a
  draft POST with the actual IDs; unavailable-provider blocking warning; mode
  B/C validation beside the form. `frontend/tests/teacher-network.test.mjs`
  still passes (46/46 with the related suites).

## Student Model Studio inspection console

`architectureTable()` dumped every architecture field into one unstyled table
(`.kv-list` had no CSS rules at all). The replacement `inspectionConsole()`
renders:

- overview cards (name, status when the model list provides one, architecture,
  engine, total/trainable parameters, layers, embedding dim, context window) —
  the trainable-percentage card exists only when the backend actually measured
  it (CORPUS engine); a config-only Hugging Face inspection omits it;
- grouped spec sections: Identity, Dimensions, Parameters & weights (precision,
  quantization, weight size, parameter source), Tokenizer;
- a collapsible per-tensor parameter breakdown instead of an inline dump;
- every unmeasured field renders "Not reported" — nothing is invented.

The training-methods table is now in a bounded scroll region. Regression
coverage: `frontend/tests/student-studio-console.test.mjs` (3 tests: real
values present, HF-missing values reported truthfully, empty architecture shows
no `undefined`/`NaN`/`null`).

## Provider Management mobile

The provider card embedded a five-column models table while the global table
rule enforces `min-width: 520px` — on a phone the card forced page-level
horizontal overflow. The models list is now responsive model cards (wrapping
model ID, context/max-output/price/source as a two-column key/value list), the
endpoint URL and credential fingerprint wrap (`overflow-wrap: anywhere`), the
capability chips wrap, and the action row (Test connection / Discover models /
Enable-Disable / Revoke key) wraps without clipping. Credentials remain masked:
only the `••••1234` hint and fingerprint are rendered. Regression coverage:
`frontend/tests/provider-card-mobile.test.mjs`.

## Shared spacing system

The audit found `.card-grid`, `.stats-grid` and `.kv-list` were emitted by six
page modules with **no base CSS at all** — cards touched each other and grids
collapsed. `frontend/css/components.css` now defines:

- `.card-grid` / `.card-grid.two` / `.stats-grid` responsive grids with
  consistent `--space-*` gaps;
- `.kv-list` as a proper two-column definition list with row separators;
- the `.spec-*` console styles, `.form-section-errors`, `.kd-plan-summary`,
  `.chip.chip-warning`, `.card-footer` / `.actions-row`, `.card-header`
  spacing, and the `.provider-*` / `.model-card*` mobile rules.

All rules use the existing `--space-*`, `--color-*`, `--radius-*` tokens; no
existing component rule was changed. The remaining in-card tables in
Knowledge Distillation (jobs, records, breakdown) are wrapped in the existing
`.table-scroll` bounded region, matching what `budgets.js` already did.

## Supabase

No migration was needed or applied: every change is frontend JS/CSS, the jsdom
test harness, or documentation. The backend API contracts are unchanged, so the
schema, RLS policies, storage objects and data are untouched. Inspection of the
live project was attempted through the Supabase connector; the project is
currently `INACTIVE`, so schema/RLS verification against the live database was
not possible from this environment. That is recorded here as a limitation, not
silently skipped.

## Verification evidence

- `npm ci --no-audit --no-fund`: clean.
- `npm test`: 266 passed / 275; the only 9 failures are the known stale
  file-picker overlay tests. The two former training regressions ("backend
  failure event surfaces the real error message", "restores latest completed
  job and its real metrics") now pass for real: the stale-REST-overwrites-
  terminal-status race is fixed and the test harness maps metrics fixtures.
  `scripts/check-test-baseline.mjs` was updated from 11 to 9 known failures —
  entries were removed because the underlying bugs were fixed, not hidden.
- `npm run test:ci` (migration manifest + repo hygiene + baseline gate):
  exit 0, "9 known pre-existing failures, no new failures".
- Backend: `pytest -q` 184 passed; `pytest corpus_engine/tests -q` 15 passed.
- `node --check` over every `frontend/js/*.js`, `frontend/tests/*.mjs`,
  `scripts/*.mjs`, `scripts/tests/*.mjs`: clean.
- Targeted training slice (training-*, charts, performance, route-render,
  training-center-repair): 65/65.
