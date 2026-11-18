"""Startup recovery: a job whose worker died must not stay "running" forever.

Training runs inside the API process. When that process is replaced (deploy,
crash, OOM) the database keeps the last status it was given. Without recovery,
the monitor polls a job nobody owns and the user is told progress is happening
when nothing is running — the exact "still processing forever" failure this
change set is about.
"""
import datetime
import json
import uuid

import pytest
from sqlalchemy import text

from app.core.database import get_session_factory
from app.services import training_worker


async def _seed_job(job_id, status, updated_at):
    factory = get_session_factory()
    async with factory() as db:
        model_id = "model_" + uuid.uuid4().hex[:8]
        dataset_id = "ds_" + uuid.uuid4().hex[:8]
        await db.execute(
            text(
                """
                INSERT INTO public.models (id, owner_id, name, version, status, config)
                VALUES (:id, :owner, :name, '1', 'idle', '{}'::jsonb)
                """
            ),
            {"id": model_id, "owner": str(uuid.uuid4()), "name": "Recovery model"},
        )
        await db.execute(
            text(
                """
                INSERT INTO public.datasets (id, owner_id, name, format, size, status)
                VALUES (:id, :owner, :name, 'txt', 10, 'uploaded')
                """
            ),
            {"id": dataset_id, "owner": str(uuid.uuid4()), "name": "Recovery dataset"},
        )
        await db.execute(
            text(
                """
                INSERT INTO public.training_jobs (id, owner_id, model_id, dataset_id, status, engine, compute, updated_at)
                VALUES (:id, :owner, :model, :dataset, :status, 'pytorch', 'local', :updated_at)
                """
            ),
            {
                "id": job_id,
                "owner": str(uuid.uuid4()),
                "model": model_id,
                "dataset": dataset_id,
                "status": status,
                "updated_at": updated_at,
            },
        )
        await db.commit()


async def _read(job_id):
    factory = get_session_factory()
    async with factory() as db:
        row = (
            await db.execute(
                text(
                    """
                    SELECT j.status, j.completed_at,
                           (SELECT e.event FROM public.training_job_events e
                            WHERE e.job_id = j.id ORDER BY e.created_at DESC LIMIT 1) AS last_event,
                           (SELECT e.data FROM public.training_job_events e
                            WHERE e.job_id = j.id ORDER BY e.created_at DESC LIMIT 1) AS last_data
                    FROM public.training_jobs j WHERE j.id = :id
                    """
                ),
                {"id": job_id},
            )
        ).first()
        return row


@pytest.mark.asyncio
async def test_a_job_left_running_by_a_dead_process_is_marked_failed_with_a_reason():
    now = datetime.datetime.now(datetime.timezone.utc)
    stale = now - datetime.timedelta(minutes=30)
    job_id = "job_orphan_" + uuid.uuid4().hex[:8]
    await _seed_job(job_id, "running", stale)

    recovered = await training_worker.reconcile_orphaned_jobs(now)

    assert job_id in recovered
    row = await _read(job_id)
    assert row.status == "failed"
    assert row.completed_at is not None
    assert row.last_event == "failed"
    data = row.last_data if isinstance(row.last_data, dict) else json.loads(row.last_data)
    assert "restarted" in data["error"].lower()
    assert data["recovered"] is True


@pytest.mark.asyncio
async def test_a_job_this_process_owns_is_left_alone():
    now = datetime.datetime.now(datetime.timezone.utc)
    job_id = "job_live_" + uuid.uuid4().hex[:8]
    await _seed_job(job_id, "running", now + datetime.timedelta(seconds=1))

    recovered = await training_worker.reconcile_orphaned_jobs(now)

    assert job_id not in recovered
    row = await _read(job_id)
    assert row.status == "running"
    assert row.last_event is None


@pytest.mark.asyncio
async def test_already_finished_jobs_are_not_touched():
    now = datetime.datetime.now(datetime.timezone.utc)
    stale = now - datetime.timedelta(hours=2)
    job_id = "job_done_" + uuid.uuid4().hex[:8]
    await _seed_job(job_id, "completed", stale)

    recovered = await training_worker.reconcile_orphaned_jobs(now)

    assert job_id not in recovered
    row = await _read(job_id)
    assert row.status == "completed"
    assert row.last_event is None
