"""Progress truth and deletable job history.

The assertions here are about the two things the UI must never do: invent a
percentage, and let a client delete something it does not own.
"""
import json
import uuid
import pytest
from sqlalchemy import text

from app.core.database import get_session_factory
from app.core.models import TrainingJob
from app.services import training_worker
from tests.conftest import USER_ID, db_rows


# --------------------------------------------------------------- HTTP helpers

async def _create_model(http, name="Progress model"):
    resp = await http.post("/api/v1/models/", json={
        "name": name, "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _create_dataset_with_file(http, content=b"progress corpus text\n" * 80):
    resp = await http.post("/api/v1/datasets/", json={"name": "Progress corpus", "format": "txt"})
    dataset = resp.json()
    up = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("progress.txt", content, "text/plain")},
    )
    assert up.status_code == 200, up.text
    return up.json()["dataset"]


async def _create_queued_job(http, monkeypatch, model_id, dataset_id):
    """Create a job through the real endpoint with the worker disabled."""
    import sys
    import types
    from app.api.endpoints import training as training_endpoints

    fake = types.ModuleType("app.services.training_worker")

    async def run_training_job(job_id, owner_id):
        return None

    fake.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)
    monkeypatch.setattr(training_endpoints, "run_training_job", run_training_job, raising=False)

    resp = await http.post("/api/v1/training/", json={
        "model_id": model_id, "dataset_id": dataset_id, "epochs": 1, "batch_size": 2,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _finish_job(job_id, status="completed", progress=100.0):
    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text("""
            UPDATE public.training_jobs
            SET status = :status, progress_percent = :progress, stage = :status,
                total_steps = 10, completed_steps = 10, current_epoch = 1, total_epochs = 1,
                processed_tokens = 512, last_loss = 1.25,
                progress_updated_at = now(), updated_at = now()
            WHERE id = :job_id
        """), {"job_id": job_id, "status": status, "progress": progress})
        await db.commit()


def _patch_worker(monkeypatch, storage):
    def fake_train(text_data, model_config, job_config, on_metric=None):
        steps = [
            {"step": step, "loss": 2.0 - step * 0.1, "learning_rate": 0.001,
             "tokens_per_second": 100.0 + step, "epoch": 1,
             "completed_steps": step, "total_steps": 4, "total_epochs": 1,
             "processed_tokens": step * 16, "stage": "training"}
            for step in range(1, 5)
        ]
        plan = {"kind": "stage", "stage": "initializing", "total_steps": 4, "total_epochs": 1,
                "completed_steps": 0, "processed_tokens": 0}
        if on_metric:
            on_metric(plan)
            for step in steps:
                on_metric(step)
        return (
            {"vocab_size": 64, "context_length": 16, "d_model": 32, "n_layers": 1,
             "n_heads": 4, "d_ff": 64, "learning_rate": 0.001, "epochs": 1},
            steps, b"checkpoint", json.dumps({"vocab_size": 64}).encode(), 128,
        )

    monkeypatch.setattr(training_worker, "_train_sync", fake_train)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)


# ------------------------------------------------------- real progress numbers

@pytest.mark.asyncio
async def test_progress_comes_from_real_optimizer_steps_and_reaches_100(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])

    _patch_worker(monkeypatch, storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    row = (await db_rows(TrainingJob, id=job["id"]))[0]
    assert row.status == "completed"
    assert row.progress_percent == 100
    assert row.total_steps == 4
    assert row.completed_steps == 4
    assert row.processed_tokens == 64
    assert row.stage == "completed"
    assert row.progress_updated_at is not None

    api = await http.get(f"/api/v1/training/{job['id']}")
    body = api.json()
    assert body["progress_percent"] == 100
    assert body["completed_steps"] == body["total_steps"] == 4


@pytest.mark.asyncio
async def test_progress_never_moves_backwards_and_stage_events_do_not_fake_metrics(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    factory = get_session_factory()

    # Late/duplicate reports must not rewind the bar.
    for completed, percent in ((4, 40.0), (2, 20.0), (6, 60.0)):
        async with factory() as db:
            await training_worker._persist_training_metric(factory, job["id"], {
                "step": completed, "loss": 1.0, "learning_rate": 0.001,
                "tokens_per_second": 10.0, "completed_steps": completed,
                "total_steps": 10, "progress_percent": percent, "stage": "training",
            })
            await db.commit()

    row = (await db_rows(TrainingJob, id=job["id"]))[0]
    assert row.progress_percent == 60
    assert row.completed_steps == 6

    # A stage event is not an optimizer step: no metric row, but the stage moves.
    async with factory() as db:
        await training_worker._persist_training_metric(factory, job["id"], {
            "kind": "stage", "stage": "saving_checkpoints", "total_steps": 10,
        })
        await db.commit()

    async with factory() as db:
        metrics = (await db.execute(text(
            "SELECT count(*) AS n FROM public.training_metrics WHERE job_id = :job_id"
        ), {"job_id": job["id"]})).mappings().first()
    assert metrics["n"] == 3          # one per real step report
    row = (await db_rows(TrainingJob, id=job["id"]))[0]
    assert row.stage == "saving_checkpoints"


def test_the_engine_reports_a_step_total_that_matches_what_it_executes():
    """Uses the real trainer on a tiny corpus — no stubs."""
    text_data = "corpus ultimate progress test corpus. " * 40
    events = []

    cfg, metrics, _checkpoint, _tokenizer, _tokens = training_worker._train_sync(
        text_data,
        {"vocab_size": 128, "context_length": 8, "d_model": 16, "n_layers": 1,
         "n_heads": 2, "d_ff": 32, "dropout": 0.0},
        {"epochs": 1, "batch_size": 2, "gradient_accumulation_steps": 1, "learning_rate": 0.001},
        lambda payload: events.append(payload),
    )

    stages = [event["stage"] for event in events if event.get("kind") == "stage"]
    assert stages[0] == "tokenizing"
    assert "initializing" in stages
    plan = next(event for event in events if event.get("kind") == "stage" and "total_steps" in event)
    steps = [event for event in events if event.get("kind") is None]
    assert plan["total_steps"] == len(steps), "declared total equals the steps actually executed"
    assert [step["completed_steps"] for step in steps] == list(range(1, len(steps) + 1))
    assert steps[-1]["epoch"] == 1
    assert all(step["stage"] == "training" for step in steps)
    assert cfg["epochs"] == 1


@pytest.mark.asyncio
async def test_a_failed_job_keeps_its_real_reason_visible(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])

    def explode(text_data, model_config, job_config, on_metric=None):
        raise RuntimeError("CUDA out of memory while allocating activations")

    monkeypatch.setattr(training_worker, "_train_sync", explode)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)
    await training_worker.run_training_job(job["id"], USER_ID)

    row = (await db_rows(TrainingJob, id=job["id"]))[0]
    assert row.status == "failed"
    assert "out of memory" in (row.failure_reason or "")

    body = (await http.get(f"/api/v1/training/{job['id']}")).json()
    assert body["status"] == "failed"
    assert "out of memory" in body["failure_reason"]


# ------------------------------------------------------------ job-history delete

@pytest.mark.asyncio
async def test_owner_soft_deletes_finished_job_history_and_keeps_everything_else(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    await _finish_job(job["id"])

    resp = await http.delete(f"/api/v1/training/{job['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] == "soft"

    listed = (await http.get("/api/v1/training/")).json()
    assert all(item["id"] != job["id"] for item in listed), "deleted history is not listed"
    assert (await http.get(f"/api/v1/training/{job['id']}")).status_code == 404

    # The row is still there (soft delete) and so are the model and dataset.
    rows = await db_rows(TrainingJob, id=job["id"])
    assert len(rows) == 1 and rows[0].deleted_at is not None
    assert (await http.get(f"/api/v1/models/{model['id']}")).status_code == 200
    assert (await http.get(f"/api/v1/datasets/{dataset['id']}")).status_code == 200


@pytest.mark.asyncio
async def test_hard_delete_removes_only_the_job_rows_and_keeps_the_checkpoint(http, storage, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    await _finish_job(job["id"])

    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text("""
            INSERT INTO public.checkpoints (id, model_id, job_id, storage_path, step, loss)
            VALUES (:id, :model_id, :job_id, :path, 10, 1.0)
        """), {"id": "ckpt_" + uuid.uuid4().hex[:8], "model_id": model["id"],
               "job_id": job["id"], "path": f"{USER_ID}/checkpoints/x/model.pt"})
        await db.commit()

    resp = await http.delete(f"/api/v1/training/{job['id']}?hard=true")
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] == "hard"

    assert (await db_rows(TrainingJob, id=job["id"])) == []
    async with factory() as db:
        checkpoints = (await db.execute(text(
            "SELECT job_id FROM public.checkpoints WHERE model_id = :model_id"
        ), {"model_id": model["id"]})).mappings().all()
    assert len(checkpoints) == 1, "the checkpoint belongs to the model and is preserved"
    assert checkpoints[0]["job_id"] is None


@pytest.mark.asyncio
async def test_active_job_history_cannot_be_deleted(http, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])

    resp = await http.delete(f"/api/v1/training/{job['id']}")
    assert resp.status_code == 409
    assert "Stop it" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_another_user_cannot_delete_or_read_the_job(http, http_as_other, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    await _finish_job(job["id"])

    # The API's established convention for a job the caller does not own is 403.
    resp = await http_as_other.delete(f"/api/v1/training/{job['id']}")
    assert resp.status_code == 403
    assert (await http_as_other.get(f"/api/v1/training/{job['id']}")).status_code == 403
    assert (await http_as_other.delete(f"/api/v1/training/{job['id']}?hard=true")).status_code == 403

    rows = await db_rows(TrainingJob, id=job["id"])
    assert rows[0].deleted_at is None, "the owner's job is untouched"
