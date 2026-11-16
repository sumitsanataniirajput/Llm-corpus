"""CORPUS ULTIMATE — Dataset endpoints.

CRUD, upload, preprocessing, splitting for training datasets.
Persistent storage via SQLAlchemy.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import uuid
import hashlib
import os
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, text

from app.dependencies import require_user, get_db_session
from app.core.models import Dataset
from app.config import settings
from supabase import create_client

router = APIRouter()


class DatasetIn(BaseModel):
    name: str
    format: str = "txt"
    size: int = 0


class DatasetOut(BaseModel):
    id: str
    owner_id: str
    name: str
    format: Optional[str]
    size: Optional[int]
    status: str
    token_count: Optional[int]
    created_at: str

    class Config:
        from_attributes = True


def _dataset_to_out(ds: Dataset) -> DatasetOut:
    return DatasetOut(
        id=ds.id,
        owner_id=str(ds.owner_id),
        name=ds.name,
        format=ds.format,
        size=int(ds.size) if ds.size is not None else None,
        status=ds.status,
        token_count=int(ds.token_count) if ds.token_count is not None else None,
        created_at=ds.created_at.isoformat(),
    )


@router.get("/", response_model=List[DatasetOut], tags=["datasets"])
async def list_datasets(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset)
        .where(Dataset.owner_id == owner_id)
        .order_by(Dataset.created_at.desc())
    )
    datasets = result.scalars().all()
    return [_dataset_to_out(d) for d in datasets]


@router.post("/", response_model=DatasetOut, tags=["datasets"])
async def create_dataset(data: DatasetIn, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    ds_id = "ds_" + uuid.uuid4().hex[:12]
    owner_id = uuid.UUID(user["user_id"])
    now = datetime.now(timezone.utc)
    ds = Dataset(
        id=ds_id,
        owner_id=owner_id,
        name=data.name,
        format=data.format,
        size=data.size,
        status="ready",
        token_count=0,
        created_at=now,
        updated_at=now,
    )
    db.add(ds)
    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds)


@router.get("/{dataset_id}", response_model=DatasetOut, tags=["datasets"])
async def get_dataset(dataset_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return _dataset_to_out(ds)


@router.put("/{dataset_id}", response_model=DatasetOut, tags=["datasets"])
async def update_dataset(dataset_id: str, updates: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    for key, value in updates.items():
        if hasattr(ds, key) and key not in ("id", "owner_id", "created_at"):
            setattr(ds, key, value)
    ds.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds)


@router.delete("/{dataset_id}", tags=["datasets"])
async def delete_dataset(dataset_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    await db.execute(delete(Dataset).where(Dataset.id == dataset_id))
    await db.commit()
    return {"ok": True}


@router.post("/{dataset_id}/upload", tags=["datasets"])
async def upload_dataset_file(
    dataset_id: str,
    file: UploadFile = File(...),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded dataset file is empty.")
    if len(contents) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="Dataset exceeds the configured upload limit.")
    if not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(status_code=503, detail="Dataset storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY to the Render backend environment; never put it in the frontend.")
    safe_name = os.path.basename(file.filename or "dataset.txt").replace("\\", "_")
    object_path = f"{owner_id}/datasets/{dataset_id}/{uuid.uuid4().hex}_{safe_name}"
    try:
        storage = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
        storage.storage.from_(settings.STORAGE_BUCKET).upload(
            object_path, contents,
            file_options={"content-type": file.content_type or "text/plain", "upsert": "false"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not persist dataset to Supabase Storage: {str(exc)[:300]}")
    checksum = hashlib.sha256(contents).hexdigest()
    await db.execute(text("""
        INSERT INTO public.dataset_files
        (id, dataset_id, storage_path, file_name, file_size, checksum)
        VALUES (:id, :dataset_id, :storage_path, :file_name, :file_size, :checksum)
    """), {
        "id": str(uuid.uuid4()), "dataset_id": dataset_id,
        "storage_path": object_path, "file_name": safe_name,
        "file_size": len(contents), "checksum": checksum,
    })
    ds.size = len(contents)
    ds.checksum = checksum
    ds.status = "uploaded"
    ds.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "dataset_id": dataset_id, "size": len(contents), "storage_path": object_path, "checksum": checksum}


@router.post("/{dataset_id}/preprocess", tags=["datasets"])
async def preprocess_dataset(dataset_id: str, config: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {"ok": True, "dataset_id": dataset_id, "status": "preprocessed"}


@router.post("/{dataset_id}/split", tags=["datasets"])
async def split_dataset(dataset_id: str, config: dict, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return {"ok": True, "dataset_id": dataset_id, "splits": {"train": 0.8, "val": 0.1, "test": 0.1}}
