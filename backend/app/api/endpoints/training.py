"""CORPUS ULTIMATE — Training job endpoints.

Create, list, pause, resume, stop training jobs, and stream job progress.
Every job must reference a model and a dataset owned by the caller. The
dataset must have a file in private Supabase Storage, otherwise the request is
rejected up-front instead of creating a job that is guaranteed to fail.

Real PyTorch and custom numerical engines are invoked by the worker.
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from app.dependencies import require_user, get_db_session, verify_supabase_token
from app.core.database import get_session_factory
from app.core.models import Dataset, Model, TrainingJob
from app.api.endpoints.datasets import latest_file_for_dataset, UNUSABLE_STATUSES

router = APIRouter()

# Terminal training states — the progress socket closes once one is reached.
TERMINAL_STATUSES = {"completed", "failed", "stopped", "cancelled"}

SELECT_DATASET_MESSAGE = "Select a dataset before starting training."


class TrainingConfig(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    dataset_id: Optional[str] = None
    engine: str = "pytorch"
    compute: str = "local"
    batch_size: int = 16
    learning_rate: float = 0.001
    epochs: int = 10
    gradient_accumulation_steps: int = 1
    gradient_clip: float = 1.0
    seed: int = 42


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: str
    owner_id: str
    model_id: Optional[str]
    dataset_id: Optional[str]
    status: str
    engine: str
    compute: str
    created_at: str
    updated_at: str


def _job_to_out(job: TrainingJob) -> JobOut:
    return JobOut(
        id=job.id,
        owner_id=str(job.owner_id),
        model_id=job.model_id,
        dataset_id=job.dataset_id,
        status=job.status,
        engine=job.engine,
        compute=job.compute,
        created_at=job.created_at.isoformat(),
        updated_at=job.updated_at.isoformat(),
    )


async def resolve_training_resources(
    db: AsyncSession,
    owner_id: uuid.UUID,
    model_id: str,
    dataset_id: Optional[str],
):
    """Validate that the caller can actually train with this model + dataset.

    Returns ``(model, dataset, file_row)`` on success. Raises ``HTTPException``
    with a clear, user-facing message otherwise — this is what stops jobs from
    being created with ``dataset_id = null`` or with an unusable dataset.
    """
    dataset_id = (dataset_id or "").strip()
    model_id = (model_id or "").strip()

    if not dataset_id:
        raise HTTPException(status_code=400, detail=SELECT_DATASET_MESSAGE)
    if not model_id:
        raise HTTPException(status_code=400, detail="Select a model before starting training.")

    dataset_result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id, Dataset.owner_id == owner_id)
    )
    dataset = dataset_result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(
            status_code=404,
            detail="Dataset not found for this account. Refresh the dataset list and select one of your own datasets.",
        )

    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    if not file_row:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Dataset '{dataset.name}' has no uploaded file yet. "
                "Upload a dataset file in Dataset Manager, then select it here."
            ),
        )
    if dataset.status in UNUSABLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Dataset '{dataset.name}' is {dataset.status} and cannot be used for training.",
        )

    model_result = await db.execute(
        select(Model).where(Model.id == model_id, Model.owner_id == owner_id)
    )
    model = model_result.scalar_one_or_none()
    if not model:
        raise HTTPException(
            status_code=404,
            detail="Model not found for this account. Refresh the model list and select one of your own models.",
        )

    return model, dataset, file_row


@router.get("", response_model=List[JobOut], include_in_schema=False)
@router.get("/", response_model=List[JobOut], tags=["training"])
async def list_jobs(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob)
        .where(TrainingJob.owner_id == owner_id)
        .order_by(TrainingJob.created_at.desc())
    )
    jobs = result.scalars().all()
    return [_job_to_out(j) for j in jobs]


@router.post("", response_model=JobOut, include_in_schema=False)
@router.post("/", response_model=JobOut, tags=["training"])
async def create_job(config: TrainingConfig, background_tasks: BackgroundTasks, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    model, dataset, _file_row = await resolve_training_resources(
        db, owner_id, config.model_id, config.dataset_id
    )
    job_id = "job_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    job_config = config.model_dump()
    job_config["model_id"] = model.id
    job_config["dataset_id"] = dataset.id
    job = TrainingJob(
        id=job_id,
        owner_id=owner_id,
        model_id=model.id,
        dataset_id=dataset.id,
        status="queued",
        engine=config.engine,
        compute=config.compute,
        config=job_config,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    from app.services.training_worker import run_training_job
    background_tasks.add_task(run_training_job, job_id, str(owner_id))
    return _job_to_out(job)


@router.get("/checkpoints", tags=["training"])
async def list_checkpoints(model_id: Optional[str] = None, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List checkpoints only through models owned by the authenticated user.

    The production checkpoints table has no owner_id column. Ownership is
    inherited from the parent model, and the join enforces that boundary in
    the database query itself.
    """
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    query = (
        select(Checkpoint)
        .join(Model, Checkpoint.model_id == Model.id)
        .where(Model.owner_id == owner_id)
    )
    if model_id:
        query = query.where(Checkpoint.model_id == model_id)
    result = await db.execute(query.order_by(Checkpoint.created_at.desc()))
    checkpoints = result.scalars().all()
    return [
        {
            "id": c.id,
            "model_id": c.model_id,
            "job_id": c.job_id,
            "storage_path": c.storage_path,
            "step": c.step,
            "loss": c.loss,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in checkpoints
    ]


@router.post("/checkpoints", tags=["training"])
async def save_checkpoint(data: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Save a checkpoint against a model owned by the caller."""
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    model_id = str(data.get("model_id") or "").strip()
    if not model_id:
        raise HTTPException(status_code=400, detail="model_id is required for a checkpoint.")

    model_result = await db.execute(select(Model).where(Model.id == model_id))
    model = model_result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    if model.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    job_id = data.get("job_id")
    if job_id:
        job_result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
        job = job_result.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Training job not found")
        if job.owner_id != owner_id:
            raise HTTPException(status_code=403, detail="Not authorized")
        if job.model_id != model_id:
            raise HTTPException(status_code=400, detail="The checkpoint job does not belong to the selected model.")

    storage_path = str(data.get("storage_path") or "").strip()
    if not storage_path:
        raise HTTPException(status_code=400, detail="storage_path is required.")

    checkpoint_id = "ckpt_" + uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    checkpoint = Checkpoint(
        id=checkpoint_id,
        model_id=model_id,
        job_id=job_id,
        storage_path=storage_path,
        step=data.get("step"),
        loss=data.get("loss"),
        created_at=now,
    )
    db.add(checkpoint)
    await db.commit()
    await db.refresh(checkpoint)
    return {"ok": True, "checkpoint_id": checkpoint.id}


@router.post("/checkpoints/{checkpoint_id}/load", tags=["training"])
async def load_checkpoint(checkpoint_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Authorize checkpoint access through the owning model."""
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Checkpoint, Model)
        .join(Model, Checkpoint.model_id == Model.id)
        .where(Checkpoint.id == checkpoint_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    checkpoint, model = row
    if model.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {"ok": True, "checkpoint_id": checkpoint.id}


@router.get("/{job_id}", response_model=JobOut, tags=["training"])
async def get_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return _job_to_out(job)


async def _get_owned_job(db: AsyncSession, job_id: str, owner_id: uuid.UUID) -> TrainingJob:
    result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return job


async def _set_job_status(db: AsyncSession, job_id: str, owner_id: uuid.UUID, status: str) -> str:
    job = await _get_owned_job(db, job_id, owner_id)
    job.status = status
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return job.status


@router.post("/{job_id}/pause", tags=["training"])
async def pause_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    status = await _set_job_status(db, job_id, owner_id, "pausing")
    return {"ok": True, "status": status}


@router.post("/{job_id}/resume", tags=["training"])
async def resume_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    status = await _set_job_status(db, job_id, owner_id, "running")
    return {"ok": True, "status": status}


@router.post("/{job_id}/stop", tags=["training"])
async def stop_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    from app.services import training_worker
    job = await _get_owned_job(db, job_id, owner_id)
    signaled = training_worker.request_job_stop(job_id)
    next_status = "stopping" if (signaled or job.status == "running") else "stopped"
    job.status = next_status
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "status": job.status, "signaled": signaled}


@router.get("/{job_id}/metrics", response_model=List[dict], tags=["training"])
async def list_metrics(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_owned_job(db, job_id, owner_id)
    # Reference the job so ownership is checked before reading metrics.
    _ = job.id
    result = await db.execute(text("""
        SELECT step, loss, learning_rate, tokens_per_second, created_at
        FROM public.training_metrics WHERE job_id = :job_id ORDER BY step ASC
    """), {"job_id": job_id})
    return [dict(row) for row in result.mappings().all()]


@router.get("/{job_id}/logs", response_model=List[dict], tags=["training"])
async def list_logs(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_owned_job(db, job_id, owner_id)
    _ = job.id
    result = await db.execute(text("""
        SELECT event, data, created_at
        FROM public.training_job_events WHERE job_id = :job_id
        ORDER BY created_at ASC
    """), {"job_id": job_id})
    return [dict(row) for row in result.mappings().all()]


# ---------------------------------------------------------------------------
# Real-time progress socket
# ---------------------------------------------------------------------------
@router.websocket("/ws/{job_id}")
async def training_ws(
    websocket: WebSocket,
    job_id: str,
    token: Optional[str] = Query(default=None),
    interval: float = Query(default=1.5, ge=0.5, le=10.0),
):
    """Stream real job status and real metric rows for one training job.

    The token is passed as a query parameter because browsers cannot set an
    Authorization header on WebSocket connections. Every message is read from
    the database — nothing is simulated. The socket closes once the job reaches
    a terminal state.
    """
    user = None
    if token:
        try:
            user = await verify_supabase_token(token)
        except HTTPException:
            user = None
    if not user or not user.get("id"):
        await websocket.close(code=1008)
        return

    try:
        owner_id = uuid.UUID(user["id"])
    except (ValueError, TypeError):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    last_step = 0
    last_status = None
    subscription = "training." + job_id
    try:
        while True:
            factory = get_session_factory()
            async with factory() as db:
                result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
                job = result.scalar_one_or_none()
                if not job or job.owner_id != owner_id:
                    await websocket.send_json({
                        "type": subscription, "event": "error",
                        "data": {"message": "Training job not found for this account."},
                    })
                    await websocket.close(code=1008)
                    return

                if job.status != last_status:
                    last_status = job.status
                    await websocket.send_json({
                        "type": subscription, "event": "status",
                        "data": {
                            "job_id": job.id,
                            "status": job.status,
                            "dataset_id": job.dataset_id,
                            "model_id": job.model_id,
                            "updated_at": job.updated_at.isoformat(),
                        },
                    })

                metrics_result = await db.execute(text("""
                    SELECT step, loss, learning_rate, tokens_per_second
                    FROM public.training_metrics
                    WHERE job_id = :job_id AND step > :last_step
                    ORDER BY step ASC
                """), {"job_id": job_id, "last_step": last_step})
                for row in metrics_result.mappings().all():
                    last_step = int(row["step"])
                    await websocket.send_json({
                        "type": subscription, "event": "metric",
                        "data": {
                            "job_id": job_id,
                            "step": int(row["step"]),
                            "loss": float(row["loss"]) if row["loss"] is not None else None,
                            "learning_rate": float(row["learning_rate"]) if row["learning_rate"] is not None else None,
                            "tokens_per_second": float(row["tokens_per_second"]) if row["tokens_per_second"] is not None else None,
                        },
                    })

                if job.status in TERMINAL_STATUSES:
                    events_result = await db.execute(text("""
                        SELECT event, data FROM public.training_job_events
                        WHERE job_id = :job_id ORDER BY created_at DESC LIMIT 1
                    """), {"job_id": job_id})
                    event_row = events_result.mappings().first()
                    payload = {
                        "job_id": job_id,
                        "status": job.status,
                        "event": event_row["event"] if event_row else job.status,
                        "data": event_row["data"] if event_row else None,
                    }
                    await websocket.send_json({
                        "type": subscription,
                        "event": "complete" if job.status == "completed" else "error",
                        "data": payload,
                    })
                    await websocket.close()
                    return

            await asyncio.sleep(interval)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
