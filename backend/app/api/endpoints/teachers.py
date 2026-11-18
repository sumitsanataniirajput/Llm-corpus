"""AI Teacher Network — provider connections, teacher models, usage and budgets.

Security contract for everything in this module:

* The API key travels **from** the browser once, is encrypted with AES-256-GCM
  immediately, and is never returned. Responses carry only ``credential_hint``
  (last four characters) and a short non-reversible fingerprint.
* No endpoint returns ``credential_ciphertext``.
* Every query is scoped to ``owner_id``; another account gets 404, so provider
  existence cannot be probed.
* If CREDENTIAL_ENCRYPTION_KEY is not configured, creating or rotating a
  credential is refused (409) instead of storing it insecurely.
* Errors are redacted: provider messages are passed through ``crypto.redact`` so
  a key can never leak through an exception string.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import AiProviderConnection, AiProviderRequest, AiTeacherModel
from app.dependencies import get_db_session, require_user
from app.services import crypto
from app.services.providers import (
    ProviderError,
    build_adapter,
    describe_provider_types,
    normalize_provider_type,
)

router = APIRouter()

MIN_KEY_LENGTH = 8


class ProviderCreateIn(BaseModel):
    provider_type: str
    name: str = Field(min_length=1, max_length=80)
    api_key: str = Field(min_length=MIN_KEY_LENGTH, max_length=4096)
    base_url: Optional[str] = None
    default_teacher_model: Optional[str] = None
    test_on_save: bool = True


class ProviderUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    base_url: Optional[str] = None
    enabled: Optional[bool] = None
    default_teacher_model: Optional[str] = None
    api_key: Optional[str] = Field(default=None, min_length=MIN_KEY_LENGTH, max_length=4096)
    budget: Optional[Dict[str, Any]] = None


class TeacherModelIn(BaseModel):
    model_id: str = Field(min_length=1, max_length=200)
    display_name: Optional[str] = None
    context_window: Optional[int] = Field(default=None, ge=1)
    max_output_tokens: Optional[int] = Field(default=None, ge=1)
    input_price_per_million: Optional[float] = Field(default=None, ge=0)
    output_price_per_million: Optional[float] = Field(default=None, ge=0)
    capabilities: Optional[Dict[str, Any]] = None


class TeacherModelUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Optional[bool] = None
    display_name: Optional[str] = None
    context_window: Optional[int] = Field(default=None, ge=1)
    max_output_tokens: Optional[int] = Field(default=None, ge=1)
    input_price_per_million: Optional[float] = Field(default=None, ge=0)
    output_price_per_million: Optional[float] = Field(default=None, ge=0)


class BudgetIn(BaseModel):
    max_requests_per_day: Optional[int] = Field(default=None, ge=0)
    max_tokens_per_day: Optional[int] = Field(default=None, ge=0)
    max_spend_usd_per_day: Optional[float] = Field(default=None, ge=0)
    max_concurrent_requests: Optional[int] = Field(default=None, ge=1, le=8)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _provider_out(provider: AiProviderConnection) -> Dict[str, Any]:
    """Safe serialization: never the ciphertext, never a decrypted key."""
    return {
        "id": provider.id,
        "provider_type": provider.provider_type,
        "name": provider.name,
        "base_url": provider.base_url,
        "credential_hint": provider.credential_hint,
        "credential_fingerprint": (provider.credential_fingerprint or "")[:8] or None,
        "enabled": bool(provider.enabled),
        "status": provider.status,
        "last_error": provider.last_error,
        "last_tested_at": _iso(provider.last_tested_at),
        "default_teacher_model": provider.default_teacher_model,
        "budget": provider.budget or {},
        "capabilities": provider.capabilities or {},
        "created_at": _iso(provider.created_at),
        "updated_at": _iso(provider.updated_at),
    }


def _model_out(model: AiTeacherModel) -> Dict[str, Any]:
    return {
        "id": model.id,
        "provider_id": model.provider_id,
        "model_id": model.model_id,
        "display_name": model.display_name,
        "context_window": model.context_window,
        "max_output_tokens": model.max_output_tokens,
        "capabilities": model.capabilities or {},
        "input_price_per_million": model.input_price_per_million,
        "output_price_per_million": model.output_price_per_million,
        "price_source": model.price_source,
        "price_updated_at": _iso(model.price_updated_at),
        "discovered": bool(model.discovered),
        "enabled": bool(model.enabled),
    }


async def _get_provider(db: AsyncSession, provider_id: str, owner_id: uuid.UUID) -> AiProviderConnection:
    provider = (await db.execute(select(AiProviderConnection).where(
        AiProviderConnection.id == provider_id))).scalar_one_or_none()
    if provider is None or provider.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Provider connection not found for this account.")
    return provider


async def _get_teacher_model(db: AsyncSession, model_row_id: str, owner_id: uuid.UUID) -> AiTeacherModel:
    row = (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.id == model_row_id))).scalar_one_or_none()
    if row is None or row.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Teacher model not found for this account.")
    return row


def _decrypt(provider: AiProviderConnection) -> str:
    try:
        return crypto.decrypt_secret(provider.credential_ciphertext)
    except crypto.CredentialError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"The stored credential cannot be used: {exc}. Replace the API key.",
        ) from exc


def _adapter_for(provider: AiProviderConnection, api_key: str):
    try:
        return build_adapter(provider.provider_type, api_key, provider.base_url)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Provider types & encryption status
# ---------------------------------------------------------------------------

@router.get("/types", tags=["teachers"])
async def provider_types():
    """Static provider families. Deliberately contains no model list or prices."""
    return {"provider_types": describe_provider_types()}


@router.get("/credential-status", tags=["teachers"])
async def credential_status(user=Depends(require_user)):
    """Whether credentials can be encrypted right now (drives the UI warning)."""
    available = crypto.key_available()
    return {
        "encryption_configured": available,
        "algorithm": "AES-256-GCM",
        "message": None if available else (
            "CREDENTIAL_ENCRYPTION_KEY is not configured on the backend, so new provider "
            "credentials are refused. Set a 32-byte key (base64 or hex) in the API environment."
        ),
    }


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

@router.get("/providers", tags=["teachers"])
async def list_providers(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    rows = (await db.execute(select(AiProviderConnection).where(
        AiProviderConnection.owner_id == owner_id).order_by(
        AiProviderConnection.created_at.asc()))).scalars().all()
    model_rows = (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.owner_id == owner_id))).scalars().all()
    by_provider: Dict[str, List[Dict[str, Any]]] = {}
    for row in model_rows:
        by_provider.setdefault(row.provider_id, []).append(_model_out(row))
    return {
        "providers": [{**_provider_out(row), "models": by_provider.get(row.id, [])} for row in rows],
        "credential_encryption_configured": crypto.key_available(),
    }


@router.post("/providers", tags=["teachers"], status_code=201)
async def create_provider(
    body: ProviderCreateIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Store a provider connection. The key is encrypted before it touches the DB."""
    owner_id = uuid.UUID(user["user_id"])
    provider_type = normalize_provider_type(body.provider_type)
    if provider_type not in {item["key"] for item in describe_provider_types()}:
        raise HTTPException(status_code=400, detail=f"Unsupported provider type '{body.provider_type}'.")

    try:
        envelope = crypto.encrypt_secret(body.api_key)
    except crypto.CredentialKeyMissing as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except crypto.CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    api_key = body.api_key.strip()
    fingerprint = crypto.fingerprint(api_key)
    duplicate = (await db.execute(select(AiProviderConnection).where(
        AiProviderConnection.owner_id == owner_id,
        AiProviderConnection.credential_fingerprint == fingerprint,
    ))).scalar_one_or_none()
    if duplicate is not None:
        raise HTTPException(
            status_code=409,
            detail=f"This API key is already connected as '{duplicate.name}'.",
        )

    provider = AiProviderConnection(
        id="prov_" + uuid.uuid4().hex[:10],
        owner_id=owner_id,
        provider_type=provider_type,
        name=body.name.strip(),
        base_url=(body.base_url or "").strip().rstrip("/") or None,
        credential_ciphertext=envelope,
        credential_hint=crypto.mask_secret(api_key),
        credential_fingerprint=fingerprint,
        enabled=True,
        status="unverified",
        default_teacher_model=body.default_teacher_model,
        budget={},
        capabilities={},
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)

    if body.test_on_save:
        # The test result is reported but a failed test does not delete the
        # connection: the owner may be offline, or the key may be missing a scope.
        await _run_connection_test(db, provider, api_key)
        await db.refresh(provider)
    return _provider_out(provider)


@router.patch("/providers/{provider_id}", tags=["teachers"])
async def update_provider(
    provider_id: str,
    body: ProviderUpdateIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)

    if body.name is not None:
        provider.name = body.name.strip()
    if body.base_url is not None:
        provider.base_url = body.base_url.strip().rstrip("/") or None
    if body.default_teacher_model is not None:
        provider.default_teacher_model = body.default_teacher_model.strip() or None
    if body.budget is not None:
        provider.budget = {**(provider.budget or {}), **body.budget}
    if body.enabled is not None:
        provider.enabled = bool(body.enabled)
        if not body.enabled:
            provider.status = "disabled"
        elif provider.status == "disabled":
            provider.status = "unverified"
    if body.api_key is not None:
        try:
            provider.credential_ciphertext = crypto.encrypt_secret(body.api_key)
        except crypto.CredentialKeyMissing as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except crypto.CredentialError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        provider.credential_hint = crypto.mask_secret(body.api_key)
        provider.credential_fingerprint = crypto.fingerprint(body.api_key.strip())
        provider.status = "unverified"
        provider.last_error = None

    provider.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(provider)
    return _provider_out(provider)


@router.delete("/providers/{provider_id}", tags=["teachers"])
async def delete_provider(
    provider_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Revoke a connection: the encrypted credential is destroyed with the row.

    Datasets, distillation records and training history are untouched; only the
    teacher connection and its model list go away.
    """
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)
    await db.delete(provider)
    await db.commit()
    return {"ok": True, "provider_id": provider_id, "revoked": True}


async def _run_connection_test(db: AsyncSession, provider: AiProviderConnection,
                               api_key: str) -> Dict[str, Any]:
    """Real request against the provider; updates status + capability labels."""
    adapter = _adapter_for(provider, api_key)
    try:
        result = await adapter.test_connection()
    except HTTPException:
        raise
    fine_tuning = None
    try:
        fine_tuning = await adapter.probe_fine_tuning()
    except Exception:  # a probe must never fail the whole test
        fine_tuning = {"supported": None, "evidence": "The fine-tuning probe could not be completed."}

    capabilities = adapter.capabilities(fine_tuning)
    capabilities["model_discovery"] = bool(result.get("discovery_supported")) and result.get("ok", False)
    capabilities["last_test_note"] = result.get("note")

    provider.last_tested_at = datetime.now(timezone.utc)
    provider.capabilities = capabilities
    if result.get("ok"):
        provider.status = "connected" if provider.enabled else "disabled"
        provider.last_error = None
    else:
        provider.status = "error" if provider.enabled else "disabled"
        provider.last_error = crypto.redact(str(result.get("error") or result.get("note") or
                                              "The connection test failed."), api_key)[:400]
    await db.commit()
    return {
        "ok": bool(result.get("ok")),
        "status": provider.status,
        "error": provider.last_error,
        "latency_ms": result.get("latency_ms"),
        "discovery_supported": bool(result.get("discovery_supported")),
        "models_found": len(result.get("models") or []),
        "models": result.get("models") or [],
        "capabilities": capabilities,
    }


@router.post("/providers/{provider_id}/test", tags=["teachers"])
async def test_provider(
    provider_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)
    api_key = _decrypt(provider)
    return await _run_connection_test(db, provider, api_key)


@router.post("/providers/{provider_id}/discover", tags=["teachers"])
async def discover_models(
    provider_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Ask the provider for its current model list and store what it returns."""
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)
    api_key = _decrypt(provider)
    adapter = _adapter_for(provider, api_key)
    try:
        models = await adapter.list_models()
    except ProviderError as exc:
        provider.last_error = crypto.redact(str(exc), api_key)[:400]
        provider.status = "error"
        provider.last_tested_at = datetime.now(timezone.utc)
        await db.commit()
        raise HTTPException(status_code=502, detail=provider.last_error) from exc

    existing = {row.model_id: row for row in (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.provider_id == provider.id))).scalars().all()}
    created = 0
    updated = 0
    for info in models:
        row = existing.get(info.model_id)
        if row is None:
            db.add(AiTeacherModel(
                id="tm_" + uuid.uuid4().hex[:10],
                owner_id=owner_id,
                provider_id=provider.id,
                model_id=info.model_id,
                display_name=info.display_name,
                context_window=info.context_window,
                max_output_tokens=info.max_output_tokens,
                capabilities={**(info.capabilities or {}), "source": "discovered"},
                discovered=True,
                enabled=True,
            ))
            created += 1
        else:
            # Refresh only what the provider actually told us; never overwrite
            # owner-entered pricing.
            row.display_name = info.display_name or row.display_name
            if info.context_window is not None:
                row.context_window = info.context_window
            if info.max_output_tokens is not None:
                row.max_output_tokens = info.max_output_tokens
            row.capabilities = {**(info.capabilities or {}), **(row.capabilities or {}), "source": "discovered"}
            row.discovered = True
            updated += 1
    provider.last_tested_at = datetime.now(timezone.utc)
    provider.status = "connected" if provider.enabled else "disabled"
    provider.last_error = None
    await db.commit()

    rows = (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.provider_id == provider.id).order_by(
        AiTeacherModel.model_id.asc()))).scalars().all()
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "discovered_at": _iso(provider.last_tested_at),
        "models": [_model_out(row) for row in rows],
    }


# ---------------------------------------------------------------------------
# Teacher models
# ---------------------------------------------------------------------------

@router.get("/models", tags=["teachers"])
async def list_teacher_models(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    rows = (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.owner_id == owner_id).order_by(AiTeacherModel.created_at.asc()))).scalars().all()
    return {"models": [_model_out(row) for row in rows]}


@router.post("/providers/{provider_id}/models", tags=["teachers"], status_code=201)
async def add_teacher_model(
    provider_id: str,
    body: TeacherModelIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Manual model ID entry — the fallback when a provider has no discovery API."""
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)
    existing = (await db.execute(select(AiTeacherModel).where(
        AiTeacherModel.provider_id == provider.id,
        AiTeacherModel.model_id == body.model_id.strip(),
    ))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="That model ID is already added for this provider.")
    row = AiTeacherModel(
        id="tm_" + uuid.uuid4().hex[:10],
        owner_id=owner_id,
        provider_id=provider.id,
        model_id=body.model_id.strip(),
        display_name=(body.display_name or body.model_id).strip(),
        context_window=body.context_window,
        max_output_tokens=body.max_output_tokens,
        capabilities={**(body.capabilities or {}), "source": "manual"},
        input_price_per_million=body.input_price_per_million,
        output_price_per_million=body.output_price_per_million,
        price_source="owner" if (body.input_price_per_million is not None or
                                 body.output_price_per_million is not None) else None,
        price_updated_at=datetime.now(timezone.utc) if (
            body.input_price_per_million is not None or body.output_price_per_million is not None) else None,
        discovered=False,
        enabled=True,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _model_out(row)


@router.patch("/models/{model_row_id}", tags=["teachers"])
async def update_teacher_model(
    model_row_id: str,
    body: TeacherModelUpdateIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    row = await _get_teacher_model(db, model_row_id, owner_id)
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    if body.display_name is not None:
        row.display_name = body.display_name
    if body.context_window is not None:
        row.context_window = body.context_window
    if body.max_output_tokens is not None:
        row.max_output_tokens = body.max_output_tokens
    price_changed = False
    if body.input_price_per_million is not None:
        row.input_price_per_million = body.input_price_per_million
        price_changed = True
    if body.output_price_per_million is not None:
        row.output_price_per_million = body.output_price_per_million
        price_changed = True
    if price_changed:
        row.price_source = "owner"
        row.price_updated_at = datetime.now(timezone.utc)
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _model_out(row)


@router.delete("/models/{model_row_id}", tags=["teachers"])
async def delete_teacher_model(
    model_row_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    row = await _get_teacher_model(db, model_row_id, owner_id)
    await db.delete(row)
    await db.commit()
    return {"ok": True, "model_row_id": model_row_id, "removed": True}


# ---------------------------------------------------------------------------
# Usage and budgets
# ---------------------------------------------------------------------------

@router.get("/usage", tags=["teachers"])
async def provider_usage(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Per-provider request/token/spend aggregates, straight from the request log."""
    owner_id = uuid.UUID(user["user_id"])
    rows = (await db.execute(text("""
        SELECT p.id AS provider_id, p.name, p.provider_type, p.budget,
               COUNT(r.id) AS requests,
               COUNT(r.id) FILTER (WHERE r.status = 'success') AS successes,
               COUNT(r.id) FILTER (WHERE r.status = 'error') AS failures,
               COUNT(r.id) FILTER (WHERE r.status = 'rate_limited') AS rate_limit_errors,
               COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
               COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
               COALESCE(SUM(r.cached_tokens), 0) AS cached_tokens,
               COALESCE(SUM(r.estimated_cost), 0) AS estimated_cost,
               COUNT(r.id) FILTER (WHERE r.estimated_cost IS NULL AND r.status = 'success') AS unpriced_requests,
               AVG(r.latency_ms) FILTER (WHERE r.latency_ms IS NOT NULL) AS avg_latency_ms,
               MAX(r.created_at) AS last_request_at,
               COALESCE(SUM(r.estimated_cost) FILTER (WHERE r.created_at >= now() - interval '1 day'), 0) AS spend_24h,
               COUNT(r.id) FILTER (WHERE r.created_at >= now() - interval '1 day') AS requests_24h
        FROM public.ai_provider_connections p
        LEFT JOIN public.ai_provider_requests r
               ON r.provider_id = p.id AND r.owner_id = p.owner_id
        WHERE p.owner_id = :owner_id
        GROUP BY p.id, p.name, p.provider_type, p.budget
        ORDER BY p.created_at ASC
    """), {"owner_id": owner_id})).mappings().all()

    providers = []
    totals = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "estimated_cost": 0.0}
    for row in rows:
        item = {
            "provider_id": row["provider_id"],
            "name": row["name"],
            "provider_type": row["provider_type"],
            "requests": int(row["requests"] or 0),
            "successes": int(row["successes"] or 0),
            "failures": int(row["failures"] or 0),
            "rate_limit_errors": int(row["rate_limit_errors"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            "total_tokens": int(row["input_tokens"] or 0) + int(row["output_tokens"] or 0),
            "cached_tokens": int(row["cached_tokens"] or 0),
            "estimated_cost": float(row["estimated_cost"] or 0.0),
            "unpriced_requests": int(row["unpriced_requests"] or 0),
            "avg_latency_ms": float(row["avg_latency_ms"]) if row["avg_latency_ms"] is not None else None,
            "last_request_at": _iso(row["last_request_at"]),
            "spend_24h": float(row["spend_24h"] or 0.0),
            "requests_24h": int(row["requests_24h"] or 0),
            "budget": row["budget"] or {},
        }
        providers.append(item)
        totals["requests"] += item["requests"]
        totals["input_tokens"] += item["input_tokens"]
        totals["output_tokens"] += item["output_tokens"]
        totals["estimated_cost"] += item["estimated_cost"]

    return {
        "providers": providers,
        "totals": {
            **totals,
            "total_tokens": totals["input_tokens"] + totals["output_tokens"],
            "estimated_cost": round(totals["estimated_cost"], 6),
        },
        "pricing_note": (
            "Costs are only computed from prices you entered for each teacher model. "
            "Requests without a price are counted as 'unpriced' instead of being estimated."
        ),
    }


@router.put("/providers/{provider_id}/budget", tags=["teachers"])
async def set_provider_budget(
    provider_id: str,
    body: BudgetIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Owner-configured hard limits; enforced before every teacher request."""
    owner_id = uuid.UUID(user["user_id"])
    provider = await _get_provider(db, provider_id, owner_id)
    budget = dict(provider.budget or {})
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is None:
            budget.pop(key, None)
        else:
            budget[key] = value
    provider.budget = budget
    provider.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "provider_id": provider_id, "budget": budget}
