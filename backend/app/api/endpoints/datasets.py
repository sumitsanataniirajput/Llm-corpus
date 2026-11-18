"""CORPUS ULTIMATE — Dataset endpoints.

CRUD, upload, preview, preprocessing, splitting for training datasets.
Persistent storage via SQLAlchemy; files are stored in private Supabase Storage.

Datasets carry their upload state so the Training page can tell whether a
dataset is actually usable:
    pending  — record created, no file stored yet
    uploaded — file stored in Supabase Storage (trainable)
    failed   — last upload attempt failed
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import asyncio
import uuid
import hashlib
import os
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, text

from app.dependencies import require_user, get_db_session
from app.services.text_extraction import (
    SUPPORTED_LABEL,
    DatasetTextError,
    extract_text,
    is_supported_format,
)
from app.core.models import Dataset
from app.config import settings

try:  # Supabase client is optional at import time so the API can boot without it.
    from supabase import create_client
except Exception:  # pragma: no cover - only hit when the SDK is missing
    create_client = None

router = APIRouter()

# Dataset statuses that can be used for training.
TRAINABLE_STATUSES = {"uploaded"}
# Statuses that explicitly cannot be trained on.
UNUSABLE_STATUSES = {"failed", "deleted"}


class DatasetIn(BaseModel):
    name: str
    format: str = "txt"
    size: int = 0


class DatasetUploadSessionIn(BaseModel):
    file_name: str
    content_type: Optional[str] = None


class DatasetUploadFinalizeIn(BaseModel):
    storage_path: str
    file_name: str


class DatasetOut(BaseModel):
    id: str
    owner_id: str
    name: str
    format: Optional[str]
    size: Optional[int]
    status: str
    token_count: Optional[int]
    created_at: str
    # File metadata from dataset_files (latest upload)
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    storage_path: Optional[str] = None
    uploaded_at: Optional[str] = None
    has_file: bool = False
    trainable: bool = False

    class Config:
        from_attributes = True


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _dataset_to_out(ds: Dataset, file_row: Optional[Any] = None) -> DatasetOut:
    file_name = None
    file_size = None
    storage_path = None
    uploaded_at = None
    if file_row is not None:
        file_name = file_row["file_name"]
        file_size = int(file_row["file_size"]) if file_row["file_size"] is not None else None
        storage_path = file_row["storage_path"]
        uploaded_at = _iso(file_row["uploaded_at"])
    has_file = file_row is not None
    trainable = has_file and ds.status not in UNUSABLE_STATUSES
    return DatasetOut(
        id=ds.id,
        owner_id=str(ds.owner_id),
        name=ds.name,
        format=ds.format,
        size=int(ds.size) if ds.size is not None else None,
        status=ds.status,
        token_count=int(ds.token_count) if ds.token_count is not None else None,
        created_at=ds.created_at.isoformat(),
        file_name=file_name,
        file_size=file_size,
        storage_path=storage_path,
        uploaded_at=uploaded_at,
        has_file=has_file,
        trainable=trainable,
    )


async def latest_files_for_owner(db: AsyncSession, owner_id: uuid.UUID) -> Dict[str, Any]:
    """Return {dataset_id: latest dataset_files row} for one owner.

    Only files belonging to the owner's own datasets are returned, so a caller
    can never see another account's storage path.
    """
    result = await db.execute(text("""
        SELECT DISTINCT ON (df.dataset_id)
               df.dataset_id, df.file_name, df.file_size, df.storage_path, df.uploaded_at
        FROM public.dataset_files df
        JOIN public.datasets d ON d.id = df.dataset_id
        WHERE d.owner_id = :owner_id
        ORDER BY df.dataset_id, df.uploaded_at DESC
    """), {"owner_id": owner_id})
    return {row["dataset_id"]: row for row in result.mappings().all()}


async def latest_file_for_dataset(db: AsyncSession, dataset_id: str, owner_id: uuid.UUID) -> Optional[Any]:
    """Return the newest stored file for one dataset owned by ``owner_id``."""
    result = await db.execute(text("""
        SELECT df.dataset_id, df.file_name, df.file_size, df.storage_path, df.uploaded_at
        FROM public.dataset_files df
        JOIN public.datasets d ON d.id = df.dataset_id
        WHERE df.dataset_id = :dataset_id AND d.owner_id = :owner_id
        ORDER BY df.uploaded_at DESC
        LIMIT 1
    """), {"dataset_id": dataset_id, "owner_id": owner_id})
    return result.mappings().first()


def _storage_client():
    """Create a Supabase Storage client (service role) or raise a clear error.

    Deliberately not cached: the client is cheap relative to a file transfer,
    and a process-wide cache would pin one configuration (and one connection
    pool) for the lifetime of the worker, which is wrong when the environment or
    the injected client changes. The expensive part — the transfer itself — is
    already moved off the event loop with asyncio.to_thread in the handlers.
    """
    if create_client is None:
        raise HTTPException(
            status_code=503,
            detail="Dataset storage is not available: the Supabase SDK is not installed on the backend.",
        )
    if not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(
            status_code=503,
            detail="Dataset storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY to the backend environment; never put it in the frontend.",
        )
    if not settings.SUPABASE_URL:
        raise HTTPException(status_code=503, detail="Dataset storage is not configured: SUPABASE_URL is missing.")
    try:
        return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    except Exception as exc:  # pragma: no cover - configuration specific
        raise HTTPException(status_code=503, detail=f"Could not initialise Supabase Storage client: {str(exc)[:200]}")


@router.get("", response_model=List[DatasetOut], include_in_schema=False)
@router.get("/", response_model=List[DatasetOut], tags=["datasets"])
async def list_datasets(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset)
        .where(Dataset.owner_id == owner_id)
        .order_by(Dataset.created_at.desc())
    )
    datasets = result.scalars().all()
    files = await latest_files_for_owner(db, owner_id)
    return [_dataset_to_out(d, files.get(d.id)) for d in datasets]


@router.post("", response_model=DatasetOut, include_in_schema=False)
@router.post("/", response_model=DatasetOut, tags=["datasets"])
async def create_dataset(data: DatasetIn, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Dataset name is required.")
    ds_id = "ds_" + uuid.uuid4().hex[:12]
    owner_id = uuid.UUID(user["user_id"])
    now = datetime.now(timezone.utc)
    ds = Dataset(
        id=ds_id,
        owner_id=owner_id,
        name=name,
        format=(data.format or "txt").lower(),
        size=data.size,
        # A record with no stored file is NOT ready for training.
        status="pending",
        token_count=0,
        created_at=now,
        updated_at=now,
    )
    db.add(ds)
    await db.commit()
    await db.refresh(ds)
    return _dataset_to_out(ds, None)


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
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    return _dataset_to_out(ds, file_row)


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
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    return _dataset_to_out(ds, file_row)


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

    # Collect stored object paths so they can be removed from private storage.
    paths_result = await db.execute(text(
        "SELECT storage_path FROM public.dataset_files WHERE dataset_id = :dataset_id"
    ), {"dataset_id": dataset_id})
    storage_paths = [row[0] for row in paths_result.all() if row[0]]

    await db.execute(delete(Dataset).where(Dataset.id == dataset_id))
    await db.commit()

    # Best-effort storage cleanup — the database row is the source of truth.
    if storage_paths and settings.SUPABASE_SERVICE_ROLE_KEY and create_client is not None:
        try:
            storage = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
            storage.storage.from_(settings.STORAGE_BUCKET).remove(storage_paths)
        except Exception:
            pass

    return {"ok": True, "dataset_id": dataset_id, "removed_files": len(storage_paths)}


@router.post("/{dataset_id}/upload-session", tags=["datasets"])
async def create_dataset_upload_session(
    dataset_id: str,
    data: DatasetUploadSessionIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Create a short-lived signed Storage token for a direct TUS upload.

    File bytes travel from the browser straight to Supabase Storage in resumable
    chunks; the Render API never buffers a multi-gigabyte multipart request.
    """
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    safe_name = os.path.basename((data.file_name or "").strip()).replace("\\", "_")
    if not safe_name or not is_supported_format(safe_name):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dataset file '{safe_name or 'unnamed'}'. Supported formats: {SUPPORTED_LABEL}.",
        )

    storage = _storage_client()
    bucket_api = storage.storage.from_(settings.STORAGE_BUCKET)
    object_path = f"{owner_id}/datasets/{dataset_id}/{uuid.uuid4().hex}_{safe_name}"
    try:
        # Supabase Python SDK 2.34.x exposes create_signed_upload_url(path);
        # its default is upsert=false, which is what this unique path requires.
        signed = await asyncio.to_thread(
            bucket_api.create_signed_upload_url,
            object_path,
        )
        if isinstance(signed, dict) and isinstance(signed.get("data"), dict):
            signed = signed["data"]
        token = signed.get("token") if isinstance(signed, dict) else getattr(signed, "token", None)
        if not token:
            raise RuntimeError("Supabase did not return a signed upload token.")
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not prepare a resumable Storage upload: {str(exc)[:250]}",
        ) from exc

    return {
        "ok": True,
        "bucket": settings.STORAGE_BUCKET,
        "storage_path": object_path,
        "token": token,
        "file_name": safe_name,
    }


@router.post("/{dataset_id}/complete", tags=["datasets"])
async def complete_dataset_upload(
    dataset_id: str,
    data: DatasetUploadFinalizeIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Verify a finished Storage object and attach it to the caller's dataset."""
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")

    safe_name = os.path.basename((data.file_name or "").strip()).replace("\\", "_")
    expected_prefix = f"{owner_id}/datasets/{dataset_id}/"
    if not safe_name or not is_supported_format(safe_name):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dataset file '{safe_name or 'unnamed'}'. Supported formats: {SUPPORTED_LABEL}.",
        )
    if not data.storage_path.startswith(expected_prefix) or not data.storage_path.endswith("_" + safe_name):
        raise HTTPException(status_code=403, detail="The upload path does not belong to this dataset.")

    storage = _storage_client()
    bucket_api = storage.storage.from_(settings.STORAGE_BUCKET)
    try:
        info = await asyncio.to_thread(bucket_api.info, data.storage_path)
        metadata = info.get("metadata") or {} if isinstance(info, dict) else {}
        raw_size = (info.get("size") if isinstance(info, dict) else None) or metadata.get("size")
        file_size = int(raw_size or 0)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Storage has not confirmed this upload yet: {str(exc)[:250]}",
        ) from exc
    if file_size <= 0:
        raise HTTPException(status_code=400, detail="The uploaded dataset is empty or not yet complete.")

    existing = await db.execute(
        text("SELECT id FROM public.dataset_files WHERE storage_path = :storage_path LIMIT 1"),
        {"storage_path": data.storage_path},
    )
    if not existing.first():
        await db.execute(text("""
            INSERT INTO public.dataset_files
            (id, dataset_id, storage_path, file_name, file_size, checksum)
            VALUES (:id, :dataset_id, :storage_path, :file_name, :file_size, NULL)
        """), {
            "id": str(uuid.uuid4()),
            "dataset_id": dataset_id,
            "storage_path": data.storage_path,
            "file_name": safe_name,
            "file_size": file_size,
        })

    ds.size = file_size
    ds.checksum = None
    ds.status = "uploaded"
    ds.format = os.path.splitext(safe_name)[1].lstrip(".").lower() or ds.format
    ds.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ds)
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    return {"ok": True, "file_name": safe_name, "file_size": file_size, "dataset": _dataset_to_out(ds, file_row)}


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
    # This legacy multipart route is intentionally small and bounded. The
    # browser's normal upload flow uses the direct resumable TUS endpoints above.
    contents = await file.read(settings.MAX_UPLOAD_SIZE + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded dataset file is empty.")
    if len(contents) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Use the resumable upload flow for files larger than 6 MB.",
        )
    safe_name = os.path.basename(file.filename or "").replace("\\", "_")
    if not is_supported_format(safe_name):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported dataset file '{safe_name or 'unnamed'}'. "
                f"Supported formats: {SUPPORTED_LABEL}."
            ),
        )
    storage = _storage_client()
    bucket_api = storage.storage.from_(settings.STORAGE_BUCKET)
    object_path = f"{owner_id}/datasets/{dataset_id}/{uuid.uuid4().hex}_{safe_name}"
    try:
        # The Supabase SDK is synchronous. Calling it directly inside this async
        # endpoint blocked the event loop for the whole transfer, so while one
        # large upload was in flight every other request (health checks, token
        # refreshes, dataset lists) stalled or timed out — which the UI reported
        # as "backend unavailable" and, on a 401, as being signed out. Run it in
        # a worker thread instead.
        await asyncio.to_thread(
            bucket_api.upload,
            object_path,
            contents,
            file_options={"content-type": file.content_type or "text/plain", "upsert": "false"},
        )
    except Exception as exc:
        existing_file = await latest_file_for_dataset(db, dataset_id, owner_id)
        if not existing_file:
            ds.status = "failed"
            ds.updated_at = datetime.now(timezone.utc)
            await db.commit()
        raise HTTPException(status_code=502, detail=f"Could not persist dataset to Supabase Storage: {str(exc)[:300]}")
    checksum = hashlib.sha256(contents).hexdigest()
    try:
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
        extension = os.path.splitext(safe_name)[1].lstrip(".").lower()
        if extension:
            ds.format = extension
        ds.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(ds)
    except Exception as exc:
        # The bytes are in storage but the metadata write failed. Remove the
        # object so private storage never accumulates uploads the database does
        # not know about, and mark the dataset failed so the UI stops calling it
        # ready.
        await db.rollback()
        try:
            await asyncio.to_thread(bucket_api.remove, [object_path])
        except Exception:  # pragma: no cover - cleanup is best effort
            pass
        try:
            await db.execute(text("""
                UPDATE public.datasets SET status = 'failed', updated_at = now()
                WHERE id = :dataset_id AND owner_id = :owner_id
                  AND NOT EXISTS (SELECT 1 FROM public.dataset_files WHERE dataset_id = :dataset_id)
            """), {"dataset_id": dataset_id, "owner_id": str(owner_id)})
            await db.commit()
        except Exception:  # pragma: no cover - never mask the original failure
            await db.rollback()
        raise HTTPException(
            status_code=500,
            detail=(
                "The file was stored but the dataset record could not be updated, "
                f"so the upload was rolled back: {str(exc)[:300]}"
            ),
        )
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    return {
        "ok": True,
        "dataset": _dataset_to_out(ds, file_row).model_dump(),
        "dataset_id": dataset_id,
        "size": len(contents),
        "storage_path": object_path,
        "file_name": safe_name,
        "checksum": checksum,
    }


@router.get("/{dataset_id}/preview", tags=["datasets"])
async def preview_dataset(
    dataset_id: str,
    max_chars: int = Query(2000, ge=200, le=20000),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Return a real text preview of the dataset's stored file.

    Reads the newest uploaded object from private Supabase Storage. No synthetic
    or cached content is returned — the bytes come from the stored file.
    """
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(Dataset).where(Dataset.id == dataset_id)
    )
    ds = result.scalar_one_or_none()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if ds.owner_id != owner_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    if not file_row:
        raise HTTPException(status_code=400, detail="This dataset has no uploaded file yet. Upload a file in Dataset Manager first.")

    storage = _storage_client()
    try:
        bucket_api = storage.storage.from_(settings.STORAGE_BUCKET)
        raw = await asyncio.to_thread(bucket_api.download, file_row["storage_path"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not read the stored dataset file: {str(exc)[:300]}")
    if isinstance(raw, dict):
        raw = raw.get("data", b"")
    if isinstance(raw, str):
        raw = raw.encode("utf-8", errors="replace")
    if not raw:
        raise HTTPException(status_code=400, detail="The stored dataset file is empty or could not be downloaded.")

    try:
        text_data = extract_text(raw, file_row["file_name"])
    except DatasetTextError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    preview = text_data[:max_chars]
    return {
        "dataset_id": dataset_id,
        "file_name": file_row["file_name"],
        "file_size": int(file_row["file_size"]) if file_row["file_size"] is not None else len(raw),
        "total_characters": len(text_data),
        "total_lines": text_data.count("\n") + (0 if text_data.endswith("\n") else 1) if text_data else 0,
        "truncated": len(text_data) > max_chars,
        "preview": preview,
    }


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
