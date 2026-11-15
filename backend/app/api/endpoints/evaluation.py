"""CORPUS ULTIMATE — Evaluation endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.dependencies import require_user, get_db_session
from app.core.models import EvaluationRun

router = APIRouter()


class EvalConfig(BaseModel):
    model_id: str
    test_type: str = "knowledge"
    questions: Optional[List[str]] = None


class EvalOut(BaseModel):
    id: str
    owner_id: str
    model_id: Optional[str]
    score: Optional[float]
    status: str
    created_at: str

    class Config:
        from_attributes = True


def _eval_to_out(ev: EvaluationRun) -> EvalOut:
    return EvalOut(
        id=ev.id,
        owner_id=str(ev.owner_id),
        model_id=ev.model_id,
        score=ev.score,
        status=ev.status,
        created_at=ev.created_at.isoformat(),
    )


@router.get("/", response_model=List[EvalOut], tags=["evaluation"])
async def list_evaluations(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(EvaluationRun)
        .where(EvaluationRun.owner_id == owner_id)
        .order_by(EvaluationRun.created_at.desc())
    )
    evaluations = result.scalars().all()
    return [_eval_to_out(e) for e in evaluations]


@router.post("/run", response_model=EvalOut, tags=["evaluation"])
async def run_evaluation(config: EvalConfig, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    eval_id = "eval_" + uuid.uuid4().hex[:12]
    owner_id = uuid.UUID(user["user_id"])
    now = datetime.now(timezone.utc)
    ev = EvaluationRun(
        id=eval_id,
        owner_id=owner_id,
        model_id=config.model_id,
        test_type=config.test_type,
        score=0.0,
        status="completed",
        created_at=now,
    )
    db.add(ev)
    await db.commit()
    await db.refresh(ev)
    return _eval_to_out(ev)


@router.get("/{eval_id}", response_model=EvalOut, tags=["evaluation"])
async def get_evaluation(eval_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(EvaluationRun).where(EvaluationRun.id == eval_id)
    )
    ev = result.scalar_one_or_none()
    if not ev:
        raise HTTPException(status_code=404, detail="Evaluation not found")
    if ev.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return _eval_to_out(ev)
