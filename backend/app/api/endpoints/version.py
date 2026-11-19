"""CORPUS ULTIMATE — deployment identity endpoint.

The live app kept serving an old build while ``main`` already contained the fix,
so "is the deployment running the latest code?" must be answerable from the
deployed service itself instead of from GitHub.

``GET /api/v1/version`` reports:

* ``build_id`` — bumped by hand whenever shipped behaviour changes; compare it
  with ``backend/app/api/endpoints/version.py`` on ``main``,
* ``commit`` — ``RENDER_GIT_COMMIT`` (set automatically by Render) so the exact
  deployed SHA can be read from the running process,
* ``features`` — machine-checkable markers for fixes that must be live.

Nothing here is secret: no URLs, keys, or user data.
"""
import datetime
import os
from typing import Optional

from fastapi import APIRouter

router = APIRouter()

# Bump when a shipped fix must be verified in production.
BUILD_ID = "2026-11-20.8"

# Behaviour markers that must be present in a healthy production deployment.
FEATURES = [
    "owner-id-normalization",        # str/UUID owner comparison cannot 403 the owner
    "owner-column-type-agnostic",    # list filter works on uuid *and* text owner columns
    "owner-delete-authorized",       # DELETE /api/v1/models/{id} ownership checks
    "model-delete-cleanup",          # checkpoints/tokenizer/jobs cleaned, datasets kept
    "ownership-diagnostics",         # GET /api/v1/models/ownership-diagnostics
    "version-endpoint-present",      # this route exists at all on the deployed API
    "checkpoint-model-ownership",    # checkpoints inherit access from their parent model
    "production-web-cors-origin",    # deployed frontend origin is accepted by CORS
    "android-upload-queue-persistence", # frontend IndexedDB preserves selected files across Android reloads
    "dataset-storage-io-off-event-loop", # Supabase dataset upload/preview do not block FastAPI
    "dataset-upload-metadata-rollback", # failed metadata writes remove orphaned private objects
    "training-storage-io-off-event-loop", # training data/checkpoint transfers do not block FastAPI
    "evaluation-status-honest",         # no fabricated score/completed evaluation
    "compute-worker-owner-required",    # worker registration rejects nil-UUID owners
    "training-compute-truthful",        # only in-process CPU training is accepted
    "rate-limit-bounded-proxy-safe",    # bounded buckets, health exempt, trusted proxy IPs
    "websocket-auth-first-frame",       # no Supabase token in socket URLs; shared auth frame
    "device-ownership-canonical",       # device/task/job queries use UUID/text-safe ownership
    "charts-numeric-zoom-reset",        # shared numeric axes, ranges, downsampling, zoom/reset
    "checkpoint-backed-inference",      # real PyTorch state dict + tokenizer, no canned replies
    "active-model-selectors",           # chat/prediction account models and per-user active id
    "inference-cache-cleared-on-delete", # deleting a model evicts decoded checkpoints
    "repo-hygiene-ci-tests",            # pytest/jsdom, migration manifest, baseline-aware gate
]

_STARTED_AT = datetime.datetime.now(datetime.timezone.utc).isoformat()


def _env(*names: str) -> Optional[str]:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


@router.get("", include_in_schema=False)
@router.get("/", tags=["version"])
async def get_version():
    """Report which build/commit this process is running."""
    return {
        "service": _env("RENDER_SERVICE_NAME") or "corpus-ultimate-api",
        "build_id": BUILD_ID,
        "commit": _env("RENDER_GIT_COMMIT", "GIT_COMMIT", "SOURCE_VERSION"),
        "branch": _env("RENDER_GIT_BRANCH", "GIT_BRANCH"),
        "render_service_id": _env("RENDER_SERVICE_ID"),
        "render_instance_id": _env("RENDER_INSTANCE_ID"),
        "process_started_at": _STARTED_AT,
        "features": FEATURES,
    }
