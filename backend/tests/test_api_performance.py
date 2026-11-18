"""API performance tests: measured latency and payload size, not guesses.

The dashboard, the Models page and the Training page all read whole collections.
With a realistic number of rows we measure what the API actually costs, so a
future change that turns one of these into an accidental N+1 or an unbounded
payload fails here instead of freezing someone's phone.
"""
import json
import time
import uuid

import pytest
from sqlalchemy import text

from app.core.database import get_session_factory
from tests.conftest import USER_ID

# Generous budgets: these are assertions against pathological regressions
# (N+1 queries, full-table scans, unbounded payloads), not micro-benchmarks.
# A healthy machine finishes each of these in a few tens of milliseconds.
LIST_BUDGET_MS = 1500


async def _seed(owner_id: str, datasets: int, models: int, jobs: int):
    factory = get_session_factory()
    async with factory() as db:
        for i in range(datasets):
            dataset_id = f"ds_perf_{i}"
            await db.execute(text("""
                INSERT INTO public.datasets (id, owner_id, name, format, size, status, created_at, updated_at)
                VALUES (:id, :owner_id, :name, 'txt', 4096, 'uploaded', now() - (:i || ' minutes')::interval, now())
            """), {"id": dataset_id, "owner_id": owner_id, "name": f"Perf corpus {i}", "i": str(i)})
            await db.execute(text("""
                INSERT INTO public.dataset_files (id, dataset_id, storage_path, file_name, file_size, checksum)
                VALUES (:id, :dataset_id, :path, :file_name, 4096, 'deadbeef')
            """), {
                "id": str(uuid.uuid4()),
                "dataset_id": dataset_id,
                "path": f"{owner_id}/datasets/{dataset_id}/f.txt",
                "file_name": f"corpus-{i}.txt",
            })
        for i in range(models):
            await db.execute(text("""
                INSERT INTO public.models (id, owner_id, name, status, config, version, created_at, updated_at)
                VALUES (:id, :owner_id, :name, 'idle', '{}'::jsonb, '1.0.0', now(), now())
            """), {"id": f"model_perf_{i}", "owner_id": owner_id, "name": f"Perf model {i}"})
        for i in range(jobs):
            await db.execute(text("""
                INSERT INTO public.training_jobs (id, owner_id, model_id, dataset_id, status, engine, compute, created_at, updated_at)
                VALUES (:id, :owner_id, 'model_perf_0', 'ds_perf_0', 'completed', 'corpus', 'cpu', now(), now())
            """), {"id": f"job_perf_{i}", "owner_id": owner_id})
        await db.commit()


async def _seed_job_dependencies(owner_id: str, dataset_id: str, model_id: str):
    """A training job needs its model and dataset rows to exist (FKs are real)."""
    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text("""
            INSERT INTO public.models (id, owner_id, name, status, config, version)
            VALUES (:id, :owner_id, 'Perf model', 'idle', '{}'::jsonb, '1.0.0')
        """), {"id": model_id, "owner_id": owner_id})
        await db.execute(text("""
            INSERT INTO public.datasets (id, owner_id, name, format, size, status)
            VALUES (:id, :owner_id, 'Perf corpus', 'txt', 1024, 'uploaded')
        """), {"id": dataset_id, "owner_id": owner_id})
        await db.commit()


async def _timed(coro_factory):
    started = time.perf_counter()
    response = await coro_factory()
    elapsed_ms = (time.perf_counter() - started) * 1000
    return response, elapsed_ms


@pytest.mark.asyncio
async def test_collection_endpoints_stay_fast_with_realistic_rows(http):
    await _seed(USER_ID, datasets=300, models=200, jobs=150)

    datasets_resp, datasets_ms = await _timed(lambda: http.get("/api/v1/datasets/"))
    models_resp, models_ms = await _timed(lambda: http.get("/api/v1/models/"))
    jobs_resp, jobs_ms = await _timed(lambda: http.get("/api/v1/training/"))

    assert datasets_resp.status_code == 200, datasets_resp.text
    assert models_resp.status_code == 200, models_resp.text
    assert jobs_resp.status_code == 200, jobs_resp.text
    assert len(datasets_resp.json()) >= 300
    assert len(models_resp.json()) >= 200
    assert len(jobs_resp.json()) >= 150

    # The dataset list must join file metadata in a bounded number of queries,
    # not one query per dataset (an N+1 would blow past this on 300 rows).
    assert datasets_ms < LIST_BUDGET_MS, f"GET /datasets/ took {datasets_ms:.0f} ms"
    assert models_ms < LIST_BUDGET_MS, f"GET /models/ took {models_ms:.0f} ms"
    assert jobs_ms < LIST_BUDGET_MS, f"GET /training/ took {jobs_ms:.0f} ms"
    print(f"\nmeasured: datasets(300) {datasets_ms:.0f} ms · models(200) {models_ms:.0f} ms · jobs(150) {jobs_ms:.0f} ms")
    print(f"dataset payload: {len(json.dumps(datasets_resp.json())) / 1024:.0f} KB")

    # And the payload must stay proportional to the rows, not to a huge blob.
    assert len(json.dumps(datasets_resp.json())) < 2_000_000


@pytest.mark.asyncio
async def test_metric_history_can_be_windowed_to_the_newest_steps(http):
    """A long run must not stream its whole metric history on every poll."""
    await _seed_job_dependencies(USER_ID, "ds_perf_0", "model_perf_0")
    factory = get_session_factory()
    job_id = "job_metrics_window"
    async with factory() as db:
        await db.execute(text("""
            INSERT INTO public.training_jobs (id, owner_id, model_id, dataset_id, status, engine, compute)
            VALUES (:id, :owner_id, 'model_perf_0', 'ds_perf_0', 'running', 'corpus', 'cpu')
        """), {"id": job_id, "owner_id": USER_ID})
        for step in range(1, 601):
            await db.execute(text("""
                INSERT INTO public.training_metrics (job_id, step, loss, learning_rate, tokens_per_second)
                VALUES (:job_id, :step, :loss, 0.001, 1200)
            """), {"job_id": job_id, "step": step, "loss": 2.5 - step / 1000})
        await db.commit()

    full_resp, full_ms = await _timed(lambda: http.get(f"/api/v1/training/{job_id}/metrics"))
    window_resp, window_ms = await _timed(lambda: http.get(f"/api/v1/training/{job_id}/metrics?limit=200"))

    assert full_resp.status_code == 200, full_resp.text
    assert window_resp.status_code == 200, window_resp.text
    assert len(full_resp.json()) == 600
    window = window_resp.json()
    assert len(window) == 200, "limit must cap the payload"
    # Oldest-first ordering is preserved, and it is the *newest* window.
    assert [row["step"] for row in window] == list(range(401, 601))
    assert len(json.dumps(window_resp.json())) < len(json.dumps(full_resp.json()))
    assert window_ms < LIST_BUDGET_MS, f"windowed metrics took {window_ms:.0f} ms"
    print(f"\nmeasured: metrics full(600) {full_ms:.0f} ms / {len(json.dumps(full_resp.json())) / 1024:.0f} KB · window(200) {window_ms:.0f} ms / {len(json.dumps(window_resp.json())) / 1024:.0f} KB")


@pytest.mark.asyncio
async def test_log_history_can_be_windowed(http):
    await _seed_job_dependencies(USER_ID, "ds_perf_0", "model_perf_0")
    factory = get_session_factory()
    job_id = "job_logs_window"
    async with factory() as db:
        await db.execute(text("""
            INSERT INTO public.training_jobs (id, owner_id, model_id, dataset_id, status, engine, compute)
            VALUES (:id, :owner_id, 'model_perf_0', 'ds_perf_0', 'running', 'corpus', 'cpu')
        """), {"id": job_id, "owner_id": USER_ID})
        for step in range(1, 101):
            await db.execute(text("""
                INSERT INTO public.training_job_events (job_id, event, data)
                VALUES (:job_id, 'metric', '{"step": 1}'::jsonb)
            """), {"job_id": job_id})
        await db.commit()

    full_resp = await http.get(f"/api/v1/training/{job_id}/logs")
    window_resp = await http.get(f"/api/v1/training/{job_id}/logs?limit=25")
    assert full_resp.status_code == 200, full_resp.text
    assert window_resp.status_code == 200, window_resp.text
    assert len(full_resp.json()) == 100
    assert len(window_resp.json()) == 25
