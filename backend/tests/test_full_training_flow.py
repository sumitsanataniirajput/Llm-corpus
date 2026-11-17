"""End-to-end flow: upload -> select dataset -> create job -> worker trains.

Everything except the Supabase Storage network calls and the PyTorch math runs
as production code (HTTP endpoints, SQLAlchemy models, PostgreSQL, worker DB
writes, metrics/logs endpoints used by the frontend).
"""
import json

import pytest
from sqlalchemy import text

from app.config import settings
from app.core.database import get_session_factory
from app.services import training_worker


@pytest.mark.asyncio
async def test_upload_select_train_full_flow(http, storage, monkeypatch):
    # 1. Create the dataset record (status: pending)
    create = await http.post("/api/v1/datasets/", json={"name": "Full flow corpus", "format": "txt"})
    assert create.status_code == 200, create.text
    dataset = create.json()
    assert dataset["status"] == "pending"
    assert dataset["has_file"] is False

    # 2. Upload the bytes to private storage (status: uploaded)
    body = (b"The corpus is real text used for training a small model.\n" * 30)
    upload = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("fullflow.txt", body, "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    uploaded = upload.json()["dataset"]
    assert uploaded["status"] == "uploaded"
    assert uploaded["file_name"] == "fullflow.txt"

    # 3. The Training page lists datasets from the backend and sees it as usable.
    listed = (await http.get("/api/v1/datasets/")).json()
    selectable = [d for d in listed if d["trainable"]]
    assert [d["id"] for d in selectable] == [dataset["id"]]
    assert selectable[0]["file_size"] == len(body)

    # 4. Model + job creation with the selected dataset id
    model = (await http.post("/api/v1/models/", json={
        "name": "Flow model", "vocab_size": 256, "context_length": 32,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()

    import sys
    import types
    from app.api.endpoints import training as training_endpoints

    fake = types.ModuleType("app.services.training_worker")
    enqueued = []

    async def fake_worker(job_id, owner_id):
        enqueued.append((job_id, owner_id))

    fake.run_training_job = fake_worker
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake)
    monkeypatch.setattr(training_endpoints, "run_training_job", fake_worker, raising=False)

    job_resp = await http.post("/api/v1/training/", json={
        "model_id": model["id"], "dataset_id": dataset["id"],
        "epochs": 1, "batch_size": 2, "learning_rate": 0.001,
    })
    assert job_resp.status_code == 200, job_resp.text
    job = job_resp.json()
    assert job["dataset_id"] == dataset["id"]
    assert job["model_id"] == model["id"]
    assert enqueued and enqueued[0][0] == job["id"]

    # 5. The real worker resolves the dataset and trains (ML engine stubbed).
    metrics = [
        {"step": 1, "loss": 3.25, "learning_rate": 0.001, "tokens_per_second": 90.0},
        {"step": 2, "loss": 2.5, "learning_rate": 0.001, "tokens_per_second": 95.0},
    ]

    def fake_train(text_data, model_config, job_config, on_metric=None):
        assert "The corpus is real text" in text_data
        if on_metric:
            for metric in metrics:
                on_metric(metric)
        return (
            {"vocab_size": 64, "context_length": 32, "d_model": 32, "n_layers": 1,
             "n_heads": 4, "d_ff": 64, "learning_rate": 0.001, "epochs": 1},
            metrics,
            b"checkpoint",
            json.dumps({"vocab_size": 64}).encode(),
            400,
        )

    monkeypatch.setattr(training_worker, "_train_sync", fake_train)
    monkeypatch.setattr(training_worker, "_storage", lambda: storage)

    await training_worker.run_training_job(job["id"], job["owner_id"])

    # 6. Real metrics and logs are exposed to the UI
    fetched_job = (await http.get(f"/api/v1/training/{job['id']}")).json()
    assert fetched_job["status"] == "completed"
    assert fetched_job["dataset_id"] == dataset["id"]

    api_metrics = (await http.get(f"/api/v1/training/{job['id']}/metrics")).json()
    assert [m["step"] for m in api_metrics] == [1, 2]
    assert api_metrics[0]["loss"] == pytest.approx(3.25)
    assert api_metrics[1]["tokens_per_second"] == pytest.approx(95.0)

    logs = (await http.get(f"/api/v1/training/{job['id']}/logs")).json()
    events = [entry["event"] for entry in logs]
    assert events == ["started", "metric", "metric", "completed"]
    assert logs[0]["data"]["dataset_id"] == dataset["id"]
    assert logs[0]["data"]["file_name"] == "fullflow.txt"

    # 7. Artifacts were written to private storage for this owner/job
    paths = storage.paths(settings.STORAGE_BUCKET)
    assert any(p.endswith("model.pt") and job["id"] in p for p in paths)
    assert any(p.endswith("tokenizer.json") and job["id"] in p for p in paths)

    # 8. The dataset reflects the real token count reported by the trainer
    dataset_after = (await http.get(f"/api/v1/datasets/{dataset['id']}")).json()
    assert dataset_after["token_count"] == 400

    # 9. Job list keeps the dataset association
    jobs = (await http.get("/api/v1/training/")).json()
    assert jobs[0]["dataset_id"] == dataset["id"]


@pytest.mark.asyncio
async def test_jobs_with_null_dataset_are_prevented_at_the_api_layer(http):
    """The exact log line 'Select a dataset before starting training.' is now a
    400 response, not a silently queued job that fails in the worker."""
    model = (await http.post("/api/v1/models/", json={
        "name": "No dataset model", "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()

    resp = await http.post("/api/v1/training/", json={"model_id": model["id"]})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Select a dataset before starting training."

    factory = get_session_factory()
    async with factory() as db:
        count = (await db.execute(text(
            "SELECT count(*) AS n FROM public.training_jobs"
        ))).mappings().first()["n"]
    assert count == 0
