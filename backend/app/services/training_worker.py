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


class TrainingStoppedError(Exception):
    """Raised when an active training job is stopped via the worker lifecycle."""


def _register_job_control(job_id: str):
    loop = asyncio.get_running_loop()
    ctrl = {
        "cancel": threading.Event(),
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


def _check_not_stopped(job_id: str):
    if not job_id:
        return
    with _JOB_CONTROLS_LOCK:
        ctrl = _JOB_CONTROLS.get(job_id)
        if ctrl and ctrl["cancel"].is_set():
            raise TrainingStoppedError("Training job was stopped.")


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
    loader = DataLoader(TensorDataset(x, y), batch_size=max(1, min(int(job_config.get("batch_size", 2)), 4)), shuffle=True)
    trainer = PyTorchTrainer(cfg, device="cpu")
    metrics = []
    started = time.monotonic()
    current_job_id = _CURRENT_JOB_ID.get("")
    processed_tokens = 0
    def report_optimizer_step(step_data):
        nonlocal processed_tokens
        _check_not_stopped(current_job_id)
        processed_tokens += int(step_data.get("tokens") or (int(loader.batch_size or 1) * context))
        elapsed = max(time.monotonic() - started, 0.001)
        metric = {
            "step": int(step_data["step"]),
            "loss": float(step_data["loss"]),
            "learning_rate": float(trainer.optimizer.param_groups[0]["lr"]),
            "tokens_per_second": float(processed_tokens / elapsed),
        }
        metrics.append(metric)
        if on_metric is not None:
            on_metric(metric)

    for epoch in range(cfg["epochs"]):
        _check_not_stopped(current_job_id)
        trainer.train_epoch(
            loader,
            clip_grad=float(job_config.get("gradient_clip", 1.0)),
            accum_steps=max(1, min(int(job_config.get("gradient_accumulation_steps", 1)), 4)),
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


async def _persist_training_metric(factory, job_id: str, metric: dict):
    """Persist each genuine optimizer-step metric before the worker advances."""
    async with factory() as db:
        await db.execute(text("""
            INSERT INTO public.training_metrics
            (job_id, step, loss, learning_rate, tokens_per_second)
            VALUES (:job_id, :step, :loss, :learning_rate, :tokens_per_second)
        """), {"job_id": job_id, **metric})
        await db.execute(text("""
            INSERT INTO public.training_job_events (job_id, event, data)
            VALUES (:job_id, 'metric', CAST(:data AS jsonb))
        """), {"job_id": job_id, "data": json.dumps(metric)})
        await db.commit()


async def run_training_job(job_id: str, owner_id: str):
    factory = get_session_factory()
    ctrl = _register_job_control(job_id)
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
                UPDATE public.training_jobs SET status = 'completed', completed_at = now(), updated_at = now()
                WHERE id = :job_id AND owner_id = :owner_id
            """), {"job_id": job_id, "owner_id": owner_id})
            await db.execute(text("""
                INSERT INTO public.training_job_events (job_id, event, data)
                VALUES (:job_id, 'completed', CAST(:data AS jsonb))
            """), {"job_id": job_id, "data": json.dumps({"checkpoint_id": checkpoint_id, "tokens": token_count, "final_loss": metrics[-1]["loss"]})})
            await db.commit()
    except TrainingStoppedError:
        logger.info("Training job %s stopped", job_id)
        try:
            async with factory() as db:
                await db.execute(text("""
                    UPDATE public.training_jobs SET status = 'stopped', updated_at = now()
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
                    UPDATE public.training_jobs SET status = 'failed', updated_at = now()
                    WHERE id = :job_id AND owner_id = :owner_id
                """), {"job_id": job_id, "owner_id": owner_id})
                await db.execute(text("""
                    INSERT INTO public.training_job_events (job_id, event, data)
                    VALUES (:job_id, 'failed', CAST(:data AS jsonb))
                """), {"job_id": job_id, "data": json.dumps({"error": str(exc)[:1000]})})
                await db.commit()
        except Exception:
            logger.exception("Could not record training failure for %s", job_id)
    finally:
        _CURRENT_JOB_ID.reset(token)
        _unregister_job_control(job_id, ctrl)
