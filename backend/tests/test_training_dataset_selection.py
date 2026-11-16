"""Training job creation tests — the regression suite for

    ValueError: Select a dataset before starting training.

A job must never be created with ``dataset_id = null``, with a dataset owned by
another account, or with a dataset whose file was never uploaded. Every
rejection has to be a clear 4xx *before* the job row exists.
"""
import sys
import types

import pytest

from app.core.models import TrainingJob
from tests.conftest import OTHER_USER_ID, USER_ID, db_rows


async def _create_model(http, name="Test model"):
    payload = {
        "name": name,
        "vocab_size": 512,
        "context_length": 64,
        "d_model": 64,
        "n_layers": 2,
        "n_heads": 4,
        "d_ff": 128,
        "dropout": 0.1,
    }
    resp = await http.post("/api/v1/models/", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _create_dataset(http, name="Corpus", upload=True, content=b"the quick brown fox\n" * 40):
    resp = await http.post("/api/v1/datasets/", json={"name": name, "format": "txt", "size": 0})
    assert resp.status_code == 200, resp.text
    dataset = resp.json()
    if upload:
        files = {"file": ("corpus.txt", content, "text/plain")}
        up = await http.post(f"/api/v1/datasets/{dataset['id']}/upload", files=files)
        assert up.status_code == 200, up.text
        dataset = up.json()["dataset"]
    return dataset


@pytest.fixture
def recorded_jobs(monkeypatch):
    """Replace the background worker so tests can assert what was enqueued."""
    from app.api.endpoints import training as training_endpoints

    calls = []

    fake_module = types.ModuleType("app.services.training_worker")

    async def run_training_job(job_id, owner_id):
        calls.append({"job_id": job_id, "owner_id": owner_id})

    fake_module.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake_module)
    monkeypatch.setattr(training_endpoints, "run_training_job", run_training_job, raising=False)
    return calls


@pytest.mark.asyncio
async def test_missing_dataset_id_is_rejected_before_job_creation(http, recorded_jobs):
    model = await _create_model(http)

    resp = await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": None})
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Select a dataset before starting training."
    assert await db_rows(TrainingJob) == []
    assert recorded_jobs == []


@pytest.mark.asyncio
async def test_dataset_id_omitted_is_rejected(http, recorded_jobs):
    model = await _create_model(http)
    resp = await http.post("/api/v1/training/", json={"model_id": model["id"]})
    assert resp.status_code == 400
    assert "Select a dataset" in resp.json()["detail"]
    assert await db_rows(TrainingJob) == []


@pytest.mark.asyncio
async def test_blank_dataset_id_is_rejected(http, recorded_jobs):
    model = await _create_model(http)
    resp = await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": "   "})
    assert resp.status_code == 400
    assert await db_rows(TrainingJob) == []


@pytest.mark.asyncio
async def test_unknown_dataset_is_rejected(http, recorded_jobs):
    model = await _create_model(http)
    resp = await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": "ds_doesnotexist"})
    assert resp.status_code == 404
    assert "Dataset not found" in resp.json()["detail"]
    assert await db_rows(TrainingJob) == []


@pytest.mark.asyncio
async def test_dataset_without_uploaded_file_is_rejected(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http, upload=False)

    resp = await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": dataset["id"]})
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "no uploaded file" in detail
    assert dataset["name"] in detail
    assert await db_rows(TrainingJob) == []
    assert recorded_jobs == []


@pytest.mark.asyncio
async def test_other_users_dataset_is_rejected(http, http_as_other, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)

    resp = await http_as_other.post(
        "/api/v1/training/", json={"model_id": model["id"], "dataset_id": dataset["id"]}
    )
    assert resp.status_code == 404
    assert "Dataset not found" in resp.json()["detail"]
    assert await db_rows(TrainingJob) == []


@pytest.mark.asyncio
async def test_other_users_model_is_rejected(http, http_as_other, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http, name="Other corpus")

    # Give the second user their own dataset so only the model is foreign.
    other_resp = await http_as_other.post("/api/v1/datasets/", json={"name": "Theirs", "format": "txt"})
    other_dataset = other_resp.json()
    files = {"file": ("theirs.txt", b"their own corpus text\n" * 10, "text/plain")}
    await http_as_other.post(f"/api/v1/datasets/{other_dataset['id']}/upload", files=files)

    resp = await http_as_other.post(
        "/api/v1/training/", json={"model_id": model["id"], "dataset_id": other_dataset["id"]}
    )
    assert resp.status_code == 404
    assert "Model not found" in resp.json()["detail"]
    assert await db_rows(TrainingJob) == []
    assert dataset["id"] != other_dataset["id"]


@pytest.mark.asyncio
async def test_valid_dataset_creates_job_with_dataset_id(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)

    resp = await http.post(
        "/api/v1/training/",
        json={
            "model_id": model["id"],
            "dataset_id": dataset["id"],
            "engine": "pytorch",
            "compute": "local",
            "batch_size": 2,
            "epochs": 1,
            "learning_rate": 0.001,
        },
    )
    assert resp.status_code == 200, resp.text
    job = resp.json()
    assert job["dataset_id"] == dataset["id"]
    assert job["model_id"] == model["id"]
    assert job["status"] == "queued"

    rows = await db_rows(TrainingJob)
    assert len(rows) == 1
    assert rows[0].dataset_id == dataset["id"]
    assert rows[0].config["dataset_id"] == dataset["id"]

    # The background worker was enqueued with the real job id and owner.
    assert recorded_jobs == [{"job_id": job["id"], "owner_id": USER_ID}]


@pytest.mark.asyncio
async def test_dataset_id_is_trimmed_and_resolved_server_side(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)

    resp = await http.post(
        "/api/v1/training/", json={"model_id": model["id"], "dataset_id": f"  {dataset['id']} "}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dataset_id"] == dataset["id"]
    rows = await db_rows(TrainingJob)
    assert rows[0].dataset_id == dataset["id"]


@pytest.mark.asyncio
async def test_list_jobs_exposes_dataset_id(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)
    await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": dataset["id"]})

    jobs = (await http.get("/api/v1/training/")).json()
    assert len(jobs) == 1
    assert jobs[0]["dataset_id"] == dataset["id"]


@pytest.mark.asyncio
async def test_jobs_are_scoped_to_the_owner(http, http_as_other, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)
    await http.post("/api/v1/training/", json={"model_id": model["id"], "dataset_id": dataset["id"]})

    assert (await http_as_other.get("/api/v1/training/")).json() == []

    # Another account must not be able to read someone else's dataset id either.
    assert OTHER_USER_ID != USER_ID
