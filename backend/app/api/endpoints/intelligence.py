"""Training Intelligence — one endpoint that reports what actually happened.

Six blocks, all persisted numbers:

A. architecture — read from the model row and (for CORPUS) verified by building
   the transformer and asking it for its own parameter count.
B. training configuration — the job's stored config plus the derived effective
   global batch size, with the derivation shown.
C. dataset analytics — the row the worker wrote after tokenizing, plus dataset
   metadata (checksum, size, token count).
D. hardware telemetry — samples captured on the host that ran the job; any value
   that could not be read is returned as null with a reason.
E. live progress — job columns written by the engine's own step counter.
F. charts — the real per-step metric series.

Nothing is interpolated. When a value does not exist the field is null and
``limitations`` explains why, so the UI can print "Unavailable".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Model, TrainingJob
from app.dependencies import get_db_session, require_user
from app.services import student_studio as studio
from app.services.telemetry import collect_runtime_sample

router = APIRouter()


def _iso(value) -> Optional[str]:
    return value.isoformat() if value else None


def _seconds_between(start, end=None) -> Optional[float]:
    if not start:
        return None
    moment = end or datetime.now(timezone.utc)
    if moment.tzinfo is None or start.tzinfo is None:
        return None
    return max(0.0, (moment - start).total_seconds())


async def _owned_job(db: AsyncSession, job_id: str, owner_id: uuid.UUID) -> TrainingJob:
    job = (await db.execute(select(TrainingJob).where(
        TrainingJob.id == job_id, TrainingJob.owner_id == owner_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Training job not found for this account.")
    return job


def _architecture_block(model: Optional[Model], student_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if student_config and student_config.get("architecture"):
        return {
            "source": "student_training_configs",
            "config_id": student_config.get("id"),
            "method": student_config.get("method"),
            **student_config["architecture"],
            "limitations": [],
        }
    if model is None:
        return {
            "source": None,
            "limitations": ["This job has no model row, so there is no architecture to report."],
        }
    try:
        inspection = studio.inspect_corpus_model(model)
    except Exception as exc:  # noqa: BLE001 - reported, never guessed
        stored = dict(model.config or {})
        return {
            "source": "models.config (could not instantiate the architecture)",
            "config": stored,
            "limitations": [f"The model could not be instantiated to verify its parameters: {str(exc)[:200]}"],
        }
    return {
        "source": inspection["architecture"].get("source"),
        "method": "sft",
        **inspection["architecture"],
        "compatibility": inspection["compatibility"],
        "limitations": [],
    }


def _training_block(job: TrainingJob) -> Dict[str, Any]:
    config: Dict[str, Any] = dict(job.config or {})
    batch = config.get("batch_size")
    accum = config.get("gradient_accumulation_steps") or 1
    effective = None
    if isinstance(batch, int) and isinstance(accum, int):
        effective = batch * accum
    return {
        "algorithm": config.get("engine", job.engine),
        "engine": job.engine,
        "compute": job.compute,
        "optimizer": config.get("optimizer"),
        "learning_rate": config.get("learning_rate"),
        "scheduler": config.get("scheduler"),
        "weight_decay": config.get("weight_decay"),
        "batch_size": batch,
        "gradient_accumulation_steps": accum,
        "effective_global_batch": effective,
        "effective_global_batch_formula": "batch_size × gradient_accumulation_steps × 1 device"
        if effective is not None else None,
        "gradient_clip": config.get("gradient_clip"),
        "warmup_steps": config.get("warmup_steps"),
        "warmup_ratio": config.get("warmup_ratio"),
        "total_steps": job.total_steps,
        "completed_steps": job.completed_steps,
        "total_epochs": job.total_epochs,
        "current_epoch": job.current_epoch,
        "precision": config.get("precision") or "float32",
        "max_seq_length": config.get("max_seq_length") or config.get("context_length"),
        "seed": config.get("seed"),
        "checkpoint_interval": config.get("checkpoint_interval") or config.get("save_every"),
        "raw": config,
    }


async def _dataset_block(db: AsyncSession, job: TrainingJob) -> Dict[str, Any]:
    analytics = (await db.execute(text("""
        SELECT * FROM public.training_dataset_analytics WHERE job_id = :job_id
        ORDER BY created_at DESC LIMIT 1
    """), {"job_id": job.id})).mappings().first()
    dataset = None
    if job.dataset_id:
        dataset = (await db.execute(text("""
            SELECT id, name, format, size, status, token_count, checksum
            FROM public.datasets WHERE id = :dataset_id AND owner_id = :owner_id
        """), {"dataset_id": job.dataset_id, "owner_id": job.owner_id})).mappings().first()

    if analytics is None:
        return {
            "available": False,
            "dataset": dict(dataset) if dataset else None,
            "limitations": [
                "The worker has not recorded dataset analytics for this job yet. "
                "They are written once the tokenizer has measured the real data."
            ],
        }
    record_count = analytics["records"]
    languages = analytics["language_distribution"] or {}
    return {
        "available": True,
        "dataset": dict(dataset) if dataset else None,
        "dataset_id": analytics["dataset_id"],
        "name": (dataset or {}).get("name"),
        "original_size_bytes": (dataset or {}).get("size"),
        "checksum": (dataset or {}).get("checksum"),
        "records": record_count,
        "accepted_records": analytics["accepted_records"],
        "rejected_records": analytics["rejected_records"],
        "duplicate_records": analytics["duplicate_records"],
        "tokens": analytics["tokens"],
        "train_tokens": analytics["train_tokens"],
        "validation_tokens": analytics["validation_tokens"],
        "test_tokens": analytics["test_tokens"],
        "avg_tokens_per_sample": analytics["avg_tokens_per_sample"],
        "max_sample_length": analytics["max_sample_length"],
        "min_sample_length": analytics["min_sample_length"],
        "language_distribution": languages,
        "subject_distribution": analytics["subject_distribution"] or {},
        "source_distribution": analytics["source_distribution"] or {},
        "cleaning_status": analytics["cleaning_status"],
        "tokenization_status": analytics["tokenization_status"],
        "split": analytics["split"] or {},
        "limitations": (
            ["A language or subject label was not detected for this plain-text dataset, so those "
             "distributions report 'unknown' instead of a guess."]
            if set(languages) <= {"unknown"} else []
        ),
    }


async def _telemetry_block(db: AsyncSession, job: TrainingJob) -> Dict[str, Any]:
    latest = (await db.execute(text("""
        SELECT * FROM public.training_runtime_snapshots
        WHERE job_id = :job_id ORDER BY captured_at DESC LIMIT 1
    """), {"job_id": job.id})).mappings().first()
    count = (await db.execute(text("""
        SELECT COUNT(*) FROM public.training_runtime_snapshots WHERE job_id = :job_id
    """), {"job_id": job.id})).scalar_one()
    live = collect_runtime_sample(stage="query")
    unavailable: List[str] = []
    if latest is None:
        unavailable.append("No hardware sample has been captured for this job yet.")
    block: Dict[str, Any] = {
        "samples": int(count or 0),
        "latest": None,
        "this_api_host": {
            "note": ("Measured on the machine answering this request, not necessarily the machine that "
                     "trained the model."),
            **live,
        },
        "unavailable": unavailable,
    }
    if latest is not None:
        row = dict(latest)
        block["latest"] = {
            "captured_at": _iso(row["captured_at"]),
            "stage": row["stage"],
            "step": row["step"],
            "device": row["device"],
            "cpu_count": row["cpu_count"],
            "cpu_model": row["cpu_model"],
            "cpu_utilization": row["cpu_utilization"],
            "ram_used_mb": row["ram_used_mb"],
            "ram_total_mb": row["ram_total_mb"],
            "gpu_name": row["gpu_name"],
            "gpu_memory_used_mb": row["gpu_memory_used_mb"],
            "gpu_memory_total_mb": row["gpu_memory_total_mb"],
            "gpu_utilization": row["gpu_utilization"],
            "cpu_temperature_c": row["cpu_temperature_c"],
            "battery_percent": row["battery_percent"],
            "worker_count": row["worker_count"],
            "acceleration": (row["detail"] or {}).get("acceleration"),
        }
        for field, label in (
            ("gpu_name", "GPU"),
            ("gpu_memory_total_mb", "GPU memory"),
            ("gpu_utilization", "GPU utilisation"),
            ("cpu_temperature_c", "CPU temperature"),
            ("battery_percent", "Battery"),
        ):
            if row.get(field) is None:
                block["unavailable"].append(f"{label} is not readable on the training host.")
    return block


async def _metrics_block(db: AsyncSession, job: TrainingJob,
                         avg_tokens_per_sample: Optional[float] = None) -> Dict[str, Any]:
    series = (await db.execute(text("""
        SELECT step, loss, learning_rate, tokens_per_second, created_at
        FROM public.training_metrics WHERE job_id = :job_id ORDER BY step ASC
    """), {"job_id": job.id})).mappings().all()
    last = series[-1] if series else None

    total = job.total_steps
    completed = job.completed_steps
    percent = None
    if isinstance(total, int) and total > 0 and isinstance(completed, int):
        percent = round(min(100.0, 100.0 * completed / total), 2)

    # The engine has no separate "started_at" column on the job; the first metric
    # row is the moment training really began, so elapsed/ETA use that and fall
    # back to the job's creation time when no step has been recorded yet.
    started_at = series[0]["created_at"] if series else job.created_at
    tokens_per_second = last["tokens_per_second"] if last else None
    eta_seconds = None
    if isinstance(total, int) and isinstance(completed, int) and total > completed:
        if tokens_per_second and job.processed_tokens and completed:
            tokens_per_step = job.processed_tokens / completed
            remaining_tokens = (total - completed) * tokens_per_step
            eta_seconds = round(remaining_tokens / float(tokens_per_second), 1)
        elif isinstance(job.progress_updated_at, datetime) and started_at:
            elapsed = _seconds_between(started_at)
            if elapsed and completed:
                per_step = elapsed / completed
                eta_seconds = round(per_step * (total - completed), 1)

    elapsed = _seconds_between(started_at, job.completed_at)
    return {
        "status": job.status,
        "stage": job.stage,
        "progress_percent": percent,
        "completed_steps": completed,
        "total_steps": total,
        "current_epoch": job.current_epoch,
        "total_epochs": job.total_epochs,
        "processed_tokens": job.processed_tokens,
        "tokens_per_second": tokens_per_second,
        "samples_per_second": (
            round(float(tokens_per_second) / float(avg_tokens_per_sample), 2)
            if (tokens_per_second and avg_tokens_per_sample) else None
        ),
        "samples_per_second_note": None if (tokens_per_second and avg_tokens_per_sample) else (
            "Samples/s needs both a measured throughput and a measured average sample length."
        ),
        "train_loss": job.last_loss,
        "learning_rate": last["learning_rate"] if last else None,
        "gradient_norm": None,
        "eta_seconds": eta_seconds,
        "eta_note": None if eta_seconds is not None else
        "ETA needs a measured throughput; it stays empty until at least one optimizer step is recorded.",
        "elapsed_seconds": round(elapsed, 1) if elapsed is not None else None,
        "last_metric_at": _iso(last["created_at"]) if last else None,
        "progress_updated_at": _iso(job.progress_updated_at),
        "failure_reason": job.failure_reason,
        "series": [
            {
                "step": row["step"],
                "loss": row["loss"],
                "learning_rate": row["learning_rate"],
                "tokens_per_second": row["tokens_per_second"],
                "at": _iso(row["created_at"]),
            }
            for row in series
        ][-500:],
    }


@router.get("/{job_id}/intelligence", tags=["intelligence"])
async def training_intelligence(
    job_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    job = await _owned_job(db, job_id, owner_id)
    model = None
    if job.model_id:
        model = (await db.execute(select(Model).where(
            Model.id == job.model_id, Model.owner_id == owner_id))).scalar_one_or_none()
    student_config = None
    config_id = (job.config or {}).get("student_config_id")
    if config_id:
        row = (await db.execute(text("""
            SELECT * FROM public.student_training_configs
            WHERE id = :config_id AND owner_id = :owner_id
        """), {"config_id": config_id, "owner_id": owner_id})).mappings().first()
        if row is not None:
            student_config = {
                "id": row["id"],
                "method": row["method"],
                "architecture": row["architecture"] or {},
                "capability": row["capability"] or {},
                "method_config": row["method_config"] or {},
            }

    architecture = _architecture_block(model, student_config)
    if student_config and student_config.get("method_config"):
        architecture["adapter"] = student_config["method_config"]
    dataset_block = await _dataset_block(db, job)
    metrics = await _metrics_block(db, job, dataset_block.get("avg_tokens_per_sample"))
    return {
        "job_id": job.id,
        "owner_scope": "this account only",
        "model": {
            "id": job.model_id,
            "name": getattr(model, "name", None),
            "version": getattr(model, "version", None),
            "status": getattr(model, "status", None),
        },
        "architecture": architecture,
        "training": _training_block(job),
        "dataset": dataset_block,
        "hardware": await _telemetry_block(db, job),
        "metrics": metrics,
        "charts": {
            "loss": [{"step": p["step"], "value": p["loss"]} for p in metrics["series"]],
            "learning_rate": [{"step": p["step"], "value": p["learning_rate"]} for p in metrics["series"]],
            "throughput": [{"step": p["step"], "value": p["tokens_per_second"]} for p in metrics["series"]],
        },
        "statuses": {
            "generation": None,
            "validation": None,
            "training": job.status,
            "evaluation": None,
        },
        "independent_status_note": (
            "Generation, validation, training and evaluation are separate runs with separate rows. "
            "This endpoint reports the training run only; it never implies that distillation or "
            "evaluation finished."
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/{job_id}/telemetry", tags=["intelligence"])
async def job_telemetry(
    job_id: str,
    limit: int = Query(default=200, ge=1, le=1000),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    await _owned_job(db, job_id, owner_id)
    rows = (await db.execute(text("""
        SELECT * FROM public.training_runtime_snapshots
        WHERE job_id = :job_id ORDER BY captured_at ASC LIMIT :limit
    """), {"job_id": job_id, "limit": limit})).mappings().all()
    return {
        "job_id": job_id,
        "count": len(rows),
        "samples": [
            {
                "captured_at": _iso(row["captured_at"]),
                "stage": row["stage"],
                "step": row["step"],
                "device": row["device"],
                "cpu_utilization": row["cpu_utilization"],
                "ram_used_mb": row["ram_used_mb"],
                "ram_total_mb": row["ram_total_mb"],
                "gpu_name": row["gpu_name"],
                "gpu_memory_used_mb": row["gpu_memory_used_mb"],
                "gpu_utilization": row["gpu_utilization"],
                "cpu_temperature_c": row["cpu_temperature_c"],
                "battery_percent": row["battery_percent"],
            }
            for row in rows
        ],
    }
