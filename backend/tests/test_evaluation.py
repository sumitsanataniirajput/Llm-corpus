"""P1 — the Evaluation endpoint must not fabricate results or cross accounts.

These tests exercise the real FastAPI route, real PostgreSQL and the real ORM.
They intentionally assert the honest `unavailable` state: scoring is not
implemented until a trained checkpoint and inference engine exist.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.database import get_session_factory
from app.core.models import EvaluationRun, Model
from tests.conftest import USER_ID, db_rows

pytestmark = pytest.mark.asyncio


async def _create_model(client, name="Eval model"):
    response = await client.post("/api/v1/models/", json={
        "name": name,
        "vocab_size": 512,
        "context_length": 64,
        "d_model": 64,
        "n_layers": 2,
        "n_heads": 4,
        "d_ff": 128,
        "dropout": 0.1,
    })
    assert response.status_code == 200, response.text
    return response.json()


async def test_run_evaluation_reports_unavailable_instead_of_a_fake_score(http):
    model = await _create_model(http)
    response = await http.post(
        "/api/v1/evaluation/run",
        json={"model_id": model["id"], "test_type": "knowledge", "questions": ["What is 2+2?"]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["score"] is None
    assert body["model_id"] == model["id"]
    assert body["owner_id"] == USER_ID
    assert "score was" in body["message"] and "not" in body["message"].lower()

    rows = await db_rows(EvaluationRun, id=body["id"])
    assert len(rows) == 1
    assert rows[0].status == "unavailable"
    assert rows[0].score is None
    assert rows[0].owner_id == uuid.UUID(USER_ID)


async def test_run_evaluation_refuses_another_accounts_model(http, http_as_other):
    model = await _create_model(http)
    response = await http_as_other.post(
        "/api/v1/evaluation/run",
        json={"model_id": model["id"], "test_type": "knowledge"},
    )
    assert response.status_code == 404, response.text
    assert await db_rows(EvaluationRun, model_id=model["id"]) == []


async def test_evaluation_get_and_list_are_owner_scoped(http, http_as_other):
    model = await _create_model(http)
    created = await http.post(
        "/api/v1/evaluation/run",
        json={"model_id": model["id"], "test_type": "knowledge"},
    )
    assert created.status_code == 200, created.text
    eval_id = created.json()["id"]

    assert (await http_as_other.get(f"/api/v1/evaluation/{eval_id}")).status_code == 403
    other_list = await http_as_other.get("/api/v1/evaluation/")
    assert other_list.status_code == 200
    assert other_list.json() == []

    own_list = await http.get("/api/v1/evaluation/")
    assert own_list.status_code == 200
    assert [item["id"] for item in own_list.json()] == [eval_id]


async def test_unavailable_status_is_persisted_not_overwritten_by_legacy_default(http):
    """The DB default is historically 'completed'; the route must set the truth."""
    model = await _create_model(http)
    response = await http.post(
        "/api/v1/evaluation/run",
        json={"model_id": model["id"], "test_type": "knowledge"},
    )
    assert response.status_code == 200
    factory = get_session_factory()
    async with factory() as db:
        result = await db.execute(
            select(EvaluationRun.status).where(EvaluationRun.id == response.json()["id"])
        )
        assert result.scalar_one() == "unavailable"

    # Sanity: the model row itself is untouched by an evaluation request.
    assert len(await db_rows(Model, id=model["id"])) == 1
