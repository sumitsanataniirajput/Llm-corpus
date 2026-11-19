# CORPUS ULTIMATE — cost model

> These are illustrative planning figures, not a bill, a price quote, or a
> measurement of a deployed service. Verify current provider pricing before
> making a decision.

## What the code actually consumes

| Resource | Used for | Local tests |
|----------|----------|-------------|
| Supabase PostgreSQL | model/job/device metadata | backend tests use throw-away local `pgserver`, not Supabase |
| Supabase Storage (`corpus-storage`, private) | uploaded text, checkpoints, tokenizers | faked in tests; no production objects were written by P2 |
| FastAPI CPU process | real in-process PyTorch training + checkpoint inference | one process; no cloud/device gradient workers |
| Static host + CDN | `frontend/` files | no build step |

The default training path is CPU-only PyTorch. There is no GPU bill, no hosted
LLM API call, and no distributed worker billing in the running code. Chat and
Prediction Lab load the user's own checkpoint; they do not call an external
model provider.

## Free-tier planning example

Assume one small custom model, one uploaded text dataset, a few short CPU
training runs, and fewer than 100 MB of stored checkpoints. A Supabase free
project and a free static host may be sufficient for a demo. Check the current
free-tier limits for database size, storage egress, pausing, and bandwidth.
A free Render-style backend tier may cold-start: the browser must retry after
the first request and `/ready` should be checked before a long training job.

## Small paid pilot (illustrative)

| Item | Example assumption | Cost question to verify |
|------|--------------------|-------------------------|
| Supabase Pro | one project, modest database + storage | monthly base + storage/egress overage |
| Backend | one always-on CPU container | instance-hours; RAM needed to load a checkpoint |
| Static host | one site, low traffic | included or bandwidth overage |
| Observability | log retention | ingestion/retention pricing |

A single CPU process is the practical bottleneck. If training takes too long,
the current code cannot distribute the job across devices; a paid GPU host and
a real distributed-training implementation would be required, neither of which
is included here.

## Scaling questions (not features)

- How many concurrent checkpoints fit in memory? The inference cache is bounded
  to four decoded bundles per backend process, but PyTorch tensors still use RAM.
- Is the rate limiter shared? No — it is per-process. Use a shared store before
  running multiple backend instances.
- Are migrations reversible? No automatic down-migration exists; see
  [MIGRATIONS_AND_ROLLBACK.md](MIGRATIONS_AND_ROLLBACK.md).
- Are provider credentials recoverable after key rotation? Encrypted credentials
  need a stable `CREDENTIAL_ENCRYPTION_KEY`.

## Verification

Run `npm run test:ci` and `cd backend && pytest -q` locally. After any actual
deployment, compare `/api/v1/version` and `/version.json` using
[PRODUCTION_VERIFICATION.md](PRODUCTION_VERIFICATION.md). No deployment or
production cost was incurred by the P2 work.
