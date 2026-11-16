# UI/UX modernization — what changed and why

This document covers the frontend overhaul (presentation, mobile behaviour, data
honesty) and the dataset-format work that had to accompany it. Backend routes,
payloads, database schema, authentication and environment variables were not
changed for presentation reasons; the only backend additions are described in
[Dataset formats](#dataset-formats) below.

## Scope and files

```
frontend/css/variables.css     design tokens, reset, buttons, inputs, grids
frontend/css/layout.css        app bar, sidebar, page container, modals, toasts, bottom nav
frontend/css/components.css    cards, stats, lists, tables, progress, charts, accordions
frontend/css/pages.css         per-page layout (dashboard, models, training, chat, …)
frontend/css/responsive.css    breakpoints 1023 / 900 / 768 / 430 / 379, landscape, ≥1280
frontend/index.html            viewport-fit, theme-color, skip link, ARIA landmarks
frontend/js/*.js               14 page modules, router, bootstrap, components, utils, api
backend/app/services/text_extraction.py   per-format dataset text extraction
backend/tests/test_text_extraction.py     extraction unit tests
frontend/tests/*.test.mjs                 jsdom behaviour tests (26 total)
```

The existing identity is preserved: dark charcoal surfaces, purple/indigo accent,
the CORPUS ULTIMATE wordmark, flat cards with subtle borders and low-elevation
shadows. No glassmorphism, no heavy blobs, no new libraries — AOS, Chart.js, Font
Awesome and SweetAlert2 are the ones already loaded by `index.html`.

## Design tokens

`variables.css` keeps the original `--md-sys-color-*` and `--color-*` names and
adds spacing/radius/elevation/typography scales (`--space-*`, `--radius-*`,
`--elevation-*`, `--text-*`). Every component in the other four files consumes
those tokens, so a theme change is a one-file edit.

## Mobile layout (root cause and fix)

**Reported bug:** text overlapped inside selects and text fields on Android.

**Root cause:** labels were absolutely positioned at `top: 50%` inside
`.input-field` and only "floated" out of the way on `:focus` or
`:not(:placeholder-shown)`. Selects have no placeholder, so the
`select:not([value=""]) + label` rule matched immediately and the label sat on
top of the value. There were no `select` rules at all, so selects also fell back
to the platform chrome and 16px intrinsic height.

**Fix, in `variables.css`:**

- `.input-field` is now `display: flex; flex-direction: column`, and
  `.input-field > label` gets `order: -1`. Labels are always above the control
  regardless of DOM order, and nothing is absolutely positioned — overlap is
  impossible.
- One explicit rule sizes `input`, `select` and `textarea`: `width: 100%`,
  `min-height: 2.75rem`, `appearance: none`, 16px font (prevents Android/iOS
  zoom-on-focus), `min-width: 0`.
- `.input-field select` reserves `padding-right: 2.4rem` for a CSS chevron
  (`background-image` SVG), so the selected value is always visible and never
  clipped.
- Long text: `.model-info h3`, `.dataset-title`, chat bubbles and list rows use
  `overflow-wrap: anywhere` / `text-overflow: ellipsis`, and grid tracks use
  `minmax(0, 1fr)` so no card can push the page wider than the viewport.
- `body { overflow-x: hidden }` is the last line of defence, not the mechanism.

**Chrome:**

- `index.html` viewport is `width=device-width, initial-scale=1, viewport-fit=cover`
  with `interactive-widget=resizes-content` so the Android keyboard resizes the
  layout instead of covering the composer.
- `--safe-bottom: env(safe-area-inset-bottom, 0px)`; `.bottom-nav` pads by it and
  `.main-content` reserves `calc(var(--bottom-nav-height) + var(--safe-bottom))`,
  so page content never hides under the nav or the gesture bar.
- The sidebar drawer only closes/appears below 1024px; on desktop `.sidebar.hidden`
  is overridden back to visible (the app bar that could reopen it is hidden there).

**Breakpoints verified structurally** (rules present and exercised by tests):
379 (small phones), 429, 430–768 (large phones/small tablets), 768, 900, 1023,
≥1024 desktop, ≥1280 wide, plus landscape ≤520px height and `hover: none`.

## Data honesty

The UI never prints a statistic it did not receive:

- Dashboard stat cards render `—` (and an explanation) when a request fails;
  `dashboard.test.mjs` forces a network failure and asserts no digits appear.
- Parameter counts are computed from a model's stored config (vocabulary ×
  embedding + attention/MLP blocks) and labelled "computed"; when the config is
  missing the card says so instead of inventing a number.
- Training monitor shows progress, loss and tokens/sec only from websocket
  events/`/metrics`; otherwise it shows an empty state.
- `ai-information` describes model capabilities as reported by the API and lists
  what it cannot report (trainable/non-trainable parameter split, benchmark
  scores, accuracy) as unknown.
- Chat performs real inference through `/api/v1/inference/{model_id}` and shows
  the backend error when it fails — the old placeholder reply is gone.
- Settings only shows API keys the backend returns; when the endpoint is absent
  it says "This backend does not expose API keys yet."

## Dataset formats

Training used to read uploaded bytes as UTF-8 regardless of the extension, so a
PDF "trained" on binary noise. Upload now validates the extension, and both the
preview and the training worker run the same extractor
(`backend/app/services/text_extraction.py`):

| Extension | Extraction |
| --- | --- |
| `.txt`, `.text`, `.md`, `.markdown` | UTF-8 (BOM-tolerant) |
| `.csv` | UTF-8 |
| `.json` | UTF-8 |
| `.jsonl`, `.ndjson` | UTF-8 |
| `.pdf` | text layer via `pypdf`, page by page |

Rejections are explicit 400s with a reason:

- unknown extension → "Unsupported dataset format …"
- invalid UTF-8 or NUL bytes → "… it may be a binary file …"
- PDF with no text layer (scanned image) → no OCR available, upload text instead
- empty extraction → "contains no extractable text"

`pypdf==4.0.1` is pinned in `backend/requirements.txt`.

### Upload UX

The Dataset Manager accepts several files at once and uploads **every** one:

1. each file is validated (extension, size ≤ `CORPUS_CONFIG.MAX_FILE_SIZE`,
   non-empty) and queued with its size;
2. per file, a dataset record is created (`POST /api/v1/datasets`) using the
   entered name, or the file name when several files are selected;
3. the file is streamed to `POST /api/v1/datasets/{id}/upload` through
   `XMLHttpRequest` so the progress bar reflects real `upload.onprogress`
   events;
4. success/failure is shown per row and the library refreshes.

A single file requires an explicit dataset name; unsupported files are rejected
before any request is made. The Supabase Storage path and DB metadata flow are
unchanged.

## Page notes

- **Dashboard** — five stat cards (models, datasets, completed jobs, active jobs,
  checkpoints), recent activity from jobs + datasets, model overview, training
  activity chart, quick actions, backend connectivity card.
- **Models** — cards with id, architecture, status, context length, vocab size,
  layer/head counts, computed parameter count, timestamps and actions; create
  form grouped into identity/architecture/training sections with inline
  validation and helper text.
- **Training Center** — sections A–E: model & dataset, configuration (engine,
  compute, batch, lr, epochs, accumulation, clipping, seed, advanced collapsible),
  resource estimate (explicitly labelled estimates), controls with loading and
  duplicate-submit guards, live monitor with honest empty states.
- **Datasets** — drag-and-drop + file button, name, format help, progress,
  cards (file name, size, date, status, tokens when known), preview modal
  (real extracted text), use-for-training, delete with confirmation, search,
  empty state.
- **Chat** — conversation list, distinct user/assistant bubbles, markdown-ish
  code blocks with copy buttons, copy-message action, streaming-state send
  button, mobile-friendly composer.
- **Settings** — readable theme persistence (`corpus_theme` in localStorage,
  restored in `app-bootstrap.js`), backend health check, JSON export of
  models/datasets/jobs, API key management when supported, honest
  "unavailable" states.
- **Compute / Experiments / Evaluation / Storage / Statistics** — real data or
  empty states; every button either performs an API call or explains why it
  cannot.

## Animations and accessibility

- AOS initialised once with `once: true`, 420ms, disabled when
  `prefers-reduced-motion: reduce`.
- CSS transitions on cards, buttons, sidebar, accordions, chart containers and
  toasts; `@keyframes` guarded by reduced-motion blocks in `variables.css` and
  `responsive.css`.
- Visible `:focus-visible` rings, skip link, `aria-current="page"` on nav links,
  `aria-live` regions for toasts/progress, labelled form controls, `aria-label`
  on icon-only buttons.

## Tests run

```bash
cd backend && pytest -q          # 45 passed
npm install && npm run test:frontend   # 26 passed
```

Frontend suites: `training-dataset-selector.test.mjs` (11),
`dashboard.test.mjs` (4), `dataset-upload.test.mjs` (5),
`mobile-layout.test.mjs` (6). They run the real modules in jsdom against stubbed
fetch/WebSocket/XHR and assert both rendering and the requests sent.

A manual smoke script (not committed) rendered all 14 routes in jsdom with
stubbed API responses: every route rendered non-empty content and issued its
expected API calls.

## Known limitations

- Visual verification is structural: jsdom cannot measure layout, so pixel-level
  checks at 360/390/430/768 were done by reviewing the CSS contract, not by
  automated screenshots (no headless browser in the build environment).
- The backend has no `/api/v1/settings` or API-key endpoints, so those sections
  report "not available" rather than pretending to save.
- Account deletion is not implemented server-side; the button is disabled with an
  explanation.
- PDF extraction reads the text layer only; scanned documents need OCR, which is
  not included.
- `/api/v1/inference/{id}` quality depends on the trained checkpoint — a model
  with little training returns poor text, and the UI does not mask that.
