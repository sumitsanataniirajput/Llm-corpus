"""Regression tests for complete, owner-scoped model deletion."""
import uuid

import pytest
from sqlalchemy import select, text

from app.core.database import get_session_factory
from app.core.models import Model, TrainingJob
from tests.conftest import USER_ID, db_rows


async def _create_model(client, name="Delete me"):
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


@pytest.mark.asyncio
async def test_delete_model_removes_artifacts_and_preserves_history(http, storage, monkeypatch):
    from app.api.endpoints import models as model_endpoints

    monkeypatch.setattr(model_endpoints, "create_client", lambda url, key: storage)
    model = await _create_model(http)
    checkpoint_path = f"checkpoints/{model['id']}/model.pt"
    tokenizer_path = f"tokenizers/{model['id']}/tokenizer.json"
    storage.put("corpus-storage", checkpoint_path, b"checkpoint")
    storage.put("corpus-storage", tokenizer_path, b"tokenizer")

    factory = get_session_factory()
    async with factory() as db:
        saved = await db.get(Model, model["id"])
        saved.config = {
            **saved.config,
            "checkpoint_path": checkpoint_path,
            "tokenizer_path": tokenizer_path,
        }
        db.add(TrainingJob(
            id="job_delete_history",
            owner_id=uuid.UUID(USER_ID),
            model_id=model["id"],
            status="completed",
            engine="pytorch",
            compute="local",
            config={},
        ))
        await db.execute(text("""
            -- public.checkpoints has no owner_id column: ownership is inherited
            -- from the parent model, exactly like the live schema.
            INSERT INTO public.checkpoints (id, model_id, storage_path)
            VALUES (:id, :model_id, :path)
        """), {
            "id": "ckpt_delete_test",
            "model_id": model["id"],
            "path": checkpoint_path,
        })
        await db.execute(text("""
            INSERT INTO public.model_versions (model_id, version)
            VALUES (:model_id, '1.0')
        """), {"model_id": model["id"]})
        await db.execute(text("""
            INSERT INTO public.model_architectures (model_id, architecture)
            VALUES (:model_id, '{}'::jsonb)
        """), {"model_id": model["id"]})
        await db.execute(text("""
            INSERT INTO public.evaluation_runs (id, owner_id, model_id)
            VALUES ('eval_delete_test', :owner_id, :model_id)
        """), {"owner_id": USER_ID, "model_id": model["id"]})
        await db.execute(text("""
            INSERT INTO public.conversations (id, owner_id, model_id)
            VALUES ('conv_delete_test', :owner_id, :model_id)
        """), {"owner_id": USER_ID, "model_id": model["id"]})
        await db.commit()

    response = await http.delete(f"/api/v1/models/{model['id']}")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert result["removed_storage_files"] == 2
    assert result["storage_cleanup_warning"] is None

    assert await db_rows(Model, id=model["id"]) == []
    jobs = await db_rows(TrainingJob, id="job_delete_history")
    assert len(jobs) == 1 and jobs[0].model_id is None

    factory = get_session_factory()
    async with factory() as db:
        for table, row_id in (("evaluation_runs", "eval_delete_test"), ("conversations", "conv_delete_test")):
            result = await db.execute(text(f"SELECT model_id FROM public.{table} WHERE id = :id"), {"id": row_id})
            assert result.scalar_one() is None
        for table in ("checkpoints", "model_versions", "model_architectures"):
            result = await db.execute(text(f"SELECT COUNT(*) FROM public.{table} WHERE model_id = :model_id"), {"model_id": model["id"]})
            assert result.scalar_one() == 0

    assert checkpoint_path not in storage.paths("corpus-storage")
    assert tokenizer_path not in storage.paths("corpus-storage")


@pytest.mark.asyncio
async def test_delete_model_is_blocked_while_training_is_active(http):
    model = await _create_model(http, "Busy model")
    factory = get_session_factory()
    async with factory() as db:
        db.add(TrainingJob(
            id="job_delete_running",
            owner_id=uuid.UUID(USER_ID),
            model_id=model["id"],
            status="running",
            engine="pytorch",
            compute="local",
            config={},
        ))
        await db.commit()

    response = await http.delete(f"/api/v1/models/{model['id']}")
    assert response.status_code == 409
    assert "active training jobs" in response.json()["detail"]
    assert len(await db_rows(Model, id=model["id"])) == 1


@pytest.mark.asyncio
async def test_other_user_cannot_delete_model(http, http_as_other):
    model = await _create_model(http, "Private model")
    response = await http_as_other.delete(f"/api/v1/models/{model['id']}")
    assert response.status_code == 403
    assert len(await db_rows(Model, id=model["id"])) == 1
