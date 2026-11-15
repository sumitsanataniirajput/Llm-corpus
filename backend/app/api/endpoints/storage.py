"""CORPUS ULTIMATE — Storage endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.dependencies import require_user, get_db_session
from app.core.models import StorageObject

router = APIRouter()


class StorageObjectOut(BaseModel):
    id: str
    owner_id: str
    bucket: str
    path: str
    file_name: Optional[str]
    file_size: Optional[int]
    mime_type: Optional[str]
    created_at: str

    class Config:
        from_attributes = True


def _object_to_out(obj: StorageObject) -> StorageObjectOut:
    return StorageObjectOut(
        id=obj.id,
        owner_id=str(obj.owner_id),
        bucket=obj.bucket,
        path=obj.path,
        file_name=obj.file_name,
        file_size=int(obj.file_size) if obj.file_size is not None else None,
        mime_type=obj.mime_type,
        created_at=obj.created_at.isoformat(),
    )


@router.get("/objects", tags=["storage"])
async def list_objects(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(StorageObject)
        .where(StorageObject.owner_id == owner_id)
        .order_by(StorageObject.created_at.desc())
    )
    objects = result.scalars().all()
    return [_object_to_out(o) for o in objects]


@router.get("/objects/{object_id}", tags=["storage"])
async def get_object(object_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(StorageObject).where(StorageObject.id == object_id)
    )
    obj = result.scalar_one_or_none()
    if not obj:
        raise HTTPException(status_code=404, detail="Object not found")
    if obj.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return _object_to_out(obj)


@router.get("/objects/{object_id}/download", tags=["storage"])
async def download_object(object_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(StorageObject).where(StorageObject.id == object_id)
    )
    obj = result.scalar_one_or_none()
    if not obj:
        raise HTTPException(status_code=404, detail="Object not found")
    if obj.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {
        "id": obj.id,
        "bucket": obj.bucket,
        "path": obj.path,
        "file_name": obj.file_name,
        "message": "Use Supabase signed URL for download",
    }
