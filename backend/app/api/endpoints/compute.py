"""CORPUS ULTIMATE — Compute / worker endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.dependencies import require_user, verify_worker_secret, get_db_session
from app.core.models import ComputeWorker

router = APIRouter()


class WorkerRegister(BaseModel):
    name: str
    os: str
    cpu: str
    ram: int
    # Worker registration uses a shared infrastructure secret, not a user JWT.
    # The trusted registrar must therefore state which account owns the worker;
    # the old code wrote a nil-UUID "system owner" that no account could see.
    owner_id: str
    gpu: Optional[str] = None
    vram: Optional[int] = None
    backend: str = "cpu"

    @field_validator("owner_id")
    @classmethod
    def validate_owner_id(cls, value: str) -> str:
        try:
            owner = uuid.UUID(value)
        except (TypeError, ValueError):
            raise ValueError("owner_id must be a UUID for the account that owns this worker")
        if owner == uuid.UUID("00000000-0000-0000-0000-000000000000"):
            raise ValueError("owner_id cannot be the nil UUID")
        return str(owner)


class WorkerOut(BaseModel):
    id: str
    owner_id: str
    name: str
    status: str
    last_heartbeat: Optional[str]

    class Config:
        from_attributes = True


def _worker_to_out(w: ComputeWorker) -> WorkerOut:
    return WorkerOut(
        id=w.id,
        owner_id=str(w.owner_id),
        name=w.name,
        status=w.status,
        last_heartbeat=w.last_heartbeat.isoformat() if w.last_heartbeat else None,
    )


@router.get("/workers", response_model=List[WorkerOut], tags=["compute"])
async def list_workers(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(ComputeWorker)
        .where(ComputeWorker.owner_id == owner_id)
        .order_by(ComputeWorker.created_at.desc())
    )
    workers = result.scalars().all()
    return [_worker_to_out(w) for w in workers]


@router.post("/workers/register", response_model=WorkerOut, tags=["compute"])
async def register_worker(data: WorkerRegister, secret=Depends(verify_worker_secret), db: AsyncSession = Depends(get_db_session)):
    # Worker registration uses the shared worker secret, not a user JWT. The
    # trusted registrar supplies the owning account explicitly; we never invent
    # a nil-UUID "system owner" that would make the worker invisible to every
    # account and misrepresent ownership in the database.
    worker_id = "worker_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)
    worker = ComputeWorker(
        id=worker_id,
        owner_id=uuid.UUID(data.owner_id),
        name=data.name,
        os=data.os,
        cpu=data.cpu,
        ram=data.ram,
        gpu=data.gpu,
        vram=data.vram,
        backend=data.backend,
        status="online",
        last_heartbeat=now,
        created_at=now,
    )
    db.add(worker)
    await db.commit()
    await db.refresh(worker)
    return _worker_to_out(worker)


@router.post("/workers/{worker_id}/heartbeat", tags=["compute"])
async def worker_heartbeat(worker_id: str, data: dict, secret=Depends(verify_worker_secret), db: AsyncSession = Depends(get_db_session)):
    result = await db.execute(
        select(ComputeWorker).where(ComputeWorker.id == worker_id)
    )
    worker = result.scalar_one_or_none()
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")
    worker.last_heartbeat = datetime.now(timezone.utc)
    worker.status = "online"
    await db.commit()
    return {"ok": True}
