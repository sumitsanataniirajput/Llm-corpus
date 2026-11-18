"""Regression tests for cooperative in-process training controls."""
import asyncio
import threading

import pytest

from app.services import training_worker


@pytest.mark.asyncio
async def test_pause_resume_and_stop_signals_reach_the_registered_worker():
    job_id = "control-regression-job"
    control = training_worker._register_job_control(job_id)
    try:
        assert training_worker.request_job_pause(job_id) is True
        assert control["pause"].is_set()

        assert training_worker.request_job_resume(job_id) is True
        assert not control["pause"].is_set()

        assert training_worker.request_job_stop(job_id) is True
        assert control["cancel"].is_set()

        # A cancelled job cannot be paused or resumed again.
        assert training_worker.request_job_pause(job_id) is False
        assert training_worker.request_job_resume(job_id) is False
    finally:
        training_worker._unregister_job_control(job_id, control)


def test_pause_gate_blocks_the_training_thread_until_resume(monkeypatch):
    job_id = "pause-gate-regression-job"
    loop = asyncio.new_event_loop()
    control = {
        "cancel": threading.Event(),
        "pause": threading.Event(),
        "done": asyncio.Event(),
        "loop": loop,
    }
    with training_worker._JOB_CONTROLS_LOCK:
        training_worker._JOB_CONTROLS[job_id] = control

    paused = threading.Event()
    statuses = []

    def record_status(_job_id, status, _control):
        statuses.append(status)
        if status == "paused":
            paused.set()

    monkeypatch.setattr(training_worker, "_set_worker_status_from_thread", record_status)
    try:
        assert training_worker.request_job_pause(job_id) is True
        worker_thread = threading.Thread(target=training_worker._wait_if_paused, args=(job_id,))
        worker_thread.start()

        assert paused.wait(timeout=2), "worker should acknowledge the paused state"
        assert worker_thread.is_alive(), "training thread must stay blocked while paused"

        assert training_worker.request_job_resume(job_id) is True
        worker_thread.join(timeout=2)
        assert not worker_thread.is_alive(), "training thread should continue after resume"
        assert statuses == ["paused", "running"]
    finally:
        training_worker._unregister_job_control(job_id, control)
        loop.close()


def test_pause_and_resume_return_false_without_an_active_worker():
    job_id = "missing-control-regression-job"
    assert training_worker.request_job_pause(job_id) is False
    assert training_worker.request_job_resume(job_id) is False
