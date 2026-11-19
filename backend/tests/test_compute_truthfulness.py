"""P1 — compute worker ownership must be real, not a nil-UUID placeholder.

The old `/compute/workers/register` route wrote
`00000000-0000-0000-0000-000000000000` as `owner_id`, so the worker belonged to
no account and was invisible to `list_workers` (which filters by caller).
"""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.core.models import ComputeWorker
from app.main import app as fastapi_app
from tests.conftest import USER_ID, db_rows

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def worker_client(_auth_overrides):
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {settings.WORKER_AUTH_SECRET}"},
    ) as client:
        yield client


def payload(**overrides):
    base = {
        "name": "Trusted worker",
        "os": "linux",
        "cpu": "8 vCPU",
        "ram": 16384,
        "backend": "cpu",
        "owner_id": USER_ID,
    }
    base.update(overrides)
    return base


async def test_registration_requires_a_real_owner(worker_client):
    missing = await worker_client.post("/api/v1/compute/workers/register", json={
        k: v for k, v in payload().items() if k != "owner_id"
    })
    assert missing.status_code == 422, missing.text

    nil = await worker_client.post(
        "/api/v1/compute/workers/register",
        json=payload(owner_id="00000000-0000-0000-0000-000000000000"),
    )
    assert nil.status_code == 422, nil.text

    malformed = await worker_client.post(
        "/api/v1/compute/workers/register", json=payload(owner_id="not-a-uuid")
    )
    assert malformed.status_code == 422, malformed.text
    assert await db_rows(ComputeWorker) == []


async def test_registered_worker_belongs_to_the_stated_account(worker_client, http):
    response = await worker_client.post("/api/v1/compute/workers/register", json=payload())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["owner_id"] == USER_ID
    assert body["status"] == "online"

    rows = await db_rows(ComputeWorker, id=body["id"])
    assert len(rows) == 1
    assert rows[0].owner_id == uuid.UUID(USER_ID)
    assert rows[0].owner_id != uuid.UUID("00000000-0000-0000-0000-000000000000")

    listed = await http.get("/api/v1/compute/workers")
    assert listed.status_code == 200, listed.text
    assert [w["id"] for w in listed.json()] == [body["id"]]


async def test_worker_secret_is_still_required(_auth_overrides):
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/api/v1/compute/workers/register", json=payload())
    assert response.status_code == 401, response.text
    assert await db_rows(ComputeWorker) == []
