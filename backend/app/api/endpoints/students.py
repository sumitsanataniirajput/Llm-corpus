"""Student Model Studio — inspect a base model, gate training methods, save configs.

The studio never asserts compatibility. It inspects the model (CORPUS: build the
transformer; Hugging Face: read the real config), then reports per-method
availability with the reasons. A saved config keeps the architecture snapshot and
the availability decision that was true at save time, so the training page can
show why a method was offered.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Model, StudentTrainingConfig
from app.dependencies import get_db_session, require_user
from app.services import student_studio as studio
from app.services.student_studio import InspectError

router = APIRouter()


class InspectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_source: str = "corpus"          # corpus | huggingface
    model_id: Optional[str] = None       # CORPUS model row id
    base_ref: Optional[str] = None       # Hugging Face repo id
    load_weights: bool = False
    hf_token: Optional[str] = None


class LoraPlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    architecture: Dict[str, Any] = Field(default_factory=dict)
    lora_r: int = Field(default=8, ge=1, le=256)
    lora_alpha: int = Field(default=16, ge=1, le=512)
    lora_dropout: float = Field(default=0.05, ge=0, le=0.9)
    target_modules: List[str] = Field(default_factory=lambda: ["q_proj", "v_proj"])


class ConfigIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_source: str = "corpus"
    model_id: Optional[str] = None
    base_ref: Optional[str] = None
    method: str = "sft"
    method_config: Dict[str, Any] = Field(default_factory=dict)
    training_config: Dict[str, Any] = Field(default_factory=lambda: {
        "learning_rate": 5e-5,
        "epochs": 1,
        "batch_size": 1,
        "gradient_accumulation_steps": 8,
        "max_seq_length": 512,
        "optimizer": "adamw_torch",
        "scheduler": "cosine",
        "warmup_ratio": 0.03,
        "weight_decay": 0.0,
        "gradient_clip": 1.0,
        "seed": 42,
    })
    dataset_id: Optional[str] = None
    load_weights: bool = False


def _iso(value) -> Optional[str]:
    return value.isoformat() if value else None


async def _owned_model(db: AsyncSession, model_id: str, owner_id: uuid.UUID) -> Model:
    row = (await db.execute(select(Model).where(
        Model.id == model_id, Model.owner_id == owner_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found for this account.")
    return row


async def _has_preference_pairs(db: AsyncSession, owner_id: uuid.UUID, dataset_id: Optional[str]) -> bool:
    """A DPO run needs real preference pairs, not just any dataset."""
    if not dataset_id:
        return False
    count = (await db.execute(text("""
        SELECT COUNT(*) FROM public.distillation_records r
        JOIN public.distillation_jobs j ON j.id = r.job_id
        WHERE j.student_dataset_id = :dataset_id AND j.owner_id = :owner_id
          AND r.status = 'accepted' AND COALESCE(r.rejected, '') <> ''
    """), {"dataset_id": dataset_id, "owner_id": owner_id})).scalar_one()
    return bool(count)


def _inspect_payload(inspection: Dict[str, Any], methods: Dict[str, Any],
                     lora: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        **inspection,
        "methods": methods,
        "lora_plan": lora,
        "method_catalogue": studio.METHODS,
    }


@router.get("/system", tags=["students"])
async def system_capabilities(user=Depends(require_user)):
    """Installed libraries, devices and the method matrix they allow."""
    libraries = studio.library_report()
    matrix = {
        "corpus": {method: studio.method_availability("corpus", method, libraries) for method in studio.METHODS},
        "huggingface": {method: studio.method_availability("huggingface", method, libraries) for method in studio.METHODS},
    }
    return {
        "libraries": libraries,
        "methods": studio.METHODS,
        "availability": matrix,
        "notes": [
            "LoRA/QLoRA apply to Hugging Face causal LMs only; the CORPUS engine keeps its own format.",
            "Nothing here is simulated: an unavailable method stays unavailable until the missing "
            "library or device is actually present.",
        ],
    }


@router.post("/inspect", tags=["students"])
async def inspect_model(body: InspectIn, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    libraries = studio.library_report()
    if body.base_source == "corpus":
        if not body.model_id:
            raise HTTPException(status_code=400, detail="Select one of your CORPUS models to inspect.")
        model = await _owned_model(db, body.model_id, owner_id)
        try:
            inspection = studio.inspect_corpus_model(model)
        except InspectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        methods = {method: studio.method_availability("corpus", method, libraries)
                   for method in studio.METHODS}
        return _inspect_payload(inspection, methods)

    if body.base_source in {"huggingface", "local"}:
        if not body.base_ref:
            raise HTTPException(status_code=400, detail="Provide the Hugging Face model ID to inspect.")
        try:
            inspection = studio.inspect_hf_model(body.base_ref, load_weights=body.load_weights,
                                                 token=body.hf_token)
        except InspectError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        methods = {method: studio.method_availability("huggingface", method, libraries)
                   for method in studio.METHODS}
        lora = studio.lora_plan(inspection["architecture"], {"lora_r": 8, "lora_alpha": 16,
                                                             "lora_dropout": 0.05,
                                                             "target_modules": ["q_proj", "v_proj"]})
        return _inspect_payload(inspection, methods, lora)

    raise HTTPException(status_code=400, detail="base_source must be 'corpus', 'huggingface' or 'local'.")


@router.post("/lora-plan", tags=["students"])
async def lora_plan(body: LoraPlanIn, user=Depends(require_user)):
    """Adapter-size estimate for a chosen rank and target modules."""
    if not body.architecture:
        raise HTTPException(status_code=400, detail="Send the inspected architecture to plan adapters.")
    return studio.lora_plan(body.architecture, body.model_dump(exclude={"architecture"}))


@router.get("/models", tags=["students"])
async def list_student_models(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """CORPUS models with their real checkpoints and last measured loss."""
    owner_id = uuid.UUID(user["user_id"])
    rows = (await db.execute(text("""
        SELECT m.id, m.name, m.status, m.version, m.config, m.tokenizer_ref, m.updated_at,
               (SELECT COUNT(*) FROM public.checkpoints c WHERE c.model_id = m.id) AS checkpoints,
               (SELECT MAX(c.step) FROM public.checkpoints c WHERE c.model_id = m.id) AS last_step,
               (SELECT c.loss FROM public.checkpoints c
                 WHERE c.model_id = m.id ORDER BY c.created_at DESC LIMIT 1) AS last_loss
        FROM public.models m
        WHERE m.owner_id = :owner_id
        ORDER BY m.updated_at DESC NULLS LAST
    """), {"owner_id": owner_id})).mappings().all()
    return {
        "models": [
            {
                "id": row["id"],
                "name": row["name"],
                "status": row["status"],
                "version": row["version"],
                "architecture": (row["config"] or {}),
                "checkpoints": int(row["checkpoints"] or 0),
                "last_step": row["last_step"],
                "last_loss": row["last_loss"],
                "has_tokenizer": bool(row["tokenizer_ref"]),
                "updated_at": _iso(row["updated_at"]),
                "base_source": "corpus",
                "family": "CORPUS engine",
            }
            for row in rows
        ],
        "note": "These are CORPUS-engine models. Hugging Face checkpoints are referenced by repo id, not stored here.",
    }


@router.post("/configs", tags=["students"], status_code=201)
async def create_config(body: ConfigIn, user=Depends(require_user),
                        db: AsyncSession = Depends(get_db_session)):
    """Inspect, gate the method on real availability, then persist the decision."""
    owner_id = uuid.UUID(user["user_id"])
    libraries = studio.library_report()
    if body.method not in studio.METHODS:
        raise HTTPException(status_code=400, detail=f"Unknown method '{body.method}'.")

    if body.base_source == "corpus":
        if not body.model_id:
            raise HTTPException(status_code=400, detail="Select a CORPUS model for a student config.")
        model = await _owned_model(db, body.model_id, owner_id)
        try:
            inspection = studio.inspect_corpus_model(model)
        except InspectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    elif body.base_source in {"huggingface", "local"}:
        if not body.base_ref:
            raise HTTPException(status_code=400, detail="Provide the Hugging Face model ID.")
        try:
            inspection = studio.inspect_hf_model(body.base_ref, load_weights=body.load_weights)
        except InspectError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    else:
        raise HTTPException(status_code=400, detail="base_source must be 'corpus', 'huggingface' or 'local'.")

    has_pairs = await _has_preference_pairs(db, owner_id, body.dataset_id)
    availability = studio.method_availability(
        inspection["base_source"], body.method, libraries, has_preference_pairs=has_pairs
    )
    if not availability["available"]:
        raise HTTPException(
            status_code=409,
            detail=f"Method '{body.method}' is not available for this model: " + " ".join(availability["reasons"]),
        )

    lora = None
    if body.method in {"lora", "qlora"}:
        if not body.method_config.get("target_modules"):
            raise HTTPException(status_code=400, detail="Choose at least one LoRA target module.")
        lora = studio.lora_plan(inspection["architecture"], body.method_config)

    config_id = "stc_" + uuid.uuid4().hex[:10]
    now = datetime.now(timezone.utc)
    row = StudentTrainingConfig(
        id=config_id,
        owner_id=owner_id,
        model_id=body.model_id,
        base_source=inspection["base_source"],
        base_ref=inspection.get("base_ref"),
        architecture=inspection["architecture"],
        method=body.method,
        method_config={**body.method_config, **(lora or {})},
        training_config=body.training_config,
        capability={
            "availability": availability,
            "method_catalogue": studio.METHODS,
            "libraries": libraries,
            "dataset_id": body.dataset_id,
            "has_preference_pairs": has_pairs,
            "checked_at": now.isoformat(),
        },
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _config_out(row)


def _config_out(row: StudentTrainingConfig) -> Dict[str, Any]:
    return {
        "id": row.id,
        "model_id": row.model_id,
        "base_source": row.base_source,
        "base_ref": row.base_ref,
        "architecture": row.architecture or {},
        "method": row.method,
        "method_config": row.method_config or {},
        "training_config": row.training_config or {},
        "capability": row.capability or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


@router.get("/configs", tags=["students"])
async def list_configs(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    rows = (await db.execute(select(StudentTrainingConfig).where(
        StudentTrainingConfig.owner_id == owner_id).order_by(
        StudentTrainingConfig.created_at.desc()))).scalars().all()
    return {"configs": [_config_out(row) for row in rows]}


@router.get("/configs/{config_id}", tags=["students"])
async def get_config(config_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    row = (await db.execute(select(StudentTrainingConfig).where(
        StudentTrainingConfig.id == config_id))).scalar_one_or_none()
    if row is None or row.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Student config not found for this account.")
    return _config_out(row)


@router.delete("/configs/{config_id}", tags=["students"])
async def delete_config(config_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    row = (await db.execute(select(StudentTrainingConfig).where(
        StudentTrainingConfig.id == config_id))).scalar_one_or_none()
    if row is None or row.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Student config not found for this account.")
    await db.delete(row)
    await db.commit()
    return {"ok": True, "config_id": config_id, "deleted": True}
