"""Multi-device coordination: registration, leases, distribution, collaboration.

No mocks of the coordinator itself — every assertion goes through the real
endpoints and the real database, so a dead device can never hide behind a
passing test.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.core.database import get_session_factory


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


async def _register(http, name="Pixel 7", caps=None):
    resp = await http.post("/api/v1/devices/", json={
        "name": name,
        "device_type": "mobile",
        "platform": "Chrome on Android 14",
        "capabilities": caps or {"webgpu": False, "wasm_simd": True, "cpu_cores": 8,
                                 "device_memory_gb": 4, "execution_method": "cpu-worker"},
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_device_registers_heartbeats_and_lists_with_its_task(http, monkeypatch):
    device = await _register(http)
    assert device["status"] == "online"
    assert device["online"] is True
    assert device["capabilities"]["cpu_cores"] == 8

    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])

    assigned = await http.post(f"/api/v1/devices/{device['id']}/assign", json={
        "job_id": job["id"], "kind": "train",
    })
    assert assigned.status_code == 200, assigned.text
    task = assigned.json()["task"]
    assert task["status"] == "assigned"
    assert task["lease_expires_at"]

    beat = await http.post(f"/api/v1/devices/{device['id']}/heartbeat", json={
        "task_id": task["id"], "progress_percent": 42.5,
    })
    assert beat.status_code == 200, beat.text
    body = beat.json()
    assert body["status"] == "busy"
    assert body["task"]["status"] == "running"
    assert body["task"]["progress_percent"] == 42.5
    assert body["job"]["id"] == job["id"]

    listing = (await http.get("/api/v1/devices/")).json()
    assert [d["id"] for d in listing["devices"]] == [device["id"]]
    assert listing["devices"][0]["task"]["progress_percent"] == 42.5
    assert listing["heartbeat_timeout_seconds"] == 75


@pytest.mark.asyncio
async def test_a_dead_device_loses_its_lease_so_the_work_is_not_stuck(http, monkeypatch):
    device = await _register(http)
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    task = (await http.post(f"/api/v1/devices/{device['id']}/assign", json={"job_id": job["id"]})).json()["task"]

    # Simulate a device that stopped reporting 10 minutes ago.
    factory = get_session_factory()
    stale = datetime.now(timezone.utc) - timedelta(minutes=10)
    async with factory() as db:
        await db.execute(text("UPDATE public.training_devices SET last_heartbeat = :ts WHERE id = :id"),
                         {"ts": stale, "id": device["id"]})
        await db.execute(text("UPDATE public.training_device_tasks SET lease_expires_at = :ts WHERE id = :id"),
                         {"ts": stale, "id": task["id"]})
        await db.commit()

    listing = (await http.get("/api/v1/devices/")).json()
    assert listing["sweep"]["devices_offline"] == 1
    assert listing["sweep"]["tasks_expired"] == 1
    assert listing["devices"][0]["status"] == "offline"
    assert listing["devices"][0]["task"] is None

    # The same job can be handed to a healthy device afterwards.
    second = await _register(http, name="Desktop", caps={"webgpu": True, "cpu_cores": 12})
    again = await http.post(f"/api/v1/devices/{second['id']}/assign", json={"job_id": job["id"]})
    assert again.status_code == 200
    assert again.json()["task"]["status"] == "assigned"


@pytest.mark.asyncio
async def test_pause_resume_and_disconnect_release_the_worker(http, monkeypatch):
    device = await _register(http)
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    task = (await http.post(f"/api/v1/devices/{device['id']}/assign", json={"job_id": job["id"]})).json()["task"]

    paused = (await http.patch(f"/api/v1/devices/{device['id']}", json={"status": "paused"})).json()
    assert paused["status"] == "paused"
    assert paused["task"] is None

    task_row = (await http.get(f"/api/v1/devices/{device['id']}/tasks")).json()["tasks"][0]
    assert task_row["status"] == "expired"

    resumed = (await http.patch(f"/api/v1/devices/{device['id']}", json={"status": "online"})).json()
    assert resumed["status"] == "online"

    re_assigned = (await http.post(f"/api/v1/devices/{device['id']}/assign", json={"job_id": job["id"]})).json()
    assert re_assigned["task"]["id"] != task["id"]

    disconnected = (await http.post(f"/api/v1/devices/{device['id']}/disconnect")).json()
    assert disconnected["status"] == "offline"
    assert disconnected["released_tasks"]


@pytest.mark.asyncio
async def test_removing_a_device_keeps_models_datasets_and_jobs(http, monkeypatch):
    device = await _register(http)
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    await http.post(f"/api/v1/devices/{device['id']}/assign", json={"job_id": job["id"]})

    resp = await http.delete(f"/api/v1/devices/{device['id']}")
    assert resp.status_code == 200 and resp.json()["removed"] is True

    factory = get_session_factory()
    async with factory() as db:
        tasks = (await db.execute(text("SELECT count(*) AS n FROM public.training_device_tasks"))).mappings().first()
    assert tasks["n"] == 0
    assert (await http.get(f"/api/v1/models/{model['id']}")).status_code == 200
    assert (await http.get(f"/api/v1/datasets/{dataset['id']}")).status_code == 200
    assert (await http.get(f"/api/v1/training/{job['id']}")).status_code == 200
    assert (await http.get("/api/v1/devices/")).json()["devices"] == []


@pytest.mark.asyncio
async def test_devices_are_invisible_to_other_accounts(http, http_as_other):
    device = await _register(http)
    other = (await http_as_other.get("/api/v1/devices/")).json()
    assert other["devices"] == []
    assert (await http_as_other.post(f"/api/v1/devices/{device['id']}/heartbeat", json={})).status_code == 404
    assert (await http_as_other.delete(f"/api/v1/devices/{device['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_auto_assign_gives_each_job_to_the_best_device_and_spreads_load(http, monkeypatch):
    low = await _register(http, name="Phone", caps={"webgpu": False, "cpu_cores": 4})
    high = await _register(http, name="Laptop", caps={"webgpu": True, "cpu_cores": 12, "device_memory_gb": 16})

    model = await _create_model(http)
    ds_a = await _create_dataset_with_file(http)
    ds_b = await _create_dataset_with_file(http, content=b"second corpus\n" * 90)
    job_a = await _create_queued_job(http, monkeypatch, model["id"], ds_a["id"])
    job_b = await _create_queued_job(http, monkeypatch, model["id"], ds_b["id"])

    resp = await http.post("/api/v1/devices/auto-assign", json={"job_ids": [job_a["id"], job_b["id"]]})
    assert resp.status_code == 200, resp.text
    assignments = resp.json()["assignments"]
    first, second = assignments
    assert first["assigned"] is True and first["device_id"] == high["id"], "the strongest device takes the first job"
    assert second["assigned"] is True and second["device_id"] == low["id"], "the next job goes to the free device"

    again = await http.post("/api/v1/devices/auto-assign", json={"job_ids": [job_a["id"]]})
    assert again.json()["assignments"][0]["assigned"] is False
    assert "already assigned" in again.json()["assignments"][0]["reason"]


@pytest.mark.asyncio
async def test_collaborative_preprocessing_shards_one_dataset_and_aggregates_results(http, monkeypatch):
    a = await _register(http, name="Phone A")
    b = await _register(http, name="Phone B")
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])

    plan = await http.post("/api/v1/devices/plan/collaborative", json={
        "job_id": job["id"], "device_ids": [a["id"], b["id"]],
    })
    assert plan.status_code == 200, plan.text
    body = plan.json()
    assert body["mode"] == "collaborative-preprocess"
    assert body["shard_count"] == 2
    assert "not implemented" in body["synchronisation"]
    tasks = body["tasks"]
    assert sorted(t["shard_index"] for t in tasks) == [0, 1]

    # Each device finishes its shard with the token count it really produced.
    results = []
    for task, tokens in zip(tasks, (120, 80)):
        done = await http.post(
            f"/api/v1/devices/{task['device_id']}/tasks/{task['id']}/complete",
            json={"detail": {"token_count": tokens}, "status": "completed"},
        )
        assert done.status_code == 200, done.text
        results.append(done.json())
    assert results[0]["aggregate"] is None, "nothing is aggregated until every shard is in"
    aggregate = results[1]["aggregate"]
    assert aggregate["shards"] == 2
    assert aggregate["token_count"] == 200
    assert sorted(aggregate["devices"]) == sorted([a["id"], b["id"]])

    factory = get_session_factory()
    async with factory() as db:
        events = (await db.execute(text(
            "SELECT event, data FROM public.training_job_events WHERE job_id = :job_id"
        ), {"job_id": job["id"]})).mappings().all()
    assert [e["event"] for e in events] == ["device_preprocess_complete"]

    per_job = (await http.get(f"/api/v1/devices/jobs/{job['id']}/tasks")).json()
    assert len(per_job["tasks"]) == 2
    assert {t["device_name"] for t in per_job["tasks"]} == {"Phone A", "Phone B"}


@pytest.mark.asyncio
async def test_task_progress_renews_the_lease_and_rejects_finished_tasks(http, monkeypatch):
    device = await _register(http)
    model = await _create_model(http)
    dataset = await _create_dataset_with_file(http)
    job = await _create_queued_job(http, monkeypatch, model["id"], dataset["id"])
    job_id = job["id"]

    task = (await http.post(f"/api/v1/devices/{device['id']}/assign", json={"job_id": job_id})).json()["task"]
    first = await http.post(f"/api/v1/devices/{device['id']}/tasks/{task['id']}/progress",
                            json={"progress_percent": 10})
    assert first.status_code == 200
    lease_one = first.json()["task"]["lease_expires_at"]

    second = await http.post(f"/api/v1/devices/{device['id']}/tasks/{task['id']}/progress",
                             json={"progress_percent": 55})
    assert second.json()["task"]["lease_expires_at"] >= lease_one

    done = await http.post(f"/api/v1/devices/{device['id']}/tasks/{task['id']}/complete", json={})
    assert done.status_code == 200
    late = await http.post(f"/api/v1/devices/{device['id']}/tasks/{task['id']}/progress",
                           json={"progress_percent": 99})
    assert late.status_code == 409
