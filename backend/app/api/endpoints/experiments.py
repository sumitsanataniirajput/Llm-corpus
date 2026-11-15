"""CORPUS ULTIMATE — Experiment endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.dependencies import require_user, get_db_session
from app.core.models import Experiment

router = APIRouter()


class ExperimentIn(BaseModel):
    name: str
    description: Optional[str] = None


class ExperimentOut(BaseModel):
    id: str
    owner_id: str
    name: str
    description: Optional[str]
    status: str
    created_at: str

    class Config:
        from_attributes = True


def _experiment_to_out(exp: Experiment) -> ExperimentOut:
    return ExperimentOut(
        id=exp.id,
        owner_id=str(exp.owner_id),
        name=exp.name,
        description=exp.description,
        status=exp.status,
        created_at=exp.created_at.isoformat(),
    )


@router.get("/", response_model=List[ExperimentOut], tags=["experiments"])
async def list_experiments(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Experiment)
        .where(Experiment.owner_id == owner_id)
        .order_by(Experiment.created_at.desc())
    )
    experiments = result.scalars().all()
    return [_experiment_to_out(e) for e in experiments]


@router.post("/", response_model=ExperimentOut, tags=["experiments"])
async def create_experiment(data: ExperimentIn, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    eid = "exp_" + uuid.uuid4().hex[:12]
    owner_id = uuid.UUID(user["user_id"])
    now = datetime.now(timezone.utc)
    exp = Experiment(
        id=eid,
        owner_id=owner_id,
        name=data.name,
        description=data.description,
        status="active",
        created_at=now,
        updated_at=now,
    )
    db.add(exp)
    await db.commit()
    await db.refresh(exp)
    return _experiment_to_out(exp)
