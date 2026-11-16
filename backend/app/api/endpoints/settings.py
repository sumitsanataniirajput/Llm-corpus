"""CORPUS ULTIMATE — Settings endpoints.

Real API key management with cryptographic key generation,
secure hashing, and database persistence.

API keys are returned in full only once. The backend persists a SHA-256 digest
in api_keys_metadata.key_hash; the raw API key is never stored.
"""
import hashlib
import secrets
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, update

from app.dependencies import require_user, get_db_session
from app.core.models import ApiKey

router = APIRouter()


class SettingsIn(BaseModel):
    theme: str = "dark"
    notifications: bool = True


class ApiKeyCreate(BaseModel):
    name: str


class ApiKeyOut(BaseModel):
    id: str
    name: str
    prefix: str
    created_at: str
    last_used: Optional[str] = None
    revoked: bool

    class Config:
        from_attributes = True


class ApiKeyCreated(ApiKeyOut):
    """Returned only once after creation — includes the full key."""
    key: str


@router.get("", include_in_schema=False)
@router.get("/", tags=["settings"])
async def get_settings(user=Depends(require_user)):
    return {"theme": "dark", "notifications": True}


@router.put("", include_in_schema=False)
@router.put("/", tags=["settings"])
async def update_settings(data: SettingsIn, user=Depends(require_user)):
    return {"ok": True, "theme": data.theme, "notifications": data.notifications}


def _generate_api_key() -> str:
    """Generate a cryptographically secure random API key."""
    return "corpus_" + secrets.token_urlsafe(32)


def _hash_key(key: str) -> str:
    """Hash an API key for secure storage (SHA-256)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _key_prefix(key: str) -> str:
    """Return a safe display prefix (first 8 chars after 'corpus_')."""
    body = key.replace("corpus_", "", 1)
    return "corpus_" + body[:8]


@router.get("/api-keys", tags=["settings"])
async def list_api_keys(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """List API keys owned by the current user (without revealing full key values)."""
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(ApiKey)
        .where(ApiKey.owner_id == owner_id)
        .where(ApiKey.revoked == False)  # noqa: E712
        .order_by(ApiKey.created_at.desc())
    )
    keys = result.scalars().all()
    return {
        "keys": [
            {
                "id": k.id,
                "name": k.name,
                "prefix": k.prefix,
                "created_at": k.created_at.isoformat(),
                "last_used": k.last_used.isoformat() if k.last_used else None,
                "revoked": k.revoked,
            }
            for k in keys
        ]
    }


@router.post("/api-keys", tags=["settings"])
async def create_api_key(data: ApiKeyCreate, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Create a new API key, persist only its SHA-256 digest, and return it once."""
    full_key = _generate_api_key()
    key_prefix = _key_prefix(full_key)
    now = datetime.now(timezone.utc)
    owner_id = uuid.UUID(user["user_id"])

    api_key = ApiKey(
        id="key_" + uuid.uuid4().hex[:12],
        owner_id=owner_id,
        name=data.name or "Unnamed key",
        prefix=key_prefix,
        key_hash=_hash_key(full_key),
        created_at=now,
        last_used=None,
        revoked=False,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    return {
        "id": api_key.id,
        "name": api_key.name,
        "prefix": api_key.prefix,
        "key": full_key,  # Full key returned only once — not stored
        "created_at": api_key.created_at.isoformat(),
        "revoked": api_key.revoked,
    }


@router.delete("/api-keys/{key_id}", tags=["settings"])
async def revoke_api_key(key_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Revoke an API key owned by the current user."""
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id).where(ApiKey.owner_id == owner_id)
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")
    if api_key.revoked:
        raise HTTPException(status_code=400, detail="API key already revoked")

    api_key.revoked = True
    await db.commit()
    return {"ok": True, "id": api_key.id}
