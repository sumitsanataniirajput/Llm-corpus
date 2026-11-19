# Device compute, multi-device training and real progress

This document describes the device-based training upgrade that extends (and does
not replace) the existing training architecture. It records what is implemented,
what is deliberately **not** implemented, and how to verify each part.

Historical implementation notes for migrations `007`/`008`. Current status:
[STATUS_AND_LIMITATIONS.md](STATUS_AND_LIMITATIONS.md); current build identity:
`frontend/version.json` and `GET /api/v1/version`.

---

## 1. What a device actually does

| Layer | Where it runs | What is real |
| --- | --- | --- |
| Training loop (forward/backward/optimiser step) | Backend worker (`backend/app/services/training_worker.py`) | PyTorch training, real loss, real steps, checkpoints |
| Dataset preprocessing (tokenize + count a shard) | **The device**, inside a Web Worker (`frontend/js/device-worker.js`) | Character streaming from the stored file, tokens counted on the device, progress measured per chunk |
| Capability detection | The device (`frontend/js/device-agent.js`) | `navigator`/`navigator.gpu`/WebGL/battery/network values, or `Not available` |
| Coordination, leases, aggregation | Backend (`backend/app/api/endpoints/devices.py`) | Heartbeats, lease expiry, shard aggregation into `training_job_events` |

**Not implemented, and never claimed:** device-side gradient training,
distributed gradient/weight synchronisation, federated averaging, NNAPI or a
native GPU from the browser. A browser cannot see an Android NNAPI driver; the
agent only reports a native bridge if a wrapper app injects one, and the UI says
so explicitly.

### Why devices still matter without device-side training

* **Real preprocessing offload** – tokenization of large corpora runs on the
  device CPU (Web Worker), not on the backend, and the token counts are
  aggregated by the coordinator.
* **Real ownership and control** – a job is assigned to a device with a lease,
  so an operator always sees which machine is responsible for which work.
* **Real supervision** – per-device progress, heartbeat and lease state come from
  the database, so a dead phone cannot silently hold a job.

---

## 2. Execution priority

1. **WebGPU** – used for reporting, capability ranking and execution-method
   labelling when `navigator.gpu.requestAdapter()` returns an adapter. The
   preprocessing kernel itself is CPU/WASM work today.
2. **CPU via Web Worker** – the default. WASM SIMD availability is detected with
   `WebAssembly.validate()` on a real SIMD module.
3. **Backend fallback** – when Workers are unavailable or the user turns device
   processing off, the backend keeps doing everything as before.

`frontend/js/device-worker.js` is loaded with `new Worker(...)`, so tokenization
never blocks the UI thread. Chunk sizes adapt to the browser's reported memory
(`deviceMemory`, `performance.memory`), the workload cap (`low`/`medium`/`high`)
and a 200 000-character request ceiling enforced by the API.

---

## 3. Live progress contract

`training_jobs` now stores the engine's own numbers (migration `007`):
`stage`, `progress_percent`, `total_steps`, `completed_steps`, `total_epochs`,
`current_epoch`, `processed_tokens`, `last_loss`, `progress_updated_at`,
`failure_reason`, `deleted_at`.

* `progress_percent = completed_steps / total_steps * 100`, where
  `total_steps = ceil(ceil(sequences / batch_size) / gradient_accumulation) * epochs`.
  `backend/tests/test_training_progress.py::test_the_engine_reports_a_step_total_that_matches_what_it_executes`
  runs the real trainer and asserts the declared total equals the steps executed.
* Writes are cumulative (`GREATEST`), so a restart, a duplicate device report or
  an out-of-order write never rewinds the bar.
* Stages: `queued → preparing → tokenizing → loading_model → initializing →
  training → saving_checkpoints → validating → finalizing → completed`
  (plus `paused`, `failed`, `cancelled`, `interrupted`). The UI shows the stage
  label and keeps the bar **indeterminate** for phases that cannot be measured.
* Completed is always 100 %. Failed shows `failure_reason`. `interrupted`
  (worker gone at startup) says it resumes from the last saved checkpoint.
* Transport: WebSocket `progress` + `status` events; polling every 5 s is the
  fallback and also runs while the socket is opening. Both paths read the
  persisted row, so a refresh or another device shows identical numbers.
* ETA is computed only when `started_at` and a non-zero completed share exist.

The percentage is **never** presented as a measure of model intelligence; the UI
says so under the bar.

---

## 4. Deleting job history

`DELETE /api/v1/training/{job_id}`

| Case | Behaviour |
| --- | --- |
| Owner, finished job | Soft delete (`deleted_at`), row disappears from lists |
| Owner, active job | `409` with the reason "Stop it before deleting its history" |
| Another account | `403` (the API's existing ownership convention) |
| `?hard=true` | Deletes only the job's `training_job_events` + `training_metrics`, nulls `checkpoints.job_id`, deletes the job row |

Models, datasets and checkpoints are never deleted. The UI shows a confirmation
dialog first, disables the control for active jobs, and surfaces the backend's
message verbatim on failure.

---

## 5. Endpoints added

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/datasets/{id}/text?offset&limit` | Character range of the real stored text for a device shard (owner only, ≤200 000 chars, in-process LRU of ≤4 datasets / ≤8 M chars) |
| `POST` | `/api/v1/devices/` | Register a device (capabilities only — never credentials) |
| `GET` | `/api/v1/devices/` | List devices + live sweep of stale heartbeats/leases |
| `POST` | `/api/v1/devices/{id}/heartbeat` | Renew the lease, report task progress |
| `PATCH` | `/api/v1/devices/{id}` | Rename, pause (releases leases), resume |
| `POST` | `/api/v1/devices/{id}/disconnect` | Take the device offline and release its tasks |
| `DELETE` | `/api/v1/devices/{id}` | Remove the device and its task rows (history untouched) |
| `POST` | `/api/v1/devices/{id}/assign` | Assign a job (`train`) or a dataset shard (`preprocess`) |
| `POST` | `/api/v1/devices/auto-assign` | Distribute queued jobs by capability + availability |
| `POST` | `/api/v1/devices/plan/collaborative` | Shard one dataset across chosen devices |
| `POST` | `/api/v1/devices/{id}/tasks/{task}/progress` | Real task progress, renews the lease |
| `POST` | `/api/v1/devices/{id}/tasks/{task}/complete` | Finish a shard; the coordinator aggregates when all shards are in |
| `GET` | `/api/v1/devices/jobs/{job}/tasks` | Which devices worked on a job |
| `DELETE` | `/api/v1/training/{job}` | Delete job history (soft by default) |

Every device row is owner-scoped and RLS-protected (`auth.uid() = owner_id`);
another account gets `404` for devices/tasks, so membership cannot be probed.

---

## 6. Modes

**Mode A — `parallel`.** Each device is assigned a different job. Jobs keep
their own progress, metrics and checkpoints; nothing is merged or overwritten.
`auto-assign` ranks devices with a documented heuristic (`webgpu` +50, `wasm_simd`
+10, cores ≤16, memory ≤16 GB, `execution_method == webgpu` +5) and skips devices
that already hold a lease.

**Mode B — `collaborative-preprocess`.** One dataset is split into `n` shards,
each device tokenizes its own shard through `/datasets/{id}/text`, and the
coordinator records the summed, real token count once as a
`device_preprocess_complete` job event when every shard reports. The API response
and the UI both state that gradient synchronisation is not implemented. This mode
is only offered because the aggregation is real and verified.

**Leases.** Heartbeat timeout is 75 s, lease 90 s. A silent device is marked
`offline` and its tasks become `expired`, so the same job or shard can be
reassigned without double-counting (expired tasks are never aggregated). Re-planning
a collaborative run expires the previous shards and gives the new plan its own
`plan_id`, so results from two plans can never be mixed and a stale shard cannot
block the aggregate.

---

## 7. Device controls

Stored per browser (`localStorage`, key `corpus.device.settings`) and enforced by
the agent before it starts work:

`deviceProcessing`, `allowCollaborative`, `cpuFallback`, `wifiOnly`,
`preferCharging`, `pauseOnMemoryPressure`, `maxWorkload` (`low`/`medium`/`high`,
capped again by reported memory) and `gpuMode` (`auto`/`on`/`off`).

Nothing runs until the user connects the device; a refused policy reports the
reason instead of failing silently, and the tab being closed stops the heartbeat,
which releases the lease.

---

## 8. Device compatibility

Values are *read*, never assumed. Anything the platform withholds is displayed as
**Not available**.

| Signal | Chromium/Edge | Firefox | Safari (iOS/macOS) |
| --- | --- | --- | --- |
| `navigator.hardwareConcurrency` | yes | yes | yes |
| `navigator.deviceMemory` | yes | Not available | Not available |
| `performance.memory` heap | yes | Not available | Not available |
| `navigator.gpu` (WebGPU) | yes (desktop + Android) | partial | macOS/Safari 17+ |
| `WEBGL_debug_renderer_info` | yes (may be masked) | partial | partial |
| WASM SIMD | yes | yes | yes |
| `navigator.getBattery()` | yes | Not available | Not available |
| `navigator.connection` | yes | Not available | Not available |
| Android native bridge | only if a wrapper app injects one | — | — |

Warnings shown in the UI: no WebGPU (CPU workers only, slower), no Web Workers
(device compute disabled), < 2 GB reported memory (workload capped), native
bridge presence/absence and what it does and does not enable.

---

## 9. Testing (executed, not planned)

Backend (`/tmp/venv/bin/python -m pytest -p no:warnings`):

* 102 tests pass, 0 fail (83 before this branch).
* New: `backend/tests/test_training_progress.py` (7) — real engine step total,
  monotonic percent, stage events without metric rows, failed reason, soft
  delete, hard delete keeping the checkpoint, 409 for active, 403 for another
  account.
* New: `backend/tests/test_devices.py` (10) — register/heartbeat/list, lease
  expiry after a dead heartbeat, reassignment, pause/resume/disconnect, remove
  keeps history, ownership isolation, auto-assign spread, collaborative shard
  aggregation, lease renewal and late-progress rejection, and re-planning a
  collaborative run (the superseded shards expire, so the new plan aggregates).
* Extended: `backend/tests/test_datasets_api.py` — ranged text streaming
  reassembles the exact stored text; owner-only.

Frontend (`npm test`, jsdom, real modules):

* 155 tests total, 144 pass, 11 fail — the same 11 failures that predate this
  branch (datasets upload/diagnostics overlay, one datasets-route render, one
  responsive-layout selector, two training dataset-selector cases).
* New: `frontend/tests/device-compute.test.mjs` (13) — the **real**
  `device-worker.js` executed in a VM (slicing, cross-slice token accounting,
  progress, benchmark arithmetic, unknown-request error), capability detection
  marking unknown values, WebGPU-less CPU fallback, registration without any
  credential in the payload, real shard execution with per-chunk progress and a
  worker-derived token count, device-side training reported as not executed,
  policy refusal, failure reporting, and the Device Compute page.
* New: `frontend/tests/training-progress.test.mjs` (11) — panel renders backend
  steps/stage/epoch/tokens, indeterminate unmeasurable stage, completed = 100 %,
  failed reason, interrupted wording, ETA gating, WebSocket `progress` update,
  delete control gating, confirmation → API → list refresh, 409 message.
* New: `frontend/tests/multi-device.test.mjs` (10) — device cards, empty state,
  busy card with shard progress, pause/resume PATCH, remove-with-confirmation
  keeping history, assign from card, collaborative plan + honest limit text,
  per-job progress taken from the coordinator (33.3 %, not the 50 % average of
  100 %/0 %), disconnect releasing the lease, auto-assign distribution.

---

## 10. Two physical devices — manual verification

1. Device A (desktop, Chrome) and device B (phone, Chrome) sign in to the same
   CORPUS account (`https://corpus-ultimate-web.onrender.com` once this build is
   deployed).
2. On **Device Compute** (`#/device-compute`), press **Connect this device** on
   both. Expect two rows on **Multi-Device Training** (`#/multi-device`), each
   with its own reported capabilities and a heartbeat that updates every ~25 s.
3. Press **Measure speed** on each device: the token/s figure is a real timed
   measurement and differs between the two devices.
4. Start a training job on the **Training Center**. Progress now shows stage,
   `completed / total` steps, epoch, tokens and an ETA derived from the real
   start time; the bar is indeterminate during dataset preparation.
5. On Multi-Device Training choose **Collaborative preprocessing** and split
   across both devices. Each card shows its own shard and its own percentage; the
   job card shows the coordinator's percentage plus `n of m shards complete` and
   the summed token count.
6. Close the tab on device B. Within 75 s device B becomes **Offline** and its
   task `expired`; the shard can be reassigned to device A. Device A keeps its
   own work (no double processing, no lock).
7. Delete a finished job from **Recent Training Jobs** on device A. Confirm the
   dialog; the row disappears on both devices after refresh, while the model, the
   dataset and the checkpoint remain.
8. Reload device B mid-run: progress resumes from the persisted row instead of
   restarting at 0 %.

---

## 11. Known limitations

* Device-side gradient training and distributed weight/gradient synchronisation
  are not implemented; Mode B is collaborative **preprocessing** only.
* A device only works while its page is open (the heartbeat and Web Worker live in
  the tab). A closed tab is detected as offline after 75 s.
* WebGPU is detected and reported but not currently used as a compute kernel; CPU
  workers do the tokenization.
* `/datasets/{id}/text` keeps a small in-process text cache; a very large dataset
  is still downloaded once per API instance, and the hosted API runs a single
  worker process.
* Deleting a job with `?hard=true` also removes its device-task rows (FK
  cascade); the UI only performs soft deletes.
* Applying any SQL migration to a production Supabase project is a separate,
  explicitly approved operation; see
  [MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md).
