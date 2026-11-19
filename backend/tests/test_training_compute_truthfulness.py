"""P1 — do not offer or accept compute modes the worker cannot execute.

`training_worker._train_sync` trains in the API process on CPU. Connected device
agents preprocess data only. A "cloud" job would be stored with `compute=cloud`
and then silently trained locally, which is exactly the kind of visual
simulation this project must not ship.
"""
import sys
import types

import pytest

from app.core.models import TrainingJob
from tests.conftest import USER_ID, db_rows

pytestmark = pytest.mark.asyncio


async def _create_model(http, name="Compute model"):
    response = await http.post("/api/v1/models/", json={
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


async def _create_dataset(http, name="Compute corpus"):
    response = await http.post("/api/v1/datasets/", json={"name": name, "format": "txt", "size": 0})
    assert response.status_code == 200, response.text
    dataset = response.json()
    uploaded = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("corpus.txt", b"the quick brown fox\n" * 40, "text/plain")},
    )
    assert uploaded.status_code == 200, uploaded.text
    return uploaded.json()["dataset"]


@pytest.fixture
def recorded_jobs(monkeypatch):
    from app.api.endpoints import training as training_endpoints

    calls = []
    fake_module = types.ModuleType("app.services.training_worker")

    async def run_training_job(job_id, owner_id):
        calls.append({"job_id": job_id, "owner_id": owner_id})

    fake_module.run_training_job = run_training_job
    monkeypatch.setitem(sys.modules, "app.services.training_worker", fake_module)
    monkeypatch.setattr(training_endpoints, "run_training_job", run_training_job, raising=False)
    return calls


async def test_cloud_and_device_compute_are_refused_before_a_job_exists(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)

    for compute in ("cloud", "device", "distributed"):
        response = await http.post("/api/v1/training/", json={
            "model_id": model["id"],
            "dataset_id": dataset["id"],
            "compute": compute,
        })
        assert response.status_code == 422, response.text
        assert "in-process CPU" in response.text

    assert await db_rows(TrainingJob) == []
    assert recorded_jobs == []


async def test_local_compute_is_the_only_accepted_mode(http, recorded_jobs):
    model = await _create_model(http)
    dataset = await _create_dataset(http)

    response = await http.post("/api/v1/training/", json={
        "model_id": model["id"],
        "dataset_id": dataset["id"],
        "engine": "pytorch",
        "compute": "local",
        "batch_size": 2,
        "epochs": 1,
    })
    assert response.status_code == 200, response.text
    assert response.json()["compute"] == "local"

    rows = await db_rows(TrainingJob)
    assert len(rows) == 1
    assert rows[0].compute == "local"
    assert str(rows[0].owner_id) == USER_ID
    assert recorded_jobs and recorded_jobs[0]["job_id"] == rows[0].id
