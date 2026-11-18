"""Small, real CPU training worker for CORPUS ULTIMATE.

This first production slice deliberately limits model/data sizes for Render's
free CPU instance. Jobs run in-process; use a dedicated queue worker for scale.
"""
import asyncio
import contextvars
import hashlib
import io
import json
import logging
import math
import threading
import time
import uuid
from datetime import datetime, timezone

import torch
from sqlalchemy import text, select
from torch.utils.data import DataLoader, TensorDataset
from supabase import create_client

from app.config import settings
from app.core.database import get_session_factory
from app.services.telemetry import collect_runtime_sample, persist_snapshot
from app.services.text_extraction import DatasetTextError, extract_text
from app.core.models import Dataset, Model, TrainingJob
from corpus_engine.tokenizer.tokenizer import CorpusTokenizer
from corpus_engine.pytorch_engine.pytorch_trainer import PyTorchTrainer

logger = logging.getLogger("corpus.training")

# Dataset statuses the worker refuses to train on.
UNUSABLE_DATASET_STATUSES = {"failed", "deleted"}

_CURRENT_JOB_ID: contextvars.ContextVar[str] = contextvars.ContextVar("_CURRENT_JOB_ID", default="")
_JOB_CONTROLS_LOCK = threading.Lock()
_JOB_CONTROLS = {}  # job_id -> {"cancel": threading.Event, "done": asyncio.Event, "loop": AbstractEventLoop}
# Hardware telemetry is sampled at most this often per job, so a fast run cannot
# flood the snapshot table with hundreds of near-identical rows.
_TELEMETRY_MIN_INTERVAL = 10.0
_LAST_TELEMETRY = {}  # job_id -> monotonic timestamp of the last persisted sample


class TrainingStoppedError(Exception):
    """Raised when an active training job is stopped via the worker lifecycle."""


def _register_job_control(job_id: str):
    loop = asyncio.get_running_loop()
    ctrl = {
        "cancel": threading.Event(),
        "pause": threading.Event(),
        "done": asyncio.Event(),
        "loop": loop,
    }
    with _JOB_CONTROLS_LOCK:
        _JOB_CONTROLS[job_id] = ctrl
    return ctrl


def _unregister_job_control(job_id: str, ctrl: dict):
    try:
        ctrl["done"].set()
    except Exception:
        pass
    with _JOB_CONTROLS_LOCK:
        if _JOB_CONTROLS.get(job_id) is ctrl:
            _JOB_CONTROLS.pop(job_id, None)


def is_job_running(job_id: str) -> bool:
    with _JOB_CONTROLS_LOCK:
        return job_id in _JOB_CONTROLS


def request_job_stop(job_id: str) -> bool:
    """Signal an in-process training job to stop cleanly."""
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if not ctrl:
            return False
        ctrl["cancel"].set()
        return True


def request_job_pause(job_id: str) -> bool:
    """Ask an active worker to pause at its next optimizer-step boundary."""
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if not ctrl or ctrl["done"].is_set() or ctrl["cancel"].is_set():
            return False
        ctrl["pause"].set()
        return True


def request_job_resume(job_id: str) -> bool:
    """Release a paused worker so training can continue."""
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if not ctrl or ctrl["done"].is_set() or ctrl["cancel"].is_set():
            return False
        ctrl["pause"].clear()
        return True


async def stop_and_wait_for_job(job_id: str, timeout: float = 5.0) -> bool:
    """Signal an active in-process training job to stop and wait for exit.

    Returns True if no in-process worker remains active for ``job_id``.
    """
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if not ctrl:
            return True
        ctrl["cancel"].set()
        done_event = ctrl["done"]
    try:
        await asyncio.wait_for(done_event.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return not is_job_running(job_id)


ORPHANED_JOB_MESSAGE = (
    "The backend restarted before this job finished, so the worker that owned it "
    "is gone. The job was marked failed instead of reporting progress forever."
)


async def reconcile_orphaned_jobs(started_at=None) -> list:
    """Fail jobs left mid-flight by a previous process.

    A training job runs inside this process. If the process is replaced
    (deploy, crash, OOM kill) while a job is queued/running/paused, its row keeps
    saying "running" forever: every client shows a task that can never finish,
    the monitor polls a job nobody owns, and the user never learns it died.
    Anything not updated since this process started cannot belong to it, so it
    is given a real terminal state (and an explanatory event) at startup.

    Non-destructive: rows are updated, never deleted, and a job updated after
    `started_at` is left alone.
    """
    if started_at is None:
        started_at = datetime.now(timezone.utc)

    factory = get_session_factory()
    recovered = []
    async with factory() as db:
        rows = await db.execute(
            text(
                """
                UPDATE public.training_jobs
                SET status = 'interrupted', updated_at = now(), completed_at = now(),
                    stage = 'interrupted', failure_reason = :reason, progress_updated_at = now()
                WHERE status IN ('queued', 'preparing', 'running', 'pausing', 'paused', 'stopping')
                  AND updated_at < :started_at
                RETURNING id
                """
            ),
            {"started_at": started_at, "reason": ORPHANED_JOB_MESSAGE},
        )
        recovered = [row[0] for row in rows.fetchall()]
        for job_id in recovered:
            await db.execute(
                text(
                    """
                    INSERT INTO public.training_job_events (job_id, event, data)
                    VALUES (:job_id, 'interrupted', CAST(:data AS jsonb))
                    """
                ),
                {"job_id": job_id, "data": json.dumps({"error": ORPHANED_JOB_MESSAGE, "recovered": True})},
            )
        await db.commit()
    return recovered


def _check_not_stopped(job_id: str):
    if not job_id:
        return
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if ctrl and ctrl["cancel"].is_set():
            raise TrainingStoppedError("Training job was stopped.")


async def _persist_worker_status(job_id: str, status: str):
    """Persist a worker-observed pause/resume state for the live monitor."""
    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text("""
            UPDATE public.training_jobs
            SET status = :status, updated_at = now()
            WHERE id = :job_id
              AND status NOT IN ('completed', 'failed', 'stopped', 'cancelled', 'stopping')
        """), {"job_id": job_id, "status": status})
        await db.commit()


def _set_worker_status_from_thread(job_id: str, status: str, ctrl: dict):
    """Bridge a synchronous PyTorch callback back to the worker's async DB loop."""
    future = asyncio.run_coroutine_threadsafe(
        _persist_worker_status(job_id, status),
        ctrl["loop"],
    )
    future.result(timeout=30)


def _wait_if_paused(job_id: str):
    """Block the training thread at an optimizer-step boundary until resumed."""
    if not job_id:
        return
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
    if not ctrl:
        _check_not_stopped(job_id)
        return
    _check_not_stopped(job_id)
    if not ctrl["pause"].is_set():
        return

    _set_worker_status_from_thread(job_id, "paused", ctrl)
    while ctrl["pause"].is_set():
        _check_not_stopped(job_id)
        time.sleep(0.1)
    _check_not_stopped(job_id)
    _set_worker_status_from_thread(job_id, "running", ctrl)


def _now():
    return datetime.now(timezone.utc)


def _storage():
    if not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Training storage is not configured: add SUPABASE_SERVICE_ROLE_KEY to the Render backend environment.")
    if not settings.SUPABASE_URL:
        raise RuntimeError("SUPABASE_URL is not configured.")
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


def _upload_bytes(client, bucket, path, data, content_type):
    client.storage.from_(bucket).upload(
        path, data,
        file_options={"content-type": content_type, "upsert": "true"},
    )


def _stage(on_metric, stage, **extra):
    """Report a lifecycle stage through the same channel as metrics.

    Progress must describe the run the engine is actually executing. The worker
    emits a stage update when it enters a phase, and a metric per completed
    optimizer step; the API then persists both (see _persist_training_metric).
    """
    if on_metric is None:
        return
    payload = {"kind": "stage", "stage": stage}
    payload.update(extra)
    on_metric(payload)


def _train_sync(text_data, model_config, job_config, on_metric=None):
    torch.manual_seed(int(job_config.get("seed", 42)))
    # Safe limits for the Render free CPU service.
    context = max(8, min(int(model_config.get("context_length", 64)), 64))
    d_model = max(16, min(int(model_config.get("d_model", 64)), 64))
    heads = max(1, min(int(model_config.get("n_heads", 4)), 4))
    while d_model % heads:
        heads -= 1
    cfg = {
        "vocab_size": min(max(int(model_config.get("vocab_size", 512)), 16), 2048),
        "context_length": context,
        "d_model": d_model,
        "n_layers": max(1, min(int(model_config.get("n_layers", 2)), 2)),
        "n_heads": heads,
        "d_ff": max(32, min(int(model_config.get("d_ff", 128)), 128)),
        "dropout": min(max(float(model_config.get("dropout", 0.1)), 0.0), 0.3),
        "learning_rate": min(max(float(job_config.get("learning_rate", 0.001)), 1e-5), 0.01),
        "epochs": max(1, min(int(job_config.get("epochs", 1)), 3)),
    }
    _stage(on_metric, "tokenizing", total_epochs=cfg["epochs"])
    tokenizer = CorpusTokenizer(vocab_size=cfg["vocab_size"])
    tokenizer.train([text_data])
    ids = tokenizer.encode(text_data, add_special=False)
    cfg["vocab_size"] = max(tokenizer.get_vocab_size(), 4)
    if len(ids) <= context:
        raise ValueError("Dataset is too short. Upload more text so it contains at least context_length + 1 tokens.")
    xs, ys = [], []
    stride = max(1, context // 2)
    for start in range(0, len(ids) - context, stride):
        chunk = ids[start:start + context + 1]
        if len(chunk) == context + 1:
            xs.append(chunk[:-1])
            ys.append(chunk[1:])
    if not xs:
        raise ValueError("Could not create training sequences from this dataset.")
    x = torch.tensor(xs, dtype=torch.long)
    y = torch.tensor(ys, dtype=torch.long)
    batch_size = max(1, min(int(job_config.get("batch_size", 2)), 4))
    accum_steps = max(1, min(int(job_config.get("gradient_accumulation_steps", 1)), 4))
    loader = DataLoader(TensorDataset(x, y), batch_size=batch_size, shuffle=True)
    # Optimizer steps actually executed: accumulate_grad divides the batches.
    micro_batches_per_epoch = math.ceil(len(xs) / batch_size)
    steps_per_epoch = math.ceil(micro_batches_per_epoch / accum_steps)
    total_steps = max(1, steps_per_epoch * cfg["epochs"])
    sequence_lengths = [len(chunk) for chunk in xs]
    _stage(
        on_metric,
        "initializing",
        total_steps=total_steps,
        total_epochs=cfg["epochs"],
        completed_steps=0,
        processed_tokens=0,
        # Measured by the tokenizer/loader that will actually be trained on.
        # There is no held-out split in this engine, so val/test stay null
        # instead of pretending a split exists.
        dataset_analytics={
            "records": len(xs),
            "tokens": len(ids),
            "train_tokens": len(ids),
            "validation_tokens": None,
            "test_tokens": None,
            "avg_tokens_per_sample": round(sum(sequence_lengths) / len(sequence_lengths), 2),
            "max_sample_length": max(sequence_lengths),
            "min_sample_length": min(sequence_lengths),
            "vocab_size": cfg["vocab_size"],
            "context_length": context,
            "stride": stride,
            "tokenization_status": "tokenized",
            "cleaning_status": "raw extracted text, no filtering applied",
            "split": {"train": 1.0},
        },
    )
    trainer = PyTorchTrainer(cfg, device="cpu")
    metrics = []
    started = time.monotonic()
    current_job_id = _CURRENT_JOB_ID.get("")
    processed_tokens = 0
    def report_optimizer_step(step_data):
        nonlocal processed_tokens
        _wait_if_paused(current_job_id)
        processed_tokens += int(step_data.get("tokens") or (int(loader.batch_size or 1) * context))
        elapsed = max(time.monotonic() - started, 0.001)
        completed = int(step_data["step"])
        metric = {
            "step": completed,
            "loss": float(step_data["loss"]),
            "learning_rate": float(trainer.optimizer.param_groups[0]["lr"]),
            "tokens_per_second": float(processed_tokens / elapsed),
            # trainer.epoch is incremented at the end of an epoch, so the epoch
            # currently being trained is epoch + 1 (1-based for humans).
            "epoch": min(cfg["epochs"], int(trainer.epoch) + 1),
            "completed_steps": completed,
            "total_steps": total_steps,
            "total_epochs": cfg["epochs"],
            "processed_tokens": processed_tokens,
            "stage": "training",
        }
        metrics.append(metric)
        if on_metric is not None:
            on_metric(metric)

    for epoch in range(cfg["epochs"]):
        _check_not_stopped(current_job_id)
        trainer.train_epoch(
            loader,
            clip_grad=float(job_config.get("gradient_clip", 1.0)),
            accum_steps=accum_steps,
            on_step=report_optimizer_step,
        )
        _check_not_stopped(current_job_id)
    if not metrics:
        raise RuntimeError("Training completed without producing an optimizer step or metric.")
    buffer = io.BytesIO()
    torch.save({
        "model_state": trainer.model.state_dict(),
        "config": cfg,
        "epoch": trainer.epoch,
        "global_step": trainer.global_step,
        "tokenizer": tokenizer.token_to_id,
        "special_tokens": tokenizer.special_tokens,
    }, buffer)
    tokenizer_json = json.dumps({
        "vocab_size": tokenizer.vocab_size,
        "special_tokens": tokenizer.special_tokens,
        "token_to_id": tokenizer.token_to_id,
    }, ensure_ascii=False).encode("utf-8")
    return cfg, metrics, buffer.getvalue(), tokenizer_json, len(ids)


async def _set_stage(factory, job_id: str, stage: str, progress_percent=None):
    """Record a lifecycle stage (and optional measured percent) on the job row."""
    async with factory() as db:
        await db.execute(text("""
            UPDATE public.training_jobs
            SET stage = :stage,
                progress_percent = COALESCE(:percent, progress_percent),
                progress_updated_at = now(), updated_at = now()
            WHERE id = :job_id
        """), {"job_id": job_id, "stage": stage, "percent": progress_percent})
        await db.commit()


async def _persist_job_progress(db, job_id: str, payload: dict):
    """Write the run's real position onto the job row.

    Percent comes only from the engine's own step counter. ``GREATEST`` keeps a
    replayed or out-of-order event from moving the bar backwards, and a
    completed job stays at 100.
    """
    completed = payload.get("completed_steps")
    total = payload.get("total_steps")
    percent = payload.get("progress_percent")
    if percent is None and completed is not None and total:
        percent = min(100.0, max(0.0, (float(completed) / float(total)) * 100.0))
    await db.execute(text("""
        UPDATE public.training_jobs
        SET stage = COALESCE(:stage, stage),
            completed_steps = GREATEST(COALESCE(completed_steps, 0), COALESCE(:completed_steps, 0)),
            total_steps = COALESCE(:total_steps, total_steps),
            total_epochs = COALESCE(:total_epochs, total_epochs),
            current_epoch = GREATEST(COALESCE(current_epoch, 0), COALESCE(:current_epoch, 0)),
            processed_tokens = GREATEST(COALESCE(processed_tokens, 0), COALESCE(:processed_tokens, 0)),
            last_loss = COALESCE(:last_loss, last_loss),
            progress_percent = GREATEST(COALESCE(progress_percent, 0), COALESCE(:percent, 0)),
            progress_updated_at = now(),
            updated_at = now()
        WHERE id = :job_id
    """), {
        "job_id": job_id,
        "stage": payload.get("stage"),
        "completed_steps": completed,
        "total_steps": total,
        "total_epochs": payload.get("total_epochs"),
        "current_epoch": payload.get("current_epoch", payload.get("epoch")),
        "processed_tokens": payload.get("processed_tokens"),
        "last_loss": payload.get("last_loss", payload.get("loss")),
        "percent": percent,
    })


async def _telemetry_due(job_id: str) -> bool:
    now = time.monotonic()
    last = _LAST_TELEMETRY.get(job_id)
    if last is not None and now - last < _TELEMETRY_MIN_INTERVAL:
        return False
    _LAST_TELEMETRY[job_id] = now
    return True


async def _sample_telemetry(factory, db, job_id: str, *, stage: str = "training",
                            step=None, force: bool = False) -> None:
    """Persist one hardware sample for this job (throttled unless forced)."""
    if not force and not await _telemetry_due(job_id):
        return
    if force:
        _LAST_TELEMETRY[job_id] = time.monotonic()
    owner_id = (await db.execute(text(
        "SELECT owner_id FROM public.training_jobs WHERE id = :job_id"
    ), {"job_id": job_id})).scalar_one_or_none()
    if owner_id is None:
        return
    try:
        sample = collect_runtime_sample(stage=stage, step=step, worker_count=1)
        await persist_snapshot(db, owner_id, job_id, sample)
    except Exception:  # telemetry must never break training
        logger.debug("Telemetry sample failed for %s", job_id, exc_info=True)


async def _upsert_dataset_analytics(db, job_id: str, analytics: dict) -> None:
    owner_id = (await db.execute(text(
        "SELECT owner_id, dataset_id FROM public.training_jobs WHERE id = :job_id"
    ), {"job_id": job_id})).mappings().first()
    if owner_id is None:
        return
    existing = (await db.execute(text(
        "SELECT id FROM public.training_dataset_analytics WHERE job_id = :job_id LIMIT 1"
    ), {"job_id": job_id})).scalar_one_or_none()
    if existing is not None:
        await db.execute(text("""
            UPDATE public.training_dataset_analytics
            SET records = :records, tokens = :tokens, train_tokens = :train_tokens,
                validation_tokens = :validation_tokens, test_tokens = :test_tokens,
                avg_tokens_per_sample = :avg_tokens, max_sample_length = :max_len,
                min_sample_length = :min_len, cleaning_status = :cleaning,
                tokenization_status = :tokenization, split = CAST(:split AS jsonb),
                updated_at = now()
            WHERE id = :id
        """), {
            "id": existing, "records": analytics.get("records"), "tokens": analytics.get("tokens"),
            "train_tokens": analytics.get("train_tokens"),
            "validation_tokens": analytics.get("validation_tokens"),
            "test_tokens": analytics.get("test_tokens"),
            "avg_tokens": analytics.get("avg_tokens_per_sample"),
            "max_len": analytics.get("max_sample_length"),
            "min_len": analytics.get("min_sample_length"),
            "cleaning": analytics.get("cleaning_status"),
            "tokenization": analytics.get("tokenization_status"),
            "split": json.dumps(analytics.get("split") or {}),
        })
        return
    await db.execute(text("""
        INSERT INTO public.training_dataset_analytics
        (id, owner_id, job_id, dataset_id, records, accepted_records, rejected_records,
         duplicate_records, tokens, train_tokens, validation_tokens, test_tokens,
         avg_tokens_per_sample, max_sample_length, min_sample_length,
         language_distribution, subject_distribution, source_distribution,
         cleaning_status, tokenization_status, split, updated_at)
        VALUES (gen_random_uuid(), :owner_id, :job_id, :dataset_id, :records, NULL, NULL, NULL,
                :tokens, :train_tokens, :validation_tokens, :test_tokens,
                :avg_tokens, :max_len, :min_len,
                CAST(:languages AS jsonb), CAST(:subjects AS jsonb), CAST(:sources AS jsonb),
                :cleaning, :tokenization, CAST(:split AS jsonb), now())
    """), {
        "owner_id": owner_id["owner_id"], "job_id": job_id, "dataset_id": owner_id["dataset_id"],
        "records": analytics.get("records"), "tokens": analytics.get("tokens"),
        "train_tokens": analytics.get("train_tokens"),
        "validation_tokens": analytics.get("validation_tokens"),
        "test_tokens": analytics.get("test_tokens"),
        "avg_tokens": analytics.get("avg_tokens_per_sample"),
        "max_len": analytics.get("max_sample_length"),
        "min_len": analytics.get("min_sample_length"),
        # Plain text extraction does not detect a language or a subject; the UI
        # shows "unknown" rather than a fabricated label.
        "languages": json.dumps({"unknown": int(analytics.get("records") or 0)}),
        "subjects": json.dumps({"unknown": int(analytics.get("records") or 0)}),
        "sources": json.dumps({"dataset_file": int(analytics.get("records") or 0)}),
        "cleaning": analytics.get("cleaning_status"),
        "tokenization": analytics.get("tokenization_status"),
        "split": json.dumps(analytics.get("split") or {}),
    })


async def _persist_training_metric(factory, job_id: str, metric: dict):
    """Persist each genuine optimizer-step metric before the worker advances.

    Stage events (``kind == "stage"``) update the job's lifecycle stage and the
    run plan (total steps/epochs) without writing a fake metric row.
    """
    async with factory() as db:
        if metric.get("kind") == "stage":
            await _persist_job_progress(db, job_id, metric)
            if metric.get("dataset_analytics"):
                try:
                    await _upsert_dataset_analytics(db, job_id, metric["dataset_analytics"])
                except Exception:
                    logger.debug("Dataset analytics write failed for %s", job_id, exc_info=True)
            await _sample_telemetry(factory, db, job_id, stage=metric.get("stage") or "training")
            await db.commit()
            return
        await db.execute(text("""
            INSERT INTO public.training_metrics
            (job_id, step, loss, learning_rate, tokens_per_second)
            VALUES (:job_id, :step, :loss, :learning_rate, :tokens_per_second)
        """), {
            "job_id": job_id,
            "step": metric["step"],
            "loss": metric["loss"],
            "learning_rate": metric["learning_rate"],
            "tokens_per_second": metric["tokens_per_second"],
        })
        await _persist_job_progress(db, job_id, metric)
        await _sample_telemetry(factory, db, job_id, stage="training", step=metric.get("step"))
        await db.commit()


async def run_training_job(job_id: str, owner_id: str):
    factory = get_session_factory()
    ctrl = _register_job_control(job_id)
    try:
        await _set_stage(factory, job_id, "preparing")
    except Exception:
        logger.exception("Could not record the preparing stage for %s", job_id)
    token = _CURRENT_JOB_ID.set(job_id)
    try:
        async with factory() as db:
            result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
            job = result.scalar_one_or_none()
            if not job or str(job.owner_id) != owner_id:
                return
            if job.status in {"stopping", "stopped", "cancelled"} or ctrl["cancel"].is_set():
                raise TrainingStoppedError("Training job was stopped before starting.")
            dataset_id = job.dataset_id
            model_id = job.model_id
            if not dataset_id:
                raise ValueError("Select a dataset before starting training.")
            if not model_id:
                raise ValueError("Select a model before starting training.")
            # The job's dataset must belong to the same account.
            dataset_result = await db.execute(select(Dataset).where(
                Dataset.id == dataset_id, Dataset.owner_id == job.owner_id
            ))
            dataset = dataset_result.scalar_one_or_none()
            if not dataset:
                raise ValueError("The selected dataset was not found or is not owned by this account.")
            if dataset.status in UNUSABLE_DATASET_STATUSES:
                raise ValueError(
                    f"Dataset '{dataset.name}' is {dataset.status} and cannot be used for training. "
                    "Upload it again in Dataset Manager."
                )
            model_result = await db.execute(select(Model).where(Model.id == model_id, Model.owner_id == job.owner_id))
            model = model_result.scalar_one_or_none()
            if not model:
                raise ValueError("The selected model was not found or is not owned by this account.")
            file_result = await db.execute(text(
                "SELECT df.storage_path, df.file_name, df.checksum "
                "FROM public.dataset_files df "
                "JOIN public.datasets d ON d.id = df.dataset_id "
                "WHERE df.dataset_id = :dataset_id AND d.owner_id = :owner_id "
                "ORDER BY df.uploaded_at DESC LIMIT 1"
            ), {"dataset_id": dataset_id, "owner_id": job.owner_id})
            file_row = file_result.mappings().first()
            if not file_row:
                raise ValueError("This dataset has no stored file. Re-upload the dataset before training.")
            expected_checksum = file_row["checksum"]
            client = _storage()
            bucket = settings.STORAGE_BUCKET
            # Supabase SDK calls are synchronous: run them in a worker thread so
            # the whole API's event loop is not blocked during the transfer.
            raw = await asyncio.to_thread(
                client.storage.from_(bucket).download, file_row["storage_path"]
            )
            if isinstance(raw, dict):
                raw = raw.get("data", b"")
            if isinstance(raw, str):
                raw = raw.encode("utf-8", errors="replace")
            if not raw:
                raise ValueError("The stored dataset file is empty or could not be downloaded.")
            if expected_checksum:
                actual_checksum = hashlib.sha256(raw).hexdigest()
                if actual_checksum != expected_checksum:
                    raise ValueError(
                        "The stored dataset file does not match the checksum recorded at upload time. "
                        "Re-upload the dataset before training."
                    )
            try:
                text_data = extract_text(raw, file_row["file_name"])
            except DatasetTextError as exc:
                raise ValueError(str(exc)) from exc
            if not text_data.strip():
                raise ValueError("The uploaded dataset contains no readable text.")
            model_config = dict(model.config or {})
            job_config = dict(job.config or {})
            dataset_name = dataset.name
            file_name = file_row["file_name"]
            logger.info(
                "Starting training job %s with dataset %s (%s) from storage path %s",
                job_id, dataset_id, file_name, file_row["storage_path"],
            )
            job.status = "running"
            job.updated_at = _now()
            await db.execute(text("""
                INSERT INTO public.training_job_events (job_id, event, data)
                VALUES (:job_id, 'started', CAST(:data AS jsonb))
            """), {"job_id": job_id, "data": json.dumps({
                "dataset_id": dataset_id,
                "dataset_name": dataset_name,
                "file_name": file_name,
                "storage_path": file_row["storage_path"],
                "model_id": model_id,
            })})
            await db.commit()
        _check_not_stopped(job_id)
        loop = asyncio.get_running_loop()
        def publish_metric(metric):
            future = asyncio.run_coroutine_threadsafe(
                _persist_training_metric(factory, job_id, metric), loop
            )
            # Propagate persistence failures into the worker so a job cannot
            # report success when its live metrics were not durably recorded.
            future.result(timeout=60)

        await _set_stage(factory, job_id, "loading_model")
        cfg, metrics, checkpoint_bytes, tokenizer_bytes, token_count = await asyncio.to_thread(
            _train_sync, text_data, model_config, job_config, publish_metric
        )
        _check_not_stopped(job_id)
        async with factory() as db:
            latest_status = (await db.execute(
                select(TrainingJob.status).where(TrainingJob.id == job_id)
            )).scalar_one_or_none()
            if latest_status in {"stopping", "stopped", "cancelled"}:
                raise TrainingStoppedError("Training job was stopped before checkpoint upload.")
        await _set_stage(factory, job_id, "saving_checkpoints", progress_percent=99.0)
        client = _storage()
        bucket = settings.STORAGE_BUCKET
        base = f"{owner_id}/{job_id}"
        checkpoint_path = f"checkpoints/{base}/model.pt"
        tokenizer_path = f"tokenizers/{base}/tokenizer.json"
        await asyncio.to_thread(
            _upload_bytes, client, bucket, checkpoint_path, checkpoint_bytes, "application/octet-stream"
        )
        await asyncio.to_thread(
            _upload_bytes, client, bucket, tokenizer_path, tokenizer_bytes, "application/json"
        )
        await _set_stage(factory, job_id, "finalizing", progress_percent=99.5)
        async with factory() as db:
            checkpoint_id = "ckpt_" + uuid.uuid4().hex[:8]
            await db.execute(text("""
                INSERT INTO public.checkpoints
                (id, model_id, job_id, storage_path, step, loss)
                VALUES (:id, :model_id, :job_id, :storage_path, :step, :loss)
            """), {
                "id": checkpoint_id, "model_id": model_id,
                "job_id": job_id, "storage_path": checkpoint_path,
                "step": metrics[-1]["step"], "loss": metrics[-1]["loss"],
            })
            await db.execute(text("""
                UPDATE public.models SET config = :config, status = 'trained',
                updated_at = now() WHERE id = :model_id AND owner_id = :owner_id
            """), {"config": json.dumps({**model_config, **cfg, "tokenizer_path": tokenizer_path, "checkpoint_path": checkpoint_path}), "model_id": model_id, "owner_id": owner_id})
            await db.execute(text("""
                UPDATE public.datasets SET token_count = :token_count, updated_at = now()
                WHERE id = :dataset_id AND owner_id = :owner_id
            """), {"token_count": token_count, "dataset_id": dataset_id, "owner_id": owner_id})
            await db.execute(text("""
                UPDATE public.training_jobs
                SET status = 'completed', completed_at = now(), updated_at = now(),
                    stage = 'completed', progress_percent = 100,
                    completed_steps = COALESCE(total_steps, completed_steps),
                    progress_updated_at = now()
                WHERE id = :job_id AND owner_id = :owner_id
            """), {"job_id": job_id, "owner_id": owner_id})
            await db.execute(text("""
                INSERT INTO public.training_job_events (job_id, event, data)
                VALUES (:job_id, 'completed', CAST(:data AS jsonb))
            """), {"job_id": job_id, "data": json.dumps({"checkpoint_id": checkpoint_id, "tokens": token_count, "final_loss": metrics[-1]["loss"]})})
            # A closing hardware sample, so the dashboard has a value for the
            # moment the run actually finished.
            try:
                await _sample_telemetry(factory, db, job_id, stage="completed",
                                        step=metrics[-1]["step"], force=True)
            except Exception:
                logger.debug("Final telemetry sample failed for %s", job_id, exc_info=True)
            await db.commit()
    except TrainingStoppedError:
        logger.info("Training job %s stopped", job_id)
        try:
            async with factory() as db:
                await db.execute(text("""
                    UPDATE public.training_jobs
                    SET status = 'stopped', updated_at = now(), stage = 'stopped',
                        progress_updated_at = now()
                    WHERE id = :job_id AND owner_id = :owner_id
                """), {"job_id": job_id, "owner_id": owner_id})
                await db.execute(text("""
                    INSERT INTO public.training_job_events (job_id, event, data)
                    VALUES (:job_id, 'stopped', CAST(:data AS jsonb))
                """), {"job_id": job_id, "data": json.dumps({"reason": "Stopped by user"})})
                await db.commit()
        except Exception:
            logger.exception("Could not record stopped status for %s", job_id)
    except Exception as exc:
        logger.exception("Training job %s failed", job_id)
        try:
            async with factory() as db:
                await db.execute(text("""
                    UPDATE public.training_jobs
                    SET status = 'failed', updated_at = now(), stage = 'failed',
                        failure_reason = :reason, progress_updated_at = now()
                    WHERE id = :job_id AND owner_id = :owner_id
                """), {"job_id": job_id, "owner_id": owner_id, "reason": str(exc)[:500]})
                await db.execute(text("""
                    INSERT INTO public.training_job_events (job_id, event, data)
                    VALUES (:job_id, 'failed', CAST(:data AS jsonb))
                """), {"job_id": job_id, "data": json.dumps({"error": str(exc)[:1000]})})
                await db.commit()
        except Exception:
            logger.exception("Could not record training failure for %s", job_id)
    finally:
        _LAST_TELEMETRY.pop(job_id, None)
        _CURRENT_JOB_ID.reset(token)
        _unregister_job_control(job_id, ctrl)
