"""CORPUS ULTIMATE — Model management endpoints.

CRUD for model configurations with persistent SQLAlchemy storage.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.models import Checkpoint, EvaluationRun, Model, TrainingJob
from app.core.security import validate_model_config
from app.dependencies import require_user, get_db_session

try:  # Supabase client is optional at import time so the API can boot without it.
    from supabase import create_client
except Exception:  # pragma: no cover - only hit when the SDK is missing
    create_client = None

logger = logging.getLogger("corpus.models")

router = APIRouter()

ACTIVE_TRAINING_STATUSES = {"queued", "preparing", "running", "pausing", "paused", "stopping"}


class ModelConfig(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    name: str
    vocab_size: int = 5000
    context_length: int = 256
    d_model: int = 256
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 1024
    dropout: float = 0.1


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: str
    owner_id: str
    name: str
    config: Dict[str, Any]
    version: str
    status: str
    created_at: str
    updated_at: str


def _require_user_uuid(user: dict) -> uuid.UUID:
    raw = (user or {}).get("user_id")
    if not raw:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        return uuid.UUID(str(raw).strip())
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid authenticated user identifier")


def _normalize_owner_id(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, uuid.UUID):
        return str(value).lower()
    raw = str(value).strip()
    try:
        return str(uuid.UUID(raw)).lower()
    except (ValueError, TypeError):
        return raw.lower()


def _same_owner(record_owner_id: Any, user_id: Any) -> bool:
    left = _normalize_owner_id(record_owner_id)
    right = _normalize_owner_id(user_id)
    return bool(left and right and left == right)


def _model_to_out(model: Model) -> ModelOut:
    return ModelOut(
        id=model.id,
        owner_id=str(model.owner_id),
        name=model.name,
        config=model.config,
        version=model.version,
        status=model.status,
        created_at=model.created_at.isoformat(),
        updated_at=model.updated_at.isoformat(),
    )


def _storage_client():
    """Create a backend-only Supabase Storage client using the service role key."""
    if create_client is None:
        raise HTTPException(
            status_code=503,
            detail="Model storage cleanup unavailable: the Supabase SDK is not installed on the backend.",
        )
    if not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(
            status_code=503,
            detail="Model storage cleanup is not configured: add SUPABASE_SERVICE_ROLE_KEY to the backend environment.",
        )
    if not settings.SUPABASE_URL:
        raise HTTPException(
            status_code=503,
            detail="Model storage cleanup is not configured: SUPABASE_URL is missing.",
        )
    try:
        return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    except Exception as exc:  # pragma: no cover - configuration specific
        raise HTTPException(
            status_code=503,
            detail=f"Could not initialise Supabase Storage client: {str(exc)[:200]}",
        )


async def _table_exists(db: AsyncSession, table_name: str) -> bool:
    result = await db.execute(
        text("SELECT to_regclass(:name)"),
        {"name": f"public.{table_name}"},
    )
    return result.scalar_one_or_none() is not None


@router.get("", response_model=List[ModelOut], include_in_schema=False)
@router.get("/", response_model=List[ModelOut], tags=["models"])
async def list_models(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List models owned by the current user."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(
        select(Model).where(Model.owner_id == owner_uuid).order_by(Model.created_at.desc())
    )
    models = result.scalars().all()
    return [_model_to_out(m) for m in models]


@router.post("", response_model=ModelOut, include_in_schema=False)
@router.post("/", response_model=ModelOut, tags=["models"])
async def create_model(config: ModelConfig, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Create a new model configuration after validation."""
    owner_uuid = _require_user_uuid(user)
    name = (config.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Model name is required.")
    payload = config.model_dump()
    payload["name"] = name
    validation = validate_model_config(payload)
    if not validation["valid"]:
        raise HTTPException(status_code=400, detail={"errors": validation["errors"]})

    model_id = "model_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    model = Model(
        id=model_id,
        owner_id=owner_uuid,
        name=name,
        config=payload,
        version="1.0",
        status="idle",
        created_at=now,
        updated_at=now,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    return _model_to_out(model)


@router.get("/{model_id}", response_model=ModelOut, tags=["models"])
async def get_model(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Get a single model by ID."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        raise HTTPException(status_code=403, detail="Not authorized")
    return _model_to_out(model)


@router.put("/{model_id}", response_model=ModelOut, tags=["models"])
async def update_model(model_id: str, updates: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Update model configuration."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        raise HTTPException(status_code=403, detail="Not authorized")

    for key, value in updates.items():
        if hasattr(model, key) and key not in ("id", "owner_id", "created_at"):
            setattr(model, key, value)
    model.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(model)
    return _model_to_out(model)


@router.delete("/{model_id}", tags=["models"])
async def delete_model(
    model_id: str,
    stop_active: bool = Query(default=False),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Safely delete a model, its checkpoints, tokenizer artifacts, and references.

    Verifies ownership, guards against active training jobs (or safely stops
    in-process jobs when ``stop_active=true``), deletes model-specific objects
    from private Supabase Storage before removing database rows, and never
    modifies or deletes shared datasets.
    """
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        logger.warning(
            "Denied delete_model for model=%s: owner=%s caller=%s",
            model_id,
            _normalize_owner_id(model.owner_id),
            _normalize_owner_id(owner_uuid),
        )
        raise HTTPException(status_code=403, detail="Not authorized")

    # 1. Check active training jobs referencing this model.
    jobs_result = await db.execute(
        select(TrainingJob).where(TrainingJob.model_id == model_id)
    )
    model_jobs = jobs_result.scalars().all()
    active_jobs = [j for j in model_jobs if j.status in ACTIVE_TRAINING_STATUSES]

    if active_jobs:
        if not stop_active:
            first = active_jobs[0]
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Model '{model.name}' has active training jobs ({first.id}, status: {first.status}). "
                    "Stop the training job first before deleting this model."
                ),
            )

        from app.services import training_worker
        for job in active_jobs:
            in_process = training_worker.is_job_running(job.id)
            if in_process:
                stopped = await training_worker.stop_and_wait_for_job(job.id, timeout=5.0)
                if not stopped or training_worker.is_job_running(job.id):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Training job {job.id} is still shutting down. "
                            "Wait a moment and try deleting the model again."
                        ),
                    )
            else:
                if job.status in {"running", "pausing"}:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Training job {job.id} is currently {job.status} on a worker and could not be verified stopped. "
                            "Stop it in Training Center first."
                        ),
                    )
                job.status = "stopped"
                job.updated_at = datetime.now(timezone.utc)
        await db.commit()

    # 2. Collect model-specific storage paths (checkpoints + tokenizer), never datasets.
    ckpt_result = await db.execute(
        select(Checkpoint).where(Checkpoint.model_id == model_id)
    )
    checkpoints = ckpt_result.scalars().all()

    candidate_paths = []
    for ckpt in checkpoints:
        if ckpt.storage_path:
            candidate_paths.append(ckpt.storage_path)

    cfg = model.config if isinstance(model.config, dict) else {}
    for key in ("checkpoint_path", "tokenizer_path"):
        val = cfg.get(key)
        if isinstance(val, str) and val.strip():
            candidate_paths.append(val.strip())

    tok_ref = getattr(model, "tokenizer_ref", None)
    if isinstance(tok_ref, str) and tok_ref.strip():
        candidate_paths.append(tok_ref.strip())

    # Deduplicate while preserving order.
    storage_paths = list(dict.fromkeys(candidate_paths))

    # Guard against removing any path still referenced by another model or dataset file.
    if storage_paths:
        other_ckpts = await db.execute(
            select(Checkpoint.storage_path).where(
                Checkpoint.model_id != model_id,
                Checkpoint.storage_path.in_(storage_paths),
            )
        )
        shared_paths = {row[0] for row in other_ckpts.all() if row[0]}
        if await _table_exists(db, "dataset_files"):
            ds_files = await db.execute(
                text("SELECT storage_path FROM public.dataset_files WHERE storage_path = ANY(:paths)"),
                {"paths": storage_paths},
            )
            shared_paths.update(row[0] for row in ds_files.all() if row[0])
        storage_paths = [p for p in storage_paths if p not in shared_paths]

    # 3. Remove model-specific artifacts from private storage BEFORE deleting DB rows.
    if storage_paths:
        storage = _storage_client()
        try:
            storage.storage.from_(settings.STORAGE_BUCKET).remove(storage_paths)
        except Exception as exc:
            logger.exception(
                "Storage cleanup failed while deleting model %s (paths=%s)",
                model_id,
                storage_paths,
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Could not remove model files from private storage: {str(exc)[:250]}. "
                    "The model was not deleted so storage is not left orphaned."
                ),
            )

    # 4. Detach historical references & delete model-owned rows without touching datasets.
    job_ids = [j.id for j in model_jobs]

    if job_ids:
        await db.execute(
            text("UPDATE public.training_jobs SET model_id = NULL WHERE model_id = :model_id"),
            {"model_id": model_id},
        )
        await db.execute(
            text("UPDATE public.checkpoints SET job_id = NULL WHERE job_id = ANY(:job_ids) AND model_id != :model_id"),
            {"job_ids": job_ids, "model_id": model_id},
        )

    await db.execute(delete(Checkpoint).where(Checkpoint.model_id == model_id))

    if await _table_exists(db, "evaluation_runs"):
        await db.execute(
            text("UPDATE public.evaluation_runs SET model_id = NULL WHERE model_id = :model_id"),
            {"model_id": model_id},
        )

    if await _table_exists(db, "conversations"):
        await db.execute(
            text("UPDATE public.conversations SET model_id = NULL WHERE model_id = :model_id"),
            {"model_id": model_id},
        )

    for optional_table in ("model_versions", "model_architectures"):
        if await _table_exists(db, optional_table):
            await db.execute(
                text(f"DELETE FROM public.{optional_table} WHERE model_id = :model_id"),
                {"model_id": model_id},
            )

    await db.execute(delete(Model).where(Model.id == model_id))
    await db.commit()

    logger.info(
        "Deleted model=%s owner=%s removed_files=%d detached_jobs=%d",
        model_id,
        owner_uuid,
        len(storage_paths),
        len(job_ids),
    )
    return {
        "ok": True,
        "model_id": model_id,
        "removed_files": len(storage_paths),
        "removed_storage_files": len(storage_paths),
        "storage_cleanup_warning": None,
        "removed_checkpoints": len(checkpoints),
        "removed_jobs": len(job_ids),
    }


@router.post("/{model_id}/clone", response_model=ModelOut, tags=["models"])
async def clone_model(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Clone an existing model."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        raise HTTPException(status_code=403, detail="Not authorized")

    new_id = "model_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    clone = Model(
        id=new_id,
        owner_id=owner_uuid,
        name=model.name + " (clone)",
        config=model.config,
        version="1.0",
        status="idle",
        created_at=now,
        updated_at=now,
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone)
    return _model_to_out(clone)


@router.post("/validate", tags=["models"])
async def validate_config(config: dict, user=Depends(require_user)):
    """Validate a model configuration without saving."""
    return validate_model_config(config)


@router.get("/{model_id}/versions", response_model=List[dict], tags=["models"])
async def list_model_versions(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List version history for a model."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        raise HTTPException(status_code=403, detail="Not authorized")
    return [{"version": model.version, "created_at": model.created_at.isoformat()}]


@router.get("/{model_id}/export", tags=["models"])
async def export_model(model_id: str, version: str = "1.0", user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Export model configuration and weights reference."""
    owner_uuid = _require_user_uuid(user)
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if not _same_owner(model.owner_id, owner_uuid):
        raise HTTPException(status_code=403, detail="Not authorized")
    return {
        "model_id": model_id,
        "version": version,
        "config": model.config,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }