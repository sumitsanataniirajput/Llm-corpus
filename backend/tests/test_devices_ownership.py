"""P2 — canonical ownership for device/task/job rows.

The bug this guards: ``uuid.UUID`` from SQLAlchemy vs ``str`` from a text column
(or an uppercased id) compared with ``!=`` always looks like a different owner.
Every devices endpoint must use ``app.core.ownership`` helpers instead.
"""
import asyncio
import sys
import types
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.api.endpoints import devices
from app.core.database import get_session_factory
from app.main import app as fastapi_app
from app.dependencies import require_user
from tests.conftest import USER_ID


DEVICES_SOURCE = (
    Path(__file__).resolve().parents[1] / "app" / "api" / "endpoints" / "devices.py"
).read_text()


class _ScalarResult:
    def __init__(self, row):
        self.row = row

    def scalar_one_or_none(self):
        return self.row


class _RowsResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _FakeDB:
    """Records raw SQL + params and returns canned results, no PostgreSQL."""

    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []
        self.calls = []
        self.commits = 0

    async def execute(self, statement, params=None):
        raw = " ".join(str(statement).split())
        sql = raw.upper()
        self.calls.append((raw, params or {}))
        # SELECT statements contain columns named `updated_at`, so do not use a
        # loose `"UPDATE" in sql` test here.
        if sql.startswith("UPDATE") or " RETURNING " in f" {sql} ":
            return _RowsResult(self.rows)
        return _ScalarResult(self.row)

    async def commit(self):
        self.commits += 1


def _run(coro):
    return asyncio.run(coro)


def test_devices_source_uses_canonical_ownership_helpers_only():
    assert "uuid.UUID(user[\"user_id\"])" not in DEVICES_SOURCE
    assert "device.owner_id != owner_id" not in DEVICES_SOURCE
    assert "task.owner_id != owner_id" not in DEVICES_SOURCE
    assert "job.owner_id != owner_id" not in DEVICES_SOURCE
    assert "TrainingDevice.owner_id == owner_id" not in DEVICES_SOURCE
    assert "TrainingDeviceTask.owner_id == owner_id" not in DEVICES_SOURCE
    assert "WHERE owner_id = :owner_id" not in DEVICES_SOURCE
    for helper in ("require_user_uuid", "same_owner", "owner_column_matches", "normalize_owner_id"):
        assert helper in DEVICES_SOURCE
    assert DEVICES_SOURCE.count("lower(cast(owner_id as varchar)) = :owner_id") >= 5


def test_owned_helpers_accept_uuid_strings_and_uuid_objects():
    owner = uuid.uuid4()
    canonical = str(owner)
    for shape in (owner, canonical, canonical.upper(), "  " + canonical.upper() + "  "):
        device = SimpleNamespace(owner_id=canonical)
        db = _FakeDB(row=device)
        assert _run(devices._get_device(db, "dev_x", owner)) is device
        assert _run(devices._get_device(db, "dev_x", shape)) is device

        task = SimpleNamespace(device_id="dev_x", owner_id=canonical.upper())
        assert _run(devices._get_task(_FakeDB(row=task), "dev_x", "task_x", owner)) is task

        job = SimpleNamespace(owner_id=canonical, deleted_at=None)
        assert _run(devices._get_owned_job(_FakeDB(row=job), "job_x", shape)) is job


def test_owned_helpers_reject_another_account_with_404():
    owner = uuid.uuid4()
    stranger = SimpleNamespace(owner_id=str(uuid.uuid4()))
    with pytest.raises(HTTPException) as exc:
        _run(devices._get_device(_FakeDB(row=stranger), "dev_x", owner))
    assert exc.value.status_code == 404

    task = SimpleNamespace(device_id="dev_x", owner_id=str(uuid.uuid4()))
    with pytest.raises(HTTPException) as exc:
        _run(devices._get_task(_FakeDB(row=task), "dev_x", "task_x", owner))
    assert exc.value.status_code == 404

    job = SimpleNamespace(owner_id=str(uuid.uuid4()), deleted_at=None)
    with pytest.raises(HTTPException) as exc:
        _run(devices._get_owned_job(_FakeDB(row=job), "job_x", owner))
    assert exc.value.status_code == 404


def test_expired_sweep_uses_canonical_string_and_type_agnostic_sql():
    owner = uuid.uuid4()
    db = _FakeDB(rows=[])
    result = _run(devices.sweep_expired(db, owner))
    assert result == {"devices_offline": 0, "tasks_expired": 0}
    assert len(db.calls) == 2
    for sql, params in db.calls:
        assert "lower(cast(owner_id as varchar)) = :owner_id" in sql
        assert params["owner_id"] == str(owner)
        assert not isinstance(params["owner_id"], uuid.UUID)
    assert db.commits == 0


@pytest.mark.asyncio
async def test_uppercase_auth_id_registers_and_lists_the_same_device(_auth_overrides):
    """A realistic UUID may arrive uppercased; canonicalisation keeps it mine."""
    from app.dependencies import require_user as dependency

    upper = USER_ID.upper()

    async def _uppercase_user():
        return {"user_id": upper, "email": "upper@example.com", "token": "test-token"}

    fastapi_app.dependency_overrides[dependency] = _uppercase_user
    transport = ASGITransport(app=fastapi_app)
    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            created = await client.post("/api/v1/devices/", json={
                "name": "Uppercase owner", "capabilities": {"cpu_cores": 2},
            })
            assert created.status_code == 200, created.text
            device = created.json()
            assert device["name"] == "Uppercase owner"

            listing = await client.get("/api/v1/devices/")
            assert listing.status_code == 200, listing.text
            assert [d["id"] for d in listing.json()["devices"]] == [device["id"]]

            beat = await client.post(
                f"/api/v1/devices/{device['id']}/heartbeat", json={"progress_percent": 10}
            )
            assert beat.status_code == 200, beat.text
    finally:
        fastapi_app.dependency_overrides.pop(dependency, None)


@pytest.mark.asyncio
async def test_other_account_sweep_cannot_expire_my_device(http, http_as_other, monkeypatch):
    """Raw SQL sweeps are owner-scoped, not global."""
    from datetime import datetime, timedelta, timezone
    from app.api.endpoints import training as training_endpoints

    fake = types.ModuleType("app.services.training_worker")

    async def run_training_job(job_id, owner_id):
        return None

    fake.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)
    monkeypatch.setattr(training_endpoints, "run_training_job", run_training_job, raising=False)

    device = (await http.post("/api/v1/devices/", json={
        "name": "Stale but mine", "capabilities": {"cpu_cores": 4},
    })).json()
    model = (await http.post("/api/v1/models/", json={
        "name": "Ownership model", "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()
    dataset = (await http.post("/api/v1/datasets/", json={
        "name": "Ownership corpus", "format": "txt",
    })).json()
    uploaded = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("corpus.txt", b"owner scoped corpus\n" * 80, "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    job = (await http.post("/api/v1/training/", json={
        "model_id": model["id"], "dataset_id": dataset["id"],
        "epochs": 1, "batch_size": 2,
    })).json()
    assigned = await http.post(
        f"/api/v1/devices/{device['id']}/assign", json={"job_id": job["id"]}
    )
    assert assigned.status_code == 200, assigned.text
    task = assigned.json()["task"]

    stale = datetime.now(timezone.utc) - timedelta(minutes=10)
    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text(
            "UPDATE public.training_devices SET last_heartbeat = :ts WHERE id = :id"
        ), {"ts": stale, "id": device["id"]})
        await db.execute(text(
            "UPDATE public.training_device_tasks SET lease_expires_at = :ts WHERE id = :id"
        ), {"ts": stale, "id": task["id"]})
        await db.commit()

    other = await http_as_other.get("/api/v1/devices/")
    assert other.status_code == 200, other.text
    assert other.json()["sweep"] == {"devices_offline": 0, "tasks_expired": 0}

    async with factory() as db:
        rows = (await db.execute(text(
            "SELECT status FROM public.training_devices WHERE id = :id"
        ), {"id": device["id"]})).mappings().all()
        task_rows = (await db.execute(text(
            "SELECT status FROM public.training_device_tasks WHERE id = :id"
        ), {"id": task["id"]})).mappings().all()
    assert rows[0]["status"] == "online"
    assert task_rows[0]["status"] == "assigned"

    # My own sweep still sees and expires the same stale rows.
    mine = await http.get("/api/v1/devices/")
    assert mine.json()["sweep"] == {"devices_offline": 1, "tasks_expired": 1}
