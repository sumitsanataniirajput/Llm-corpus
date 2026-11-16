"""CORPUS ULTIMATE — Model management endpoints.

CRUD for model configurations with persistent SQLAlchemy storage.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, update, text

from app.dependencies import require_user, get_db_session
from app.config import settings
from app.core.models import Model
from app.core.security import validate_model_config

try:
    from supabase import create_client
except Exception:  # pragma: no cover - SDK is optional for API-only deployments
    create_client = None

router = APIRouter()


class ModelConfig(BaseModel):
    name: str
    vocab_size: int = 5000
    context_length: int = 256
    d_model: int = 256
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 1024
    dropout: float = 0.1


class ModelOut(BaseModel):
    id: str
    owner_id: str
    name: str
    config: Dict[str, Any]
    version: str
    status: str
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


@router.get("", response_model=List[ModelOut], include_in_schema=False)
@router.get("/", response_model=List[ModelOut], tags=["models"])
async def list_models(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List models owned by the current user."""
    result = await db.execute(
        select(Model).where(Model.owner_id == uuid.UUID(user["user_id"])).order_by(Model.created_at.desc())
    )
    models = result.scalars().all()
    return [
        ModelOut(
            id=m.id,
            owner_id=str(m.owner_id),
            name=m.name,
            config=m.config,
            version=m.version,
            status=m.status,
            created_at=m.created_at.isoformat(),
            updated_at=m.updated_at.isoformat(),
        )
        for m in models
    ]


@router.post("", response_model=ModelOut, include_in_schema=False)
@router.post("/", response_model=ModelOut, tags=["models"])
async def create_model(config: ModelConfig, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Create a new model configuration after validation."""
    validation = validate_model_config(config.model_dump())
    if not validation["valid"]:
        raise HTTPException(status_code=400, detail={"errors": validation["errors"]})

    model_id = "model_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    model = Model(
        id=model_id,
        owner_id=uuid.UUID(user["user_id"]),
        name=config.name,
        config=config.model_dump(),
        version="1.0",
        status="idle",
        created_at=now,
        updated_at=now,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
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


@router.get("/{model_id}", response_model=ModelOut, tags=["models"])
async def get_model(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Get a single model by ID."""
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != uuid.UUID(user["user_id"]):
        raise HTTPException(status_code=403, detail="Not authorized")
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


@router.put("/{model_id}", response_model=ModelOut, tags=["models"])
async def update_model(model_id: str, updates: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Update model configuration."""
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != uuid.UUID(user["user_id"]):
        raise HTTPException(status_code=403, detail="Not authorized")

    for key, value in updates.items():
        if hasattr(model, key) and key not in ("id", "owner_id", "created_at"):
            setattr(model, key, value)
    model.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(model)
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


@router.delete("/{model_id}", tags=["models"])
async def delete_model(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Delete an owned model and safely detach its historical references.

    Training history, evaluations and conversations are retained. Model-only
    records and private checkpoint/tokenizer objects are removed.
    """
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    active_result = await db.execute(text("""
        SELECT status FROM public.training_jobs
        WHERE model_id = :model_id
    """), {"model_id": model_id})
    active_statuses = {"queued", "pending", "preparing", "running", "pausing", "paused", "stopping"}
    active = sorted({
        str(row["status"]).lower()
        for row in active_result.mappings().all()
        if row["status"] and str(row["status"]).lower() in active_statuses
    })
    if active:
        raise HTTPException(
            status_code=409,
            detail="This model has active training jobs (" + ", ".join(active) +
                   "). Stop or wait for those jobs before deleting the model.",
        )

    # Collect private artifact paths before deleting their metadata.
    path_result = await db.execute(text("""
        SELECT storage_path FROM public.checkpoints
        WHERE model_id = :model_id AND storage_path IS NOT NULL
    """), {"model_id": model_id})
    storage_paths = {
        str(row["storage_path"])
        for row in path_result.mappings().all()
        if row["storage_path"]
    }
    if isinstance(model.config, dict):
        for key in ("checkpoint_path", "tokenizer_path"):
            value = model.config.get(key)
            if isinstance(value, str) and value.strip():
                storage_paths.add(value.strip())

    tokenizer_result = await db.execute(text("""
        SELECT tokenizer_ref FROM public.models WHERE id = :model_id
    """), {"model_id": model_id})
    tokenizer_row = tokenizer_result.mappings().first()
    if tokenizer_row and tokenizer_row.get("tokenizer_ref"):
        storage_paths.add(str(tokenizer_row["tokenizer_ref"]))

    try:
        # Preserve past jobs/evaluations/chats, but remove their FK to this model.
        await db.execute(text("""
            UPDATE public.training_jobs SET model_id = NULL
            WHERE model_id = :model_id
        """), {"model_id": model_id})
        await db.execute(text("""
            UPDATE public.evaluation_runs SET model_id = NULL
            WHERE model_id = :model_id
        """), {"model_id": model_id})
        await db.execute(text("""
            UPDATE public.conversations SET model_id = NULL
            WHERE model_id = :model_id
        """), {"model_id": model_id})

        await db.execute(text("DELETE FROM public.checkpoints WHERE model_id = :model_id"), {"model_id": model_id})
        await db.execute(text("DELETE FROM public.model_versions WHERE model_id = :model_id"), {"model_id": model_id})
        await db.execute(text("DELETE FROM public.model_architectures WHERE model_id = :model_id"), {"model_id": model_id})
        await db.execute(delete(Model).where(Model.id == model_id, Model.owner_id == owner_id))
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    removed_storage_files = 0
    storage_cleanup_warning = None
    if storage_paths:
        if create_client is None or not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
            storage_cleanup_warning = "Model deleted, but private artifacts could not be cleaned up because Supabase Storage is not configured."
        else:
            try:
                storage = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
                storage.storage.from_(settings.STORAGE_BUCKET).remove(sorted(storage_paths))
                removed_storage_files = len(storage_paths)
            except Exception as exc:
                storage_cleanup_warning = (
                    "Model deleted, but some private artifacts may remain in storage: " + str(exc)[:180]
                )

    return {
        "ok": True,
        "model_id": model_id,
        "removed_storage_files": removed_storage_files,
        "storage_cleanup_warning": storage_cleanup_warning,
    }


@router.post("/{model_id}/clone", response_model=ModelOut, tags=["models"])
async def clone_model(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Clone an existing model."""
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != uuid.UUID(user["user_id"]):
        raise HTTPException(status_code=403, detail="Not authorized")

    new_id = "model_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    clone = Model(
        id=new_id,
        owner_id=str(model.owner_id),
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
    return ModelOut(
        id=clone.id,
        owner_id=str(clone.owner_id),
        name=clone.name,
        config=clone.config,
        version=clone.version,
        status=clone.status,
        created_at=clone.created_at.isoformat(),
        updated_at=clone.updated_at.isoformat(),
    )


@router.post("/validate", tags=["models"])
async def validate_config(config: dict, user=Depends(require_user)):
    """Validate a model configuration without saving."""
    return validate_model_config(config)


@router.get("/{model_id}/versions", response_model=List[dict], tags=["models"])
async def list_model_versions(model_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List version history for a model."""
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != uuid.UUID(user["user_id"]):
        raise HTTPException(status_code=403, detail="Not authorized")
    return [{"version": model.version, "created_at": model.created_at.isoformat()}]


@router.get("/{model_id}/export", tags=["models"])
async def export_model(model_id: str, version: str = "1.0", user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Export model configuration and weights reference."""
    result = await db.execute(select(Model).where(Model.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != uuid.UUID(user["user_id"]):
        raise HTTPException(status_code=403, detail="Not authorized")
    return {
        "model_id": model_id,
        "version": version,
        "config": model.config,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }