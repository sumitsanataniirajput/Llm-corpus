"""Ownership comparison + production diagnostics regressions.

Reported production symptom: an authenticated owner could not delete their own
idle model — the live API answered ``403 {"detail": "Not authorized"}``.

Two distinct defects can produce that answer, and both are pinned down here:

1. **Type mismatch (always-403).** ``supabase/migrations/001_initial_schema.sql``
   created ``models.owner_id`` as **text**. SQLAlchemy then hands Python a
   ``str`` for that column, so the pre-fix comparison
   ``model.owner_id != uuid.UUID(user["user_id"])`` was always true and the real
   owner was rejected. ``app.core.ownership.same_owner`` normalizes both sides.
2. **Type mismatch in SQL filters (always-500).** ``Model.owner_id ==
   uuid.UUID(...)`` renders ``owner_id = $1::uuid``, which PostgreSQL rejects on
   a text column with ``operator does not exist: text = uuid``.
   ``app.core.ownership.owner_column_matches`` renders a cast that works on both
   column types.

The tests below run against a real PostgreSQL instance (see conftest) and
exercise the real endpoints — no ownership check is bypassed or relaxed.
"""
import uuid

import pytest
from sqlalchemy import Column, String, select, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import declarative_base

from app.api.endpoints.version import BUILD_ID, FEATURES
from app.config import settings
from app.core.ownership import (
    normalize_owner_id,
    owner_column_matches,
    owner_fingerprint,
    require_user_uuid,
    same_owner,
)
from app.core.models import Model
from tests.conftest import DATABASE_URL, OTHER_USER_ID, USER_ID, db_rows


async def _create_model(http, name="Diagnosed model"):
    resp = await http.post("/api/v1/models/", json={
        "name": name,
        "vocab_size": 256,
        "context_length": 32,
        "d_model": 32,
        "n_layers": 1,
        "n_heads": 4,
        "d_ff": 64,
        "dropout": 0.1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _with_short_session(fn):
    """Run ``fn(session)`` on a short-lived engine (safe inside async tests)."""
    engine = create_async_engine(DATABASE_URL, future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            return await fn(session)
    finally:
        await engine.dispose()


async def _owner_column_type():
    async def _q(session):
        result = await session.execute(text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'models' "
            "AND column_name = 'owner_id'"
        ))
        return result.scalar_one_or_none()

    return await _with_short_session(_q)


async def _set_owner_column_type(data_type):
    async def _q(session):
        await session.execute(text(
            f"ALTER TABLE public.models ALTER COLUMN owner_id TYPE {data_type} "
            f"USING owner_id::{data_type}"
        ))
        await session.commit()

    await _with_short_session(_q)
    # The DDL invalidates asyncpg's cached prepared statements on the app's
    # pooled connections; drop the pool so the next request prepares afresh.
    from app.core.database import dispose_engine

    await dispose_engine()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def test_same_owner_never_confuses_uuid_and_string_forms():
    uid = uuid.UUID(USER_ID)
    assert same_owner(uid, USER_ID) is True
    assert same_owner(str(uid), uid) is True
    assert same_owner(str(uid).upper(), USER_ID) is True
    assert same_owner(f"  {USER_ID}  ", USER_ID) is True
    assert same_owner(OTHER_USER_ID, USER_ID) is False
    assert same_owner(None, USER_ID) is False
    assert same_owner(USER_ID, None) is False
    assert same_owner("", USER_ID) is False


def test_normalize_and_fingerprint_are_stable_and_opaque():
    uid = uuid.UUID(USER_ID)
    assert normalize_owner_id(uid) == normalize_owner_id(USER_ID.upper()) == str(uid).lower()
    assert normalize_owner_id(None) == ""
    fingerprint = owner_fingerprint(uid)
    assert len(fingerprint) == 12
    assert USER_ID not in fingerprint
    assert owner_fingerprint(uid) == owner_fingerprint(USER_ID)


def test_require_user_uuid_rejects_missing_or_non_uuid_ids():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as missing:
        require_user_uuid({})
    assert missing.value.status_code == 401

    with pytest.raises(HTTPException) as malformed:
        require_user_uuid({"user_id": "not-a-uuid"})
    assert malformed.value.status_code == 401


# ---------------------------------------------------------------------------
# Type-agnostic SQL filter against real PostgreSQL
# ---------------------------------------------------------------------------

_PROBE_BASE = declarative_base()


class ProbeTextModel(_PROBE_BASE):
    __tablename__ = "probe_models_text_owner"
    id = Column(String, primary_key=True)
    owner_id = Column(UUID(as_uuid=True), nullable=False)


class ProbeUuidModel(_PROBE_BASE):
    __tablename__ = "probe_models_uuid_owner"
    id = Column(String, primary_key=True)
    owner_id = Column(UUID(as_uuid=True), nullable=False)


@pytest.mark.asyncio
async def test_owner_column_matches_works_on_text_and_uuid_owner_columns():
    """`CAST(owner_id AS VARCHAR)` matches on both column types, even upper-case rows."""
    engine = create_async_engine(DATABASE_URL, future=True)
    uid = uuid.UUID(USER_ID)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS probe_models_text_owner"))
            await conn.execute(text("DROP TABLE IF EXISTS probe_models_uuid_owner"))
            await conn.execute(text(
                "CREATE TABLE probe_models_text_owner (id text PRIMARY KEY, owner_id text NOT NULL)"
            ))
            await conn.execute(text(
                "CREATE TABLE probe_models_uuid_owner (id text PRIMARY KEY, owner_id uuid NOT NULL)"
            ))
            # Store the text row with a non-canonical (upper-case) value on purpose.
            await conn.execute(
                text("INSERT INTO probe_models_text_owner VALUES ('text_row', :o)"),
                {"o": str(uid).upper()},
            )
            await conn.execute(
                text("INSERT INTO probe_models_uuid_owner VALUES ('uuid_row', :o)"),
                {"o": uid},
            )

        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            text_rows = await session.execute(
                select(ProbeTextModel).where(owner_column_matches(ProbeTextModel.owner_id, uid))
            )
            assert [row.id for row in text_rows.scalars().all()] == ["text_row"]

            uuid_rows = await session.execute(
                select(ProbeUuidModel).where(owner_column_matches(ProbeUuidModel.owner_id, uid))
            )
            assert [row.id for row in uuid_rows.scalars().all()] == ["uuid_row"]

            # A different account must still match nothing.
            other_rows = await session.execute(
                select(ProbeUuidModel).where(owner_column_matches(ProbeUuidModel.owner_id, OTHER_USER_ID))
            )
            assert other_rows.scalars().all() == []

            # The pre-fix filter is what raised ProgrammingError on the text column.
            with pytest.raises(Exception) as broken:
                await session.execute(
                    select(ProbeTextModel).where(ProbeTextModel.owner_id == uid)
                )
            assert "text = uuid" in str(broken.value) or "ProgrammingError" in type(broken.value).__name__
            await session.rollback()
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE IF EXISTS probe_models_text_owner"))
            await conn.execute(text("DROP TABLE IF EXISTS probe_models_uuid_owner"))
        await engine.dispose()


# ---------------------------------------------------------------------------
# The production regression, end to end
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_owner_can_list_and_delete_model_when_owner_column_is_text(http):
    """Reproduce a text-typed ``models.owner_id`` (the live-schema shape).

    Before the fix this combination produced 500 on GET /api/v1/models/ and
    403 "Not authorized" on DELETE for the legitimate owner.
    """
    model = await _create_model(http, name="Text owner column model")
    original_type = await _owner_column_type()
    assert original_type in ("uuid", "text")
    if original_type == "uuid":
        await _set_owner_column_type("text")
    try:
        assert await _owner_column_type() == "text"

        listed = await http.get("/api/v1/models/")
        assert listed.status_code == 200, listed.text
        assert [m["id"] for m in listed.json()] == [model["id"]]

        deleted = await http.delete(f"/api/v1/models/{model['id']}")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["ok"] is True
        assert await db_rows(Model, id=model["id"]) == []
    finally:
        if await _owner_column_type() == "text":
            await db_rows(Model)  # keep the engine warm; no-op read
            await _set_owner_column_type("uuid")


@pytest.mark.asyncio
async def test_other_account_still_cannot_delete_on_a_text_owner_column(http, http_as_other):
    """Strict authorization survives the normalization — it never widens access."""
    model = await _create_model(http, name="Not yours")
    original_type = await _owner_column_type()
    if original_type == "uuid":
        await _set_owner_column_type("text")
    try:
        denied = await http_as_other.delete(f"/api/v1/models/{model['id']}")
        assert denied.status_code == 403
        assert denied.json()["detail"] == "Not authorized"
        assert len(await db_rows(Model, id=model["id"])) == 1
        assert (await http_as_other.get("/api/v1/models/")).json() == []
    finally:
        if await _owner_column_type() == "text":
            await _set_owner_column_type("uuid")


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ownership_diagnostics_explains_owner_verdict(http):
    model = await _create_model(http, name="Diagnostics model")

    resp = await http.get("/api/v1/models/ownership-diagnostics")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["caller_user_id"] == USER_ID
    assert body["models_owner_id_column_type"] in ("uuid", "text")
    assert body["models_owned_by_caller"] == 1
    assert body["owned_model_ids"] == [model["id"]]
    assert body["full_owner_ids_exposed"] is False

    scoped = await http.get(f"/api/v1/models/ownership-diagnostics?model_id={model['id']}")
    assert scoped.status_code == 200, scoped.text
    entry = scoped.json()["model"]
    assert entry["owner_matches_caller"] is True
    assert entry["verdict"] == "owner"
    assert entry["stored_owner_id"] == USER_ID.lower()
    assert entry["stored_owner_python_type"] in ("UUID", "str")


@pytest.mark.asyncio
async def test_ownership_diagnostics_never_leaks_another_accounts_owner_id(http, http_as_other):
    model = await _create_model(http, name="Someone else's model")

    other_view = await http_as_other.get(
        f"/api/v1/models/ownership-diagnostics?model_id={model['id']}"
    )
    assert other_view.status_code == 200, other_view.text
    body = other_view.json()
    assert body["models_owned_by_caller"] == 0
    entry = body["model"]
    assert entry["owner_matches_caller"] is False
    assert entry["verdict"] == "different_account"
    assert "stored_owner_id" not in entry, "another account's owner id must stay hidden"
    assert entry["stored_owner_fingerprint"] and USER_ID not in str(body)

    # The deployment operator (holds WORKER_AUTH_SECRET) can see the raw ids.
    operator_view = await http_as_other.get(
        f"/api/v1/models/ownership-diagnostics?model_id={model['id']}",
        headers={"X-Debug-Secret": settings.WORKER_AUTH_SECRET},
    )
    assert operator_view.status_code == 200, operator_view.text
    assert operator_view.json()["model"]["stored_owner_id"] == USER_ID.lower()


@pytest.mark.asyncio
async def test_ownership_diagnostics_reports_missing_model(http):
    resp = await http.get("/api/v1/models/ownership-diagnostics?model_id=model_does_not_exist")
    assert resp.status_code == 200
    assert resp.json()["model"] == {"id": "model_does_not_exist", "exists": False}


# ---------------------------------------------------------------------------
# Deployment identity
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_version_endpoint_reports_build_and_feature_markers():
    from httpx import ASGITransport, AsyncClient

    from app.main import app as fastapi_app

    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.get("/api/v1/version")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["build_id"] == BUILD_ID
    assert set(FEATURES) <= set(body["features"])
    assert "owner-id-normalization" in body["features"]
    assert body["service"]
    # Commit is only known when the platform provides it (Render sets it).
    assert "commit" in body


@pytest.mark.asyncio
async def test_unauthenticated_model_requests_are_rejected():
    """No token -> 401, with and without the ownership fix in place."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app as fastapi_app

    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        listed = await client.get("/api/v1/models/")
        assert listed.status_code == 401, listed.text
        deleted = await client.delete("/api/v1/models/model_whatever")
        assert deleted.status_code == 401, deleted.text
        diagnostics = await client.get("/api/v1/models/ownership-diagnostics")
        assert diagnostics.status_code == 401, diagnostics.text
