"""Regression tests for cooperative in-process training controls."""
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


def test_pause_and_resume_return_false_without_an_active_worker():
    job_id = "missing-control-regression-job"
    assert training_worker.request_job_pause(job_id) is False
    assert training_worker.request_job_resume(job_id) is False
