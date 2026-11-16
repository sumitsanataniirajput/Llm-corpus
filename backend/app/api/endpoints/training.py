"""CORPUS ULTIMATE — Training job endpoints.

Create, list, pause, resume, stop training jobs.
Real PyTorch and custom numerical engines are invoked here.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete

from app.dependencies import require_user, get_db_session
from app.core.models import TrainingJob

router = APIRouter()


class TrainingConfig(BaseModel):
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
    id: str
    owner_id: str
    model_id: Optional[str]
    status: str
    engine: str
    compute: str
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


def _job_to_out(job: TrainingJob) -> JobOut:
    return JobOut(
        id=job.id,
        owner_id=str(job.owner_id),
        model_id=job.model_id,
        status=job.status,
        engine=job.engine,
        compute=job.compute,
        created_at=job.created_at.isoformat(),
        updated_at=job.updated_at.isoformat(),
    )


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


@router.post("/", response_model=JobOut, tags=["training"])
async def create_job(config: TrainingConfig, background_tasks: BackgroundTasks, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    job_id = "job_" + uuid.uuid4().hex[:12]
    owner_id = uuid.UUID(user["user_id"])
    now = datetime.now(timezone.utc)
    job = TrainingJob(
        id=job_id,
        owner_id=owner_id,
        model_id=config.model_id,
        dataset_id=config.dataset_id,
        status="queued",
        engine=config.engine,
        compute=config.compute,
        config=config.model_dump(),
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    from app.services.training_worker import run_training_job
    background_tasks.add_task(run_training_job, job_id, str(owner_id))
    return _job_to_out(job)


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


@router.post("/{job_id}/pause", tags=["training"])
async def pause_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    job.status = "pausing"
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "status": job.status}


@router.post("/{job_id}/resume", tags=["training"])
async def resume_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    job.status = "running"
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "status": job.status}


@router.post("/{job_id}/stop", tags=["training"])
async def stop_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    job.status = "stopping"
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "status": job.status}


@router.get("/{job_id}/metrics", response_model=List[dict], tags=["training"])
async def list_metrics(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    # Metrics stored separately; return empty for now
    return []


@router.get("/{job_id}/logs", response_model=List[dict], tags=["training"])
async def list_logs(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    # Logs stored separately; return empty for now
    return []


@router.get("/checkpoints", tags=["training"])
async def list_checkpoints(model_id: Optional[str] = None, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    query = select(Checkpoint)
    if model_id:
        query = query.where(Checkpoint.model_id == model_id)
    query = query.where(Checkpoint.owner_id == owner_id)
    result = await db.execute(query)
    checkpoints = result.scalars().all()
    return [
        {
            "id": c.id,
            "model_id": c.model_id,
            "job_id": c.job_id,
            "storage_path": c.storage_path,
            "step": c.step,
            "loss": c.loss,
            "created_at": c.created_at.isoformat(),
        }
        for c in checkpoints
    ]


@router.post("/checkpoints", tags=["training"])
async def save_checkpoint(data: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    checkpoint_id = "ckpt_" + uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    checkpoint = Checkpoint(
        id=checkpoint_id,
        owner_id=owner_id,
        model_id=data.get("model_id"),
        job_id=data.get("job_id"),
        storage_path=data.get("storage_path", ""),
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
    from app.core.models import Checkpoint
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id)
    )
    checkpoint = result.scalar_one_or_none()
    if not checkpoint:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    if checkpoint.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {"ok": True, "checkpoint_id": checkpoint.id}


# WebSocket for real-time training progress
@router.websocket("/ws/{job_id}")
async def training_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            # Echo back as a mock metric for dev
            await websocket.send_json({
                "type": "training." + job_id,
                "event": "metric",
                "data": {"step": 0, "loss": 0.0},
            })
    except WebSocketDisconnect:
        pass
