# Training dataset selection — fix and contract

## Symptom

Creating a training job produced a job with `dataset_id = null`, the worker then
raised:

```
ValueError: Select a dataset before starting training.
```

and the job row was marked `failed` after the fact.

## Root cause

Three independent problems compounded:

1. **The Training page never fetched datasets.** `frontend/js/training.js`
   rendered its `<select id="t-dataset">` from `state.getDatasets()`, which is
   only populated by the *Dataset Manager* page. Opening Training directly (a
   normal case, it is in the sidebar and the mobile bottom nav) produced an
   empty dropdown, so the form fell back to `dataset_id: datasetId || null`.
2. **The API accepted a missing dataset.** `TrainingConfig.dataset_id` was
   optional and `create_job` persisted and queued the job without validating the
   dataset, its ownership or whether a file had ever been uploaded.
3. **"Use for Training" did nothing.** `datasets.useDataset()` wrote a
   `data-selected` attribute on an element that did not exist yet, so the choice
   was silently dropped.

Additional issues found while tracing the flow: the datasets API did not expose
file metadata (`file_name`, `file_size`, `uploaded_at`), dataset records were
created with `status="ready"` before any file existed, `models.owner_id` was
compared against a raw string (UUID column), the training websocket emitted
hard-coded fake metrics, and the worker inserted checkpoints relying on a
database default that was not declared in the SQLAlchemy models.

## What changed

### Backend

| File | Change |
|---|---|
| `backend/app/api/endpoints/training.py` | `resolve_training_resources()` validates dataset id → ownership → stored file → usable status → model ownership, all **before** the job row is written. Missing dataset returns `400 {"detail": "Select a dataset before starting training."}`. `JobOut` now includes `dataset_id`. Real progress websocket (`/api/v1/training/ws/{job_id}?token=…`) streams DB status/metric/complete events instead of mock data, and rejects foreign jobs. |
| `backend/app/api/endpoints/datasets.py` | `DatasetOut` exposes `file_name`, `file_size`, `storage_path`, `uploaded_at`, `has_file`, `trainable` from the latest `dataset_files` row (scoped by owner). New records are `status="pending"`. New `GET /datasets/{id}/preview` returns real text from private storage. Delete removes stored objects. Upload sets `status="uploaded"`, real size, checksum and file extension. |
| `backend/app/services/training_worker.py` | Captures `dataset_id`/`model_id` before the session closes, refuses unusable datasets, verifies the SHA-256 checksum of the downloaded object, records a `started` event containing the dataset id, file name and storage path, and writes metrics/checkpoint only for real runs. |
| `backend/app/api/endpoints/models.py` | Ownership comparisons/creation use `uuid.UUID(...)` so listing models does not fail against a UUID column. |
| `backend/app/core/models.py` | Removed duplicated `owner_id` indexes and declared the `now()` server defaults that the Supabase migration already has (keeps `create_all` schemas identical to production). |

### Frontend

| File | Change |
|---|---|
| `frontend/js/training.js` | Loads models **and** datasets from the API on render (parallel), fills the selector with `name · file name · size · status`, disables datasets without a stored file, shows a selected-dataset summary card (file, size, uploaded date, tokens, dataset id), validates before submitting, shows an inline error + toast and never calls the API when invalid, shows recent jobs with the dataset used, consumes `state.getPendingDatasetId()`, and refreshes automatically on `corpus:datasets-changed`. Progress comes from the job websocket with a REST polling fallback; charts are fed only from returned metric rows. |
| `frontend/js/datasets.js` | Renders real file metadata and upload status, offers "Upload file" for pending records, uses the real preview endpoint (SweetAlert2 dialog), dispatches `corpus:datasets-changed` after upload/delete, and "Use for Training" now stores the pending dataset id and navigates. |
| `frontend/js/state.js` | Added `pendingDatasetId` accessors and `removeDataset()`. |
| `frontend/js/api.js` | Added `previewDataset()`, `asDatasetList()` and `connectTrainingWS()` (per-job socket with token). |
| `frontend/css/pages.css`, `frontend/css/responsive.css` | Styles for the selector summary, inline error, job rows and dataset status badges (`pending`, `uploaded`, …); single-column layout on small screens. Existing design tokens and layout are reused. |

## API contract

```
POST /api/v1/training/
{ "model_id": "model_…", "dataset_id": "ds_…", ... }

200  { "id": "job_…", "dataset_id": "ds_…", "status": "queued", ... }
400  { "detail": "Select a dataset before starting training." }
400  { "detail": "Dataset 'X' has no uploaded file yet. …" }
404  { "detail": "Dataset not found for this account. …" }
404  { "detail": "Model not found for this account. …" }
```

`GET /api/v1/datasets/` returns, per dataset:

```json
{
  "id": "ds_…", "name": "Wiki corpus", "format": "txt", "status": "uploaded",
  "file_name": "wiki.txt", "file_size": 2048,
  "uploaded_at": "2026-11-15T10:00:00+00:00",
  "has_file": true, "trainable": true, "token_count": 512
}
```

## Tests

Backend (real PostgreSQL started by `pgserver`, in-memory fake Supabase bucket):

```bash
cd backend
pip install -r requirements.txt          # or the subset below
pip install pytest pytest-asyncio pgserver asyncpg httpx python-multipart
pytest
```

* `tests/test_datasets_api.py` (8) — pending → uploaded transitions, metadata,
  re-upload, preview, cross-user isolation, delete cleanup.
* `tests/test_training_dataset_selection.py` (11) — every rejection path
  (`null`, omitted, blank, unknown, no file, other user's dataset/model) plus
  the successful path asserting `training_jobs.dataset_id` and the enqueued job.
* `tests/test_training_worker_flow.py` (4) — worker downloads the exact
  `dataset_files.storage_path`, verifies the checksum, writes metrics/checkpoint,
  and fails cleanly on missing/foreign objects or a NULL dataset.
* `tests/test_training_progress_ws.py` (3) — websocket streams real rows, closes
  on completion, rejects unauthenticated and foreign jobs.
* `tests/test_full_training_flow.py` (2) — upload → select → create job → worker
  → metrics/logs/artifacts, and the exact regression for the reported error.

Frontend (real modules in jsdom, only `fetch`/`WebSocket`/Chart.js stubbed):

```bash
npm install
npm run test:frontend
```

* 11 tests covering option labels, disabled datasets, blocked submission with no
  job request, `dataset_id` in the POST body, stale/unusable selections, backend
  errors surfaced in the UI, refresh after upload, "Use for Training"
  preselection, Dataset Manager metadata, real preview, and the socket URL.

`torch` is not required for the tests: the worker's `_train_sync` is replaced,
while every database read/write runs for real.
