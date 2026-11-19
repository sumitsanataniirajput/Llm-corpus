# AI teacher network, knowledge distillation and training telemetry

This document describes the teacher-network upgrade: connecting external teacher
models, generating synthetic instruction data with them, reviewing and converting
that data, configuring a student model, and reading back what a training run
actually did. It records what is implemented, what is deliberately **not**
implemented, and how to verify each part.

Historical implementation notes for migrations `010`/`011`. Current status:
[STATUS_AND_LIMITATIONS.md](STATUS_AND_LIMITATIONS.md); current build identity:
`frontend/version.json` and `GET /api/v1/version`.

---

## 1. Honesty rules the code enforces

These are not UI preferences; each one is implemented in the backend and covered
by a test.

| Rule | Where it lives | Test |
| --- | --- | --- |
| No model list, context window or price is hardcoded — a spec appears only if the provider reported it | `backend/app/services/providers/*` | `test_provider_adapters.py` |
| A provider capability is `true`, `false`, or `null` (unverified) — never assumed | `providers/base.py` (`provider_managed_finetuning`) | `test_provider_adapters.py` |
| API keys are encrypted before storage and never returned (mask + fingerprint only) | `services/crypto.py`, `endpoints/teachers.py` | `test_credential_security.py` |
| Spend is reported only from an owner-entered price; unpriced requests are counted, not estimated | `services/distillation.py` (`cost_note`) | `test_distillation_flow.py` |
| Quota exhaustion stops the run and records the reason instead of failing silently | `services/distillation.py` (`stop_reason`) | `test_distillation_flow.py` |
| Only human-accepted (or validated-and-accepted) records are converted into datasets | `endpoints/distillation.py` (`/convert`) | `test_distillation_flow.py` |
| Training telemetry is read from persisted rows; missing measurements are `null` and render as "Unavailable" | `services/telemetry.py` | `test_student_intelligence.py` |
| A QLoRA / HF-weight plan that the installed runtime cannot run is reported unavailable with the reason | `services/student_studio.py` | `test_student_intelligence.py` |
| Cross-account access to a teacher, job, record or training job is a 404 | every endpoint | `test_distillation_flow.py` |

---

## 2. Provider connections

Supported provider types: `openai`, `gemini`, `anthropic`, `openrouter`, `groq`,
`together`, `deepseek`, `fireworks` and `custom` (any OpenAI-compatible base URL).

| Provider | Auth header | Model discovery | Notes |
| --- | --- | --- | --- |
| OpenAI-compatible | `Authorization: Bearer` | `GET /models` | Used for OpenAI, OpenRouter, Groq, Together, DeepSeek, Fireworks and `custom` |
| Anthropic | `x-api-key` + `anthropic-version` | `GET /v1/models` (cursor pagination via `after_id`) | System prompt is a top-level field, not a message |
| Gemini | `x-goog-api-key` | `GET /v1beta/models` | Only `supportedGenerationMethods` that include `generateContent` are listed as teachers; output cap goes in `generationConfig.maxOutputTokens` |

Errors are mapped consistently: `401` → `invalid_credential`, `429` →
`ProviderRateLimitError` with `retry_after_seconds`, `5xx` → `provider_error`.
A fine-tune probe that returns `404` means `supported: False`; anything else
unknown stays `null`.

### Credentials

* Keywords are encrypted with **AES-256-GCM** using `CREDENTIAL_ENCRYPTION_KEY`
  (base64, 32 bytes). If the key is absent the API refuses to store a credential
  and says why — it never falls back to plaintext.
* Responses carry `credential_hint` (`••••6789`) and `credential_fingerprint`
  (first 8 hex of a SHA-256 digest) so an operator can tell two keys apart.
* `decrypt_secret` is only called inside the provider adapters and the explicit
  `POST /teachers/providers/{id}/redaction-check` diagnostic, never in a handler
  that returns a provider object.

---

## 3. Teacher selection modes

| Mode | Meaning | Validation |
| --- | --- | --- |
| A `single` | One teacher answers | ≥ 1 teacher |
| B `multi` | Several teachers answer independently, disagreement is measured | ≥ 2 **different providers** |
| C `evaluator` | Teacher generates, a separate evaluator scores | evaluator from a different provider than the teacher |
| D `competition` | Responses compete, the highest-scoring survives | evaluator required |
| E `specialized` | Each subject is routed to its own teacher | subject map required |

Budgets are hard limits, not hints: `max_requests`, `max_input_tokens`,
`max_output_tokens`, `max_total_tokens`, `max_spend_usd`, `max_concurrent_requests`,
plus a per-provider daily cap (`max_requests_per_day`, `max_spend_usd_per_day`).
When a limit is reached the run stops and `progress.budget.stop_reason` records
which one.

---

## 4. Distillation lifecycle

```
draft ──▶ running ──▶ review ──▶ (human review) ──▶ convert ──▶ dataset(s)
             │
             └──▶ cancelled / failed
```

* `POST /distillation/jobs` **requires** `allow_external_send: true`. The dataset
  excerpt is then sent to the selected providers; without the flag the API
  answers `400`.
* Each record keeps provenance: `provider_id`, `provider_name`, `model_id`,
  `request_id`, token usage, latency, and the prompt that produced it.
* Validation checks language, format, length, repetition, refusals, near-duplicate
  text and teacher disagreement. Failures are stored on the record, not dropped.
* `POST /distillation/jobs/{id}/records/bulk` accepts/rejects/deletes in one call;
  `PATCH …/records/{record_id}` edits the answer and marks it human-reviewed.
* `GET …/export?format=chat_jsonl|alpaca&split=…` streams NDJSON with
  `X-Record-Count` / `X-Skipped-Count` headers.
* `POST …/convert` uploads one dataset per split and returns the created datasets.

---

## 5. Student models

`GET /students/system` reports the libraries the backend really has:

```json
{ "libraries": { "torch": "…", "transformers": "…", "peft": "0.7.1",
                 "bitsandbytes": null, "cuda_available": false } }
```

Method availability is computed per base source, and every unavailable method
carries its reason:

* CORPUS PyTorch models → `sft` available; `lora`/`qlora` unavailable because the
  architecture is a custom transformer, not a Hugging Face module tree.
* Hugging Face models → `sft`/`lora` when `transformers`+`peft` are installed;
  `qlora` only when `bitsandbytes` and CUDA are present.

`POST /students/inspect` instantiates a CORPUS model to count real parameters, or
reads an HF `AutoConfig`. `compatibility.hf_weights_loadable` is `false` for CORPUS
checkpoints (custom state dict) and the UI says so.

---

## 6. Training telemetry

`GET /training/{job_id}/intelligence` returns six blocks:

| Block | Source of truth |
| --- | --- |
| `architecture` | Model instantiated / `AutoConfig` read; parameter count measured |
| `training` | Job config, with `effective_global_batch = batch × accumulation` |
| `dataset` | `training_dataset_analytics` row written by the worker |
| `hardware` | `training_runtime_snapshots` rows (`psutil`, no GPU guesswork) |
| `metrics` | `training_job_events` metric rows (engine's own step counter) |
| `charts` | The same series, shaped for Chart.js |

Anything unmeasured is `null` and renders as "Unavailable". ETA appears only when
it can be derived from a real start time and a measured throughput;
`Generation, validation, training and evaluation are separate runs` is stated in
the response (`independent_status_note`) so a finished generation job is never
shown as a trained model.

`training_jobs` has **no** `started_at` column, so elapsed time is measured from
the first metric row, else from `created_at`.

---

## 7. Migrations and deployment order

1. `supabase/migrations/010_teacher_network_and_distillation.sql`
2. `supabase/migrations/011_student_models_and_training_telemetry.sql`
3. Backend deploy (needs `CREDENTIAL_ENCRYPTION_KEY`, `RATE_LIMIT_REQUESTS_PER_MINUTE`)
4. Frontend deploy, then verify `/version.json` reports the same build id as
   `frontend/version.json` in the deployed commit.

Both migrations are additive: six tables in `010`
(`ai_provider_connections`, `ai_teacher_models`, `ai_provider_requests`,
`distillation_jobs`, `distillation_records`, `distillation_evaluations`) and three
in `011` (`student_training_configs`, `training_runtime_snapshots`,
`training_dataset_analytics`), each with owner-scoped RLS.

---

## 8. Verification

```bash
# backend (149 tests)
cd backend && python -m pytest -p no:warnings -q -o addopts=""

# frontend (169 tests; 11 pre-existing datasets/training failures unrelated to this work)
npm test
```

New frontend coverage: `frontend/tests/teacher-network.test.mjs` (key never
rendered, consent required, provenance shown, unpriced cost not invented, GPU
nulls printed as Unavailable) and `frontend/tests/route-wiring.test.mjs` (every
sidebar route resolves to a real module and the build id matches everywhere).
