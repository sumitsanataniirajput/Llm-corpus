"""Worker tests — proves the training worker receives the job's dataset id and
downloads the dataset from private Supabase Storage (fake bucket here), then
records real metrics/checkpoint rows for the job.
"""
import json
import uuid

import pytest
from sqlalchemy import text

from app.config import settings
from app.core.database import get_session_factory
from app.core.models import TrainingJob
from app.services import training_worker
from tests.conftest import USER_ID, db_rows


async def _create_model(http):
    resp = await http.post("/api/v1/models/", json={
        "name": "Worker model", "vocab_size": 256, "context_length": 32,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _create_dataset_with_file(http, content=b"corpus text for training\n" * 50):
    resp = await http.post("/api/v1/datasets/", json={"name": "Worker corpus", "format": "txt"})
    dataset = resp.json()
    files = {"file": ("worker.txt", content, "text/plain")}
    up = await http.post(f"/api/v1/datasets/{dataset['id']}/upload", files=files)
    assert up.status_code == 200, up.text
    return up.json()["dataset"]


async def _create_job(http, monkeypatch, model_id, dataset_id):
    """Create a queued job through the real endpoint, with the worker disabled."""
    import sys
    import types
    from app.api.endpoints import training as training_endpoints

    fake = types.ModuleType("app.services.training_worker")
    calls = []

    async def run_training_job(job_id, owner_id):
        calls.append(job_id)

    fake.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)
    monkeypatch.setattr(training_endpoints, "run_training_job", run_training_job, raising=False)

    resp = await http.post("/api/v1/training/", json={
        "model_id": model_id, "dataset_id": dataset_id, "epochs": 1, "batch_size": 2,
    })
    assert resp.status_code == 200, resp.text
    job = resp.json()
    assert calls == [job["id"]]
    return job


def _patch_worker(monkeypatch, storage, metrics=None):
    """Patch only the ML engine + storage client inside the worker module."""
    metrics = metrics or [
        {"step": 1, "loss": 2.5, "learning_rate": 0.001, "tokens_per_second": 120.0},
        {"step": 2, "loss": 1.75, "learning_rate": 0.001, "tokens_per_second": 130.0},
    ]
    seen = {}

    def fake_train(text_data, model_config, job_config):
        seen["text"] = text_data
        seen["model_config"] = model_config
        seen["job_config"] = job_config
        return (
            {"vocab_size": 64, "context_length": 32, "d_model": 32, "n_layers": 1,
             "n_heads": 4, "d_ff": 64, "learning_rate": 0.001, "epochs": 1},
            metrics,
            b"fake-checkpoint-bytes",
            json.dumps({"vocab_size": 64}).encode(),
            len(text_data.split()),
        )

    monkeypatch.setattr(training_worker, "_train_sync", fake_train)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)
    return seen


@pytest.mark.asyncio
async def test_worker_trains_with_the_job_dataset_from_storage(http, storage, monkeypatch):
    model = await _create_model(http)
    content = b"the real dataset bytes\n" * 60
    dataset = await _create_dataset_with_file(http, content)
    job = await _create_job(http, monkeypatch, model["id"], dataset["id"])

    seen = _patch_worker(monkeypatch, storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    # The worker downloaded exactly the stored object for this job's dataset.
    assert len(storage.downloads) == 1
    assert storage.downloads[0]["bucket"] == settings.STORAGE_BUCKET
    assert storage.downloads[0]["path"] == dataset["storage_path"]
    assert seen["text"].encode() == content
    assert seen["job_config"]["dataset_id"] == dataset["id"]

    rows = await db_rows(TrainingJob, id=job["id"])
    assert rows[0].status == "completed"
    assert rows[0].dataset_id == dataset["id"]

    factory = get_session_factory()
    async with factory() as db:
        metrics = (await db.execute(text(
            "SELECT step, loss FROM public.training_metrics WHERE job_id = :job_id ORDER BY step"
        ), {"job_id": job["id"]})).mappings().all()
        events = (await db.execute(text(
            "SELECT event, data FROM public.training_job_events WHERE job_id = :job_id ORDER BY created_at"
        ), {"job_id": job["id"]})).mappings().all()
        checkpoints = (await db.execute(text(
            "SELECT storage_path FROM public.checkpoints WHERE job_id = :job_id"
        ), {"job_id": job["id"]})).mappings().all()
        dataset_row = (await db.execute(text(
            "SELECT token_count FROM public.datasets WHERE id = :id"
        ), {"id": dataset["id"]})).mappings().first()
        model_row = (await db.execute(text(
            "SELECT status, config FROM public.models WHERE id = :id"
        ), {"id": model["id"]})).mappings().first()

    assert [m["step"] for m in metrics] == [1, 2]
    assert metrics[-1]["loss"] == pytest.approx(1.75)
    assert [e["event"] for e in events] == ["started", "completed"]
    started = events[0]["data"]
    assert started["dataset_id"] == dataset["id"]
    assert started["file_name"] == "worker.txt"
    assert started["storage_path"] == dataset["storage_path"]
    assert len(checkpoints) == 1

    # Checkpoint listing now authorizes through the related model (the live
    # checkpoints table intentionally has no owner_id column).
    checkpoint_response = await http.get(f"/api/v1/training/checkpoints?model_id={model['id']}")
    assert checkpoint_response.status_code == 200, checkpoint_response.text
    assert [row["storage_path"] for row in checkpoint_response.json()] == [checkpoints[0]["storage_path"]]

    assert dataset_row["token_count"] > 0
    assert model_row["status"] == "trained"


@pytest.mark.asyncio
async def test_worker_marks_job_failed_when_dataset_file_is_gone(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_job(http, monkeypatch, model["id"], dataset["id"])

    # Simulate an object removed from the bucket after upload.
    for key in list(storage.objects):
        del storage.objects[key]

    _patch_worker(monkeypatch, storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    rows = await db_rows(TrainingJob, id=job["id"])
    assert rows[0].status == "failed"

    factory = get_session_factory()
    async with factory() as db:
        events = (await db.execute(text(
            "SELECT event, data FROM public.training_job_events WHERE job_id = :job_id ORDER BY created_at"
        ), {"job_id": job["id"]})).mappings().all()
        metrics = (await db.execute(text(
            "SELECT count(*) AS n FROM public.training_metrics WHERE job_id = :job_id"
        ), {"job_id": job["id"]})).mappings().first()

    assert events[-1]["event"] == "failed"
    assert events[-1]["data"]["error"]
    assert metrics["n"] == 0  # no fabricated metrics for a failed job


@pytest.mark.asyncio
async def test_worker_rejects_checksum_mismatch(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_job(http, monkeypatch, model["id"], dataset["id"])

    # Corrupt the stored object.
    storage.put(settings.STORAGE_BUCKET, dataset["storage_path"], b"tampered contents")

    _patch_worker(monkeypatch, storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    rows = await db_rows(TrainingJob, id=job["id"])
    assert rows[0].status == "failed"
    factory = get_session_factory()
    async with factory() as db:
        event = (await db.execute(text(
            "SELECT data FROM public.training_job_events WHERE job_id = :job_id ORDER BY created_at DESC LIMIT 1"
        ), {"job_id": job["id"]})).mappings().first()
    assert "checksum" in event["data"]["error"].lower()


@pytest.mark.asyncio
async def test_worker_refuses_job_without_dataset_id(http, storage, monkeypatch):
    """Defence in depth: even a hand-made job row with NULL dataset fails clearly."""
    model = await _create_model(http)
    factory = get_session_factory()
    job_id = "job_" + uuid.uuid4().hex[:12]
    async with factory() as db:
        db.add(TrainingJob(
            id=job_id,
            owner_id=uuid.UUID(USER_ID),
            model_id=model["id"],
            dataset_id=None,
            status="queued",
            engine="pytorch",
            compute="local",
            config={"model_id": model["id"], "dataset_id": None},
        ))
        await db.commit()

    _patch_worker(monkeypatch, storage)
    await training_worker.run_training_job(job_id, USER_ID)

    rows = await db_rows(TrainingJob, id=job_id)
    assert rows[0].status == "failed"
    factory = get_session_factory()
    async with factory() as db:
        event = (await db.execute(text(
            "SELECT data FROM public.training_job_events WHERE job_id = :job_id"
        ), {"job_id": job_id})).mappings().first()
    assert "Select a dataset" in event["data"]["error"]
    assert storage.downloads == []
