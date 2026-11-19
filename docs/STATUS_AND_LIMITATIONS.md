# CORPUS ULTIMATE — implementation status and limits

**This document describes the local checkout, not a deployed service.** It is
intentionally blunt so the README, deployment guide and UI copy do not promise
features that the code does not execute.

Last reviewed: 2026-11-19, local working tree. Changes are uncommitted unless
the Git history says otherwise.

## What the code actually does today

- **Authentication:** Supabase bearer tokens for REST. Browser WebSockets use a
  first-frame `{"type":"auth","token":"..."}` handshake; tokens are not put in
  query strings. The general socket is `/api/v1/ws`, training progress is
  `/api/v1/training/ws/{job_id}`, inference streaming is
  `/api/v1/inference/{model_id}/ws`.
- **Models and training:** create model configs, upload text datasets to private
  Supabase Storage, and run a real in-process PyTorch CPU training loop. The
  worker writes optimizer-step metrics, a `model.pt` state dict and a
  `tokenizer.json`. Training accepts only `compute="local"`; cloud and
  device-side gradient training are not implemented.
- **Devices:** register browsers, heartbeat, lease preprocessing shards and
  aggregate shard token counts. Device rows never perform gradient updates or
  synchronise weights.
- **Checkpoint-backed inference:** after a successful training job, the model
  row stores checkpoint and tokenizer paths. `/api/v1/inference/{id}`,
  `/tokenize/{id}` and `/predict/{id}` load those private objects and use the
  real `CorpusTransformerPT` logits, tokenizer and sampling parameters.
  Untrained models answer `status="unavailable"` with an explicit message; they
  do not receive a canned `[untrained]` reply.
- **Prediction Lab and Chat:** both offer an account-scoped model selector. The
  active model id is persisted per account in local storage. Chat surfaces a
  backend `unavailable` message instead of inventing a response.
- **Charts:** Dashboard, Statistics, Training and Intelligence share numeric
  line-chart helpers with linear step axes, x/y range readouts, min/max-preserving
  downsampling, drag/ctrl-wheel zoom and reset.
- **Evaluation:** the endpoint records `score=None` and `status="unavailable"`
  because no evaluation engine is wired; it does not fabricate a completed score.

## What is deliberately not implemented

- Fine-tuning hosted/open-source LLMs, LoRA/QLoRA adapter training in the
  production worker, or external teacher-model generation as part of Chat.
- Distributed/cloud gradient workers, federated averaging, weight/gradient
  synchronisation, `compute="cloud"`, or resuming a gradient run on a phone.
- Model export/deployment beyond returning the stored configuration and private
  storage references.
- Evaluation scoring, benchmark scores, accuracy claims, OCR for scanned PDFs,
  or account deletion server-side.
- Multi-instance shared rate limiting: the limiter is bounded and proxy-aware
  but per-process; configure `TRUSTED_PROXY_IPS` and use shared state before
  horizontal scaling.
- Alembic autogeneration at startup. The backend does **not** call
  `Base.metadata.create_all`; apply the SQL migrations explicitly in order (see
  [MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md)).

## Verification performed locally

- Frontend jsdom suite: `npm test` currently has 9 known pre-existing failures
  (stale transparent file-picker tests). The two former training-progress
  regressions were repaired in the Training Center fix: a terminal WebSocket
  status can no longer be reverted by a stale in-flight REST read, and the
  test harness now maps metrics fixtures so completed-job restoration is
  exercised for real. P2 added suites pass; `npm run test:baseline` fails only
  on *new* failures.
- Backend pytest suite: full `pytest -q` passes against a throw-away pgserver
  PostgreSQL instance, including real checkpoint loading and generation.
- `node --check` on frontend JS/tests/scripts and `py_compile` on changed backend
  modules.
- Build identity is exposed by `frontend/version.json` and
  `GET /api/v1/version`; compare both after a deployment.

## Not performed

No commit, pull request, merge, deployment, Render redeploy, Supabase project
change, production migration, real cloud/device gradient run, physical Android
Chrome validation, or production data change was performed as part of this
work. Backend tests use temporary local PostgreSQL, never production data.
