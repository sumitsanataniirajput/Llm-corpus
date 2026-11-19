# CORPUS ULTIMATE Companion Workers — Architecture & Delivery Plan

**Status:** Architecture proposal; no worker implementation or production schema change is included in this document.
**Scope selected:** Android + Windows + Linux; preprocessing + inference + real distributed training.
**Repository:** `sumitsanataniirajput/Llm-corpus`

## 1. Existing repository facts and constraints

The current repository already has a browser-device coordinator:
- `backend/app/api/endpoints/devices.py` registers devices, heartbeats, leases tasks, assigns jobs/shards, and aggregates preprocessing completion.
- `frontend/js/device-agent.js` detects browser capabilities and `frontend/js/device-worker.js` performs preprocessing in a Web Worker.
- `docs/DEVICE_TRAINING.md` documents the current browser worker contract and existing endpoints.
- `docs/STATUS_AND_LIMITATIONS.md` explicitly states that device-side gradient training, distributed gradient/weight synchronization, federated averaging, and cloud/device gradient training are not implemented.
- The existing production training loop is an in-process PyTorch CPU worker. A Render Free API instance has a 512 MiB memory ceiling and is not a suitable place for long-running model training.
- The repository root contains an Android Gradle project, but `app/build.gradle.kts` identifies its application as `com.aistudio.aria.voice` (Aria). Do not repurpose or overwrite that app. Add a distinct `companion/android` application with its own application ID and signing configuration.
- Keep the existing Supabase project, tables, RLS, Storage objects, and user data. Do not introduce a migration until an endpoint/schema gap is proven.

## 2. Target architecture

```
CORPUS ULTIMATE Web UI (existing frontend)
          | HTTPS API / authenticated WebSocket
          v
Control plane (existing FastAPI API; keep lightweight)
  - Supabase Auth JWT validation and ownership checks
  - device enrollment, capability registration, heartbeat
  - task leasing, cancellation, result validation
  - job state and checkpoint metadata
          | task lease / signed short-lived object access
          +-------------------+--------------------+
          v                   v                    v
 Android Worker          Windows Worker         Linux Worker
 Kotlin service          Python/PyTorch         Python/PyTorch
 Native capability       CPU + supported        CPU + CUDA/ROCm/
 discovery                GPU backends           DirectML where tested
 LiteRT/ExecuTorch*      Native backend         Native backend
          |                   |                    |
          +-------- signed result / metrics -------+
                              |
                              v
                 Supabase private Storage
                 checkpoints, adapter artifacts,
                 immutable task outputs
```

`*` Android inference acceleration and Android gradient training are separate capabilities. NNAPI is not a general-purpose training API. A detected Android GPU or NNAPI delegate must never be labelled as a training accelerator unless the selected training engine actually executes forward/backward/update operations on it.

### Responsibilities

**Control plane (FastAPI):** authentication, scheduling, device registry, lease issuance, task state, validation, aggregation, checkpoint catalog, audit events. It must not load a large model or run a training loop inside an API request.

**Workers:** pull only tasks matching their declared capability; verify the task lease; download only the assigned dataset/model artifact; execute within local resource policy; upload outputs; submit signed/lease-bound completion metadata; renew leases while active.

**Supabase:** remains source of truth for accounts, existing datasets/models/jobs/devices and RLS-protected metadata. Private Storage holds large immutable artifacts and checkpoints. Workers receive short-lived, scoped signed URLs or server-mediated object access; never receive service-role credentials.

## 3. Worker platform design

### Android (Kotlin, separate application)

Create `companion/android/` with:
- Kotlin + AndroidX application, unique application ID such as `com.corpusultimate.worker`.
- Supabase Auth sign-in using the existing supported user authentication flow; store refresh/session material in Android Keystore-backed encrypted storage.
- Foreground service for explicitly user-started compute sessions; persistent notification with Pause/Stop.
- WorkManager for deferred maintenance/reconnect, not as a substitute for a continuously running compute service.
- Capability probes: ABI, API level, CPU cores, RAM class/available memory, thermal status, battery/charging, network policy, supported delegate/runtime versions, GPU backend availability.
- Local policy engine: workload caps, charging/Wi-Fi-only preferences, thermal throttling, low-memory pause, metered network protection, user opt-in.
- Runtime adapters behind interfaces: CPU preprocessing, supported accelerated inference (LiteRT/ExecuTorch/Vulkan where validated), and a separately gated training adapter.
- Start with preprocessing and inference. Add Android gradient training only after a real training runtime can prove forward pass, backward pass, optimizer update, checkpoint round-trip and parity tests on supported devices. Until then advertise `training=false`; do not silently convert training tasks into preprocessing.
- No arbitrary JavaScript bridge exposed to untrusted web content. The website only observes and controls the worker through authenticated backend APIs.

### Windows and Linux

Create `companion/desktop/` as a Python worker package initially:
- Python worker daemon/CLI with a small local tray UI optional later.
- PyTorch CPU backend baseline; GPU plugins selected by explicit runtime probes (CUDA, ROCm, DirectML on Windows) and compatibility tests.
- Isolated worker process per task; bounded memory, CPU thread count, GPU memory budget, timeout and cancellation.
- Local encrypted credential store; no plaintext long-lived tokens in config files.
- Installer/service packaging only after the CLI worker is stable (Windows service/installer and Linux systemd package).
- Same task protocol and capability schema as Android.

### Shared protocol

Versioned JSON schema under `companion/protocol/`:
- `protocol_version`, `worker_id`, `task_id`, `lease_id`, `task_type`, `issued_at`, `expires_at`, `artifact_manifest`, `resource_limits`, `checkpoint_ref`, `result_schema`.
- Task types: `preprocess`, `inference_eval`, `train_shard` (only when true training capability is advertised), `validate_update`.
- Capability fields are explicit booleans plus runtime/device/version details: `preprocess_cpu`, `inference_cpu`, `inference_gpu`, `train_cpu`, `train_gpu`, supported dtypes, max safe memory budget, backend name/version.
- Every completion includes input/output hashes, sample/step counts, loss summaries where applicable, runtime metadata, and a worker-generated result manifest. The server independently validates ownership, lease, hashes, schema, limits and monotonic progress.

## 4. Distributed training semantics (must not be faked)

Use two distinct modes:

1. **Independent jobs / data parallel orchestration:** multiple workers can train separate jobs or independent shards; each has its own checkpoint and metrics. This is safe to ship first.
2. **Synchronous data-parallel gradient aggregation:** only after a tested gradient protocol exists. Each worker starts from the same model and optimizer step, trains a defined batch, submits a gradient/update with the same base checkpoint hash and global step, and waits for coordinator validation/aggregation. Reject stale, duplicate, mismatched, oversized, non-finite or malformed updates. Aggregate only compatible tensors and optimizer states. Commit a new checkpoint atomically and broadcast its hash/version to all participants.

Federated averaging is not equivalent to synchronous gradient all-reduce and must be a separately specified algorithm with its own evaluation and privacy analysis. Do not average arbitrary full model weights from unrelated optimizer states.

For first release, use a single coordinator and a single authoritative checkpoint writer. Use deterministic task IDs, idempotency keys, lease fencing tokens, retry limits, and at-least-once delivery with idempotent completion. Worker loss must expire the lease and reassign only work whose checkpoint/base version is still valid.

## 5. API integration

Preserve and extend the existing device endpoints documented in `docs/DEVICE_TRAINING.md`:
- `POST /api/v1/devices/`: register platform, app version, protocol version and capability manifest.
- `POST /api/v1/devices/{id}/heartbeat`: health, thermal/battery/network state, active lease and progress.
- `POST /api/v1/devices/{id}/assign` and `POST /api/v1/devices/auto-assign`: capability-filtered task leasing.
- `POST /api/v1/devices/{id}/tasks/{task}/progress` and `/complete`: idempotent progress/result reporting.
- Add versioned endpoints only where existing contracts cannot safely express worker enrollment, artifact manifest, lease fencing, task cancellation, update submission or validation. Document request/response schemas and auth requirements before implementation.
- Add an authenticated worker WebSocket only if polling/heartbeat latency is insufficient; use short-lived access tokens and first-frame auth, never tokens in URL query parameters.

Worker registration is not proof of a trusted device. Treat all worker output as untrusted. Enforce per-user quotas, task allowlists, artifact size limits, rate limits, replay protection, lease expiry and audit logs.

## 6. Data model and security approach

First inspect the current migrations and existing `training_devices`, `training_device_tasks`, `training_jobs`, `training_job_events`, `checkpoints`, and Storage policies. Prefer reusing them. If required, add a reviewed migration for only the missing fields/tables (for example protocol version, lease fencing token, artifact hash, worker app version, update manifest). No production SQL should run from this architecture PR.

Security requirements:
- Supabase publishable key may be embedded in clients; service-role/secret keys must never ship in Android or desktop binaries.
- Verify Supabase JWTs server-side; derive owner from verified claims, never from client-supplied owner IDs.
- RLS must scope all rows to the authenticated owner and worker enrollment.
- Workers may write only to task-scoped object paths via short-lived signed URLs or a narrowly scoped backend endpoint.
- Never accept a worker-provided Storage path as proof of ownership.
- Encrypt local credentials; redact tokens and signed URLs from logs.
- Require explicit user opt-in and show exactly what data/artifacts leave the device.
- Provide device revoke/disconnect, remote task cancellation, and deletion of locally cached artifacts.

## 7. Implementation phases and acceptance gates

### Phase 0 — Contract and baseline
- Map existing endpoint schemas, migration history, RLS policies, storage policies, training worker and frontend device agent.
- Add protocol JSON schemas, threat model, sequence diagrams, and compatibility matrix.
- Add tests for current browser-device API compatibility.
**Gate:** no existing browser device workflow regresses; no production migration.

### Phase 1 — Shared protocol + desktop CPU worker
- Implement protocol models, worker enrollment, secure task polling/lease, progress, cancellation, idempotent completion.
- Implement preprocessing task and inference evaluation task on desktop CPU.
- Add Windows/Linux CI and integration tests against a local test API/database.
**Gate:** restart/retry tests, duplicate completion tests, wrong-owner tests, expired lease tests, artifact hash verification.

### Phase 2 — Android native companion (preprocess + inference)
- Build separate Kotlin app, auth, foreground service, device registration and capability reporting.
- Implement CPU preprocessing; then add inference delegate plugins behind runtime probes.
- Integrate battery/thermal/memory policy and user controls.
**Gate:** physical Android device tests; background/foreground, network loss, low battery, thermal throttling, process death, logout and revoke.

### Phase 3 — Real training on desktop
- Implement `train_shard` on desktop PyTorch with real forward/backward/optimizer updates and checkpoint recovery.
- Validate numeric updates, loss computation, deterministic tiny-model fixtures and restart recovery.
**Gate:** tests prove parameters changed, loss is computed from real batches, checkpoint reload reproduces model state, and no success is emitted before persisted completion.

### Phase 4 — Android training capability research and implementation
- Evaluate a supported Android runtime and model/operator subset for actual training.
- Implement only if forward/backward/optimizer and checkpoint export are available and benchmarked on real target hardware.
- Otherwise leave Android `train_cpu/train_gpu=false` and keep the worker useful for preprocessing/inference.
**Gate:** instrumented device test proves parameter delta, finite loss, checkpoint reload, bounded memory/thermal behavior and no hidden backend fallback.

### Phase 5 — Distributed aggregation
- Implement synchronous aggregation with a fixed tiny model first, then larger compatible models.
- Add checkpoint fencing, stale update rejection, all-worker timeout, retry and rollback.
**Gate:** two-worker numerical equivalence against a single-process reference within defined tolerance; inject worker crash/network split/duplicate/stale update.

### Phase 6 — Production rollout
- Run a private beta with opt-in devices; add quotas, observability, abuse controls and rollback.
- Keep heavy training off the FastAPI web process. Deploy a separate worker service/queue with memory sized to the selected model and workload.
- Keep Supabase project and existing data in place. No hosting/database cutover is part of this worker rollout.
**Gate:** load tests, security review, restore test, canary and explicit owner approval before production enablement.

## 8. Required test matrix

- Protocol schema compatibility and version negotiation.
- Auth: missing/expired/revoked token, cross-account task ID, forged owner, replayed completion.
- Lease: expiry, fencing, duplicate delivery, stale worker, cancellation race, worker restart.
- Artifacts: wrong hash, truncated file, oversized file, path traversal, expired signed URL.
- Training: real parameter delta, finite gradients, optimizer state, deterministic checkpoint restore, numerical aggregation.
- Resource safety: Android low memory, thermal throttling, battery threshold, metered network, background restrictions; desktop GPU OOM and driver absence.
- Operations: backend restart while jobs are queued/running; coordinator restart; worker offline/online; no false completed state.

## 9. Explicit non-goals for the first release

- No arbitrary model code execution on enrolled devices.
- No exposing database service-role credentials to workers.
- No claim that NNAPI equals GPU training.
- No browser-only native bridge workaround.
- No automatic federated averaging of arbitrary model weights.
- No production schema changes, deployment, domain switch, or migration of Supabase data in the architecture phase.

## 10. Immediate next engineering tasks

1. Inspect and map existing device endpoint Pydantic schemas and migrations 007/008.
2. Create protocol schema and shared conformance fixtures.
3. Add desktop worker package and local integration harness.
4. Add Android app under `companion/android` without touching the existing Aria app.
5. Run the desktop worker end-to-end before beginning native Android inference.
6. Deliver implementation in small reviewed PRs; do not merge this architecture proposal automatically.
