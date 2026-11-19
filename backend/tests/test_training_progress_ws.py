"""The progress socket must stream real database rows — never mock metrics."""
import uuid

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.core import websocket_auth
from app.core.database import dispose_engine, get_session_factory
from app.main import app
from tests.conftest import USER_ID


async def _seed_completed_job(http, monkeypatch):
    """Create model + dataset + uploaded file, then a job already completed."""
    model = (await http.post("/api/v1/models/", json={
        "name": "WS model", "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()
    dataset = (await http.post("/api/v1/datasets/", json={"name": "WS corpus", "format": "txt"})).json()
    files = {"file": ("ws.txt", b"websocket corpus\n" * 20, "text/plain")}
    await http.post(f"/api/v1/datasets/{dataset['id']}/upload", files=files)

    import sys
    import types

    fake = types.ModuleType("app.services.training_worker")

    async def run_training_job(job_id, owner_id):
        return None

    fake.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)

    job = (await http.post("/api/v1/training/", json={
        "model_id": model["id"], "dataset_id": dataset["id"], "epochs": 1,
    })).json()

    factory = get_session_factory()
    async with factory() as session:
        await session.execute(text(
            "UPDATE public.training_jobs SET status = 'completed' WHERE id = :id"
        ), {"id": job["id"]})
        await session.execute(text("""
            INSERT INTO public.training_metrics (job_id, step, loss, learning_rate, tokens_per_second)
            VALUES (:job_id, 1, 2.125, 0.001, 300.0), (:job_id, 2, 1.5, 0.001, 310.0)
        """), {"job_id": job["id"]})
        await session.execute(text("""
            INSERT INTO public.training_job_events (job_id, event, data)
            VALUES (:job_id, 'completed', '{"tokens": 40, "final_loss": 1.5}'::jsonb)
        """), {"job_id": job["id"]})
        await session.commit()
    return job


@pytest.mark.asyncio
async def test_ws_streams_real_metrics_and_closes(http, monkeypatch):
    job = await _seed_completed_job(http, monkeypatch)

    async def fake_verify(token):
        return {"id": USER_ID, "email": "tester@example.com"}

    monkeypatch.setattr(websocket_auth, "verify_supabase_token", fake_verify)
    await dispose_engine()  # recreate the engine inside the TestClient loop

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/training/ws/{job['id']}") as ws:
            ws.send_json({"type": "auth", "token": "test-token"})
            status_msg = ws.receive_json()
            assert status_msg["event"] == "status"
            assert status_msg["data"]["status"] == "completed"
            assert status_msg["data"]["dataset_id"] == job["dataset_id"]

            received = []
            while True:
                msg = ws.receive_json()
                received.append(msg)
                if msg["event"] in ("complete", "error"):
                    break

    metric_events = [m for m in received if m["event"] == "metric"]
    assert [m["data"]["step"] for m in metric_events] == [1, 2]
    assert metric_events[0]["data"]["loss"] == pytest.approx(2.125)
    assert metric_events[1]["data"]["tokens_per_second"] == pytest.approx(310.0)
    complete = [m for m in received if m["event"] == "complete"][0]
    assert complete["data"]["status"] == "completed"
    assert complete["data"]["data"]["final_loss"] == 1.5


@pytest.mark.asyncio
async def test_ws_rejects_missing_auth_frame():
    await dispose_engine()
    with TestClient(app) as test_client:
        with pytest.raises(Exception):
            with test_client.websocket_connect("/api/v1/training/ws/job_missing") as ws:
                ws.send_json({"type": "subscribe"})
                ws.receive_json()


@pytest.mark.asyncio
async def test_ws_rejects_foreign_job(http, monkeypatch):
    job = await _seed_completed_job(http, monkeypatch)

    async def fake_verify_other(token):
        return {"id": str(uuid.uuid4()), "email": "other@example.com"}

    monkeypatch.setattr(websocket_auth, "verify_supabase_token", fake_verify_other)
    await dispose_engine()

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/training/ws/{job['id']}") as ws:
            ws.send_json({"type": "auth", "token": "other-token"})
            msg = ws.receive_json()
            assert msg["event"] == "error"
            assert "not found" in msg["data"]["message"]
