"""Model deletion & authorization regression tests.

Covers:
1. Owner can delete their own model (no false 'Not authorized').
2. String vs UUID owner comparison normalization (_same_owner).
3. Another user is denied with 403 'Not authorized' and model/files remain intact.
4. Deleting a trained model removes checkpoints, tokenizer, model storage
   artifacts, training jobs/metrics/events, and evaluation runs — while
   preserving shared datasets and dataset storage files.
5. Storage cleanup failure aborts deletion with 502 instead of misleading success.
6. Active training job blocks unsafe deletion (409) by default, and
   stop_active=true signals the real worker cancellation lifecycle before deleting.
"""
import asyncio
import json
import time
import uuid

import pytest
from sqlalchemy import text

from app.api.endpoints.models import _same_owner
from app.config import settings
from app.core.database import get_session_factory
from app.core.models import Checkpoint, Dataset, EvaluationRun, Model, TrainingJob
from app.services import training_worker
from tests.conftest import OTHER_USER_ID, USER_ID, db_rows


async def _create_model(http, name="Model Alpha"):
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


async def _create_dataset_with_file(http, content=b"shared corpus text for training\n" * 60):
    created = await http.post("/api/v1/datasets/", json={"name": "Shared corpus", "format": "txt"})
    assert created.status_code == 200, created.text
    ds = created.json()
    up = await http.post(
        f"/api/v1/datasets/{ds['id']}/upload",
        files={"file": ("shared.txt", content, "text/plain")},
    )
    assert up.status_code == 200, up.text
    return up.json()["dataset"]


@pytest.mark.asyncio
async def test_owner_can_delete_own_model(http):
    model = await _create_model(http, name="Disposable")
    resp = await http.delete(f"/api/v1/models/{model['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert resp.json()["model_id"] == model["id"]

    assert (await http.get("/api/v1/models/")).json() == []
    assert await db_rows(Model, id=model["id"]) == []


def test_same_owner_handles_string_and_uuid_forms():
    uid = uuid.UUID(USER_ID)
    assert _same_owner(uid, USER_ID) is True
    assert _same_owner(str(uid), uid) is True
    assert _same_owner(str(uid).upper(), str(uid).lower()) is True
    assert _same_owner(OTHER_USER_ID, USER_ID) is False
    assert _same_owner(None, USER_ID) is False


@pytest.mark.asyncio
async def test_other_user_cannot_delete_model(http, http_as_other, storage):
    model = await _create_model(http, name="Private model")

    # Seed a checkpoint in storage for this model to verify it is untouched.
    ckpt_path = f"checkpoints/{USER_ID}/job_x/model.pt"
    storage.put(settings.STORAGE_BUCKET, ckpt_path, b"weights")
    factory = get_session_factory()
    async with factory() as db:
        db.add(Checkpoint(
            id="ckpt_other1",
            model_id=model["id"],
            storage_path=ckpt_path,
            step=1,
            loss=1.0,
        ))
        await db.commit()

    denied = await http_as_other.delete(f"/api/v1/models/{model['id']}")
    assert denied.status_code == 403
    assert denied.json()["detail"] == "Not authorized"

    # Model, checkpoint, and storage object remain intact.
    assert len(await db_rows(Model, id=model["id"])) == 1
    assert len(await db_rows(Checkpoint, id="ckpt_other1")) == 1
    assert storage.get(settings.STORAGE_BUCKET, ckpt_path) == b"weights"


@pytest.mark.asyncio
async def test_delete_trained_model_cleans_artifacts_and_preserves_datasets(http, storage, monkeypatch):
    dataset = await _create_dataset_with_file(http)
    model = await _create_model(http, name="Trained model")

    # Run a real worker slice (stubbing only _train_sync + _storage) so real
    # checkpoints, tokenizers, metrics, events, and model config paths are written.
    import sys
    import types
    from app.api.endpoints import training as training_endpoints

    fake = types.ModuleType("app.services.training_worker")
    enqueued = []

    async def capture_worker(job_id, owner_id):
        enqueued.append((job_id, owner_id))

    fake.run_training_job = capture_worker
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)
    monkeypatch.setattr(training_endpoints, "run_training_job", capture_worker, raising=False)

    job_resp = await http.post("/api/v1/training/", json={
        "model_id": model["id"],
        "dataset_id": dataset["id"],
        "epochs": 1,
        "batch_size": 2,
    })
    assert job_resp.status_code == 200, job_resp.text
    job = job_resp.json()

    def fake_train(text_data, model_config, job_config):
        return (
            {"vocab_size": 64, "context_length": 32, "d_model": 32, "n_layers": 1,
             "n_heads": 4, "d_ff": 64, "learning_rate": 0.001, "epochs": 1},
            [{"step": 1, "loss": 2.1, "learning_rate": 0.001, "tokens_per_second": 100.0}],
            b"pt-weights",
            json.dumps({"vocab_size": 64}).encode(),
            20,
        )

    monkeypatch.setattr(training_worker, "_train_sync", fake_train)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    # Also record an evaluation run referencing this model.
    ev_resp = await http.post("/api/v1/evaluation/run", json={"model_id": model["id"], "test_type": "knowledge"})
    assert ev_resp.status_code == 200

    # Verify both dataset object AND model checkpoint/tokenizer objects exist before delete.
    all_paths_before = set(storage.paths(settings.STORAGE_BUCKET))
    assert dataset["storage_path"] in all_paths_before
    ckpt_path = f"checkpoints/{USER_ID}/{job['id']}/model.pt"
    tok_path = f"tokenizers/{USER_ID}/{job['id']}/tokenizer.json"
    assert ckpt_path in all_paths_before
    assert tok_path in all_paths_before

    del_resp = await http.delete(f"/api/v1/models/{model['id']}")
    assert del_resp.status_code == 200, del_resp.text
    payload = del_resp.json()
    assert payload["ok"] is True
    assert payload["removed_files"] == 2
    assert payload["removed_checkpoints"] == 1
    assert payload["removed_jobs"] == 1

    # Model and its dependent rows are gone.
    assert await db_rows(Model, id=model["id"]) == []
    assert await db_rows(Checkpoint, model_id=model["id"]) == []
    assert await db_rows(TrainingJob, model_id=model["id"]) == []
    assert await db_rows(EvaluationRun, model_id=model["id"]) == []

    # Model checkpoint & tokenizer objects are removed from private storage,
    # while the shared dataset record and dataset file remain untouched.
    all_paths_after = set(storage.paths(settings.STORAGE_BUCKET))
    assert ckpt_path not in all_paths_after
    assert tok_path not in all_paths_after
    assert dataset["storage_path"] in all_paths_after
    assert len(await db_rows(Dataset, id=dataset["id"])) == 1


@pytest.mark.asyncio
async def test_delete_model_reports_storage_failure_and_preserves_model(http, storage, monkeypatch):
    model = await _create_model(http, name="Protected on storage failure")
    ckpt_path = f"checkpoints/{USER_ID}/job_fail/model.pt"
    storage.put(settings.STORAGE_BUCKET, ckpt_path, b"weights")
    factory = get_session_factory()
    async with factory() as db:
        # Ownership comes from the parent model: public.checkpoints has no
        # owner_id column (matches the live schema).
        db.add(Checkpoint(
            id="ckpt_fail1",
            model_id=model["id"],
            storage_path=ckpt_path,
            step=1,
            loss=2.0,
        ))
        await db.commit()

    def broken_remove(_paths):
        raise RuntimeError("Supabase Storage 503")

    monkeypatch.setattr(
        storage.storage,
        "from_",
        lambda _bucket: type("BrokenBucket", (), {"remove": staticmethod(broken_remove)})(),
    )

    resp = await http.delete(f"/api/v1/models/{model['id']}")
    assert resp.status_code == 502
    assert "storage" in resp.json()["detail"].lower()

    # Model and checkpoint were NOT deleted when storage cleanup failed.
    assert len(await db_rows(Model, id=model["id"])) == 1
    assert len(await db_rows(Checkpoint, id="ckpt_fail1")) == 1


@pytest.mark.asyncio
async def test_delete_model_blocks_active_training_and_stops_worker_when_requested(http, storage, monkeypatch):
    dataset = await _create_dataset_with_file(http)
    model = await _create_model(http, name="Active training model")

    # Create a job record and run the worker with an interruptible _train_sync loop.
    job_id = "job_" + uuid.uuid4().hex[:12]
    factory = get_session_factory()
    async with factory() as db:
        db.add(TrainingJob(
            id=job_id,
            owner_id=uuid.UUID(USER_ID),
            model_id=model["id"],
            dataset_id=dataset["id"],
            status="queued",
            engine="pytorch",
            compute="local",
            config={"model_id": model["id"], "dataset_id": dataset["id"], "epochs": 1},
        ))
        await db.commit()

    entered_training = asyncio.Event()
    loop = asyncio.get_running_loop()

    def slow_interruptible_train(text_data, model_config, job_config):
        loop.call_soon_threadsafe(entered_training.set)
        for _ in range(100):
            training_worker._check_not_stopped(job_id)
            time.sleep(0.02)
        raise AssertionError("Worker was never stopped!")

    monkeypatch.setattr(training_worker, "_train_sync", slow_interruptible_train)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)

    worker_task = asyncio.create_task(training_worker.run_training_job(job_id, USER_ID))
    await asyncio.wait_for(entered_training.wait(), timeout=3.0)

    # Without stop_active=true, deletion is refused with 409 Conflict.
    blocked = await http.delete(f"/api/v1/models/{model['id']}")
    assert blocked.status_code == 409
    assert "active training job" in blocked.json()["detail"].lower()
    assert len(await db_rows(Model, id=model["id"])) == 1

    # With stop_active=true, the real worker is signaled, exits cleanly, and deletion succeeds.
    deleted = await http.delete(f"/api/v1/models/{model['id']}?stop_active=true")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["ok"] is True

    await asyncio.wait_for(worker_task, timeout=3.0)
    assert await db_rows(Model, id=model["id"]) == []
    jobs = await db_rows(TrainingJob, id=job_id)
    assert len(jobs) == 1
    assert jobs[0].model_id is None
    assert jobs[0].status == "stopped"
    # Shared dataset still exists.
    assert len(await db_rows(Dataset, id=dataset["id"])) == 1
