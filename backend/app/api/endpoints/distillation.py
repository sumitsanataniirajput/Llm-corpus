"""Knowledge Distillation Studio — jobs, records, review, export, conversion.

Every number returned here comes from the database: record rows written by the
runner, request rows written by the adapters, and evaluation rows written by the
evaluator teacher. Nothing is estimated client-side and nothing is synthesized.

Security notes:
* Owner scoping is applied in every query (``owner_id = :owner_id``); a foreign
  job id returns 404 rather than 403 so job ids cannot be probed.
* Provider credentials are decrypted only inside ``run_distillation_job`` and are
  never part of an API response or a log line.
* External sending requires explicit consent (``allow_external_send``) recorded in
  the job, and the exact character budget that will be sent is reported first by
  ``GET /source-preview``.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.models import AiProviderConnection, DistillationJob
from app.dependencies import get_db_session, require_user
from app.services import crypto
from app.services.dataset_text import DatasetSourceUnavailable, load_dataset_text
from app.services.distillation import (
    DEFAULT_BUDGET,
    DEFAULT_QUALITY,
    DIFFICULTIES,
    LANGUAGES,
    MODES,
    SUBJECTS,
    TASK_TYPES,
    TeacherCallError,
    build_prompt,
    merge_budget,
    run_distillation_job,
)
from app.services.distillation_export import (
    FORMAT_LABELS,
    SUPPORTED_FORMATS,
    format_records,
    to_jsonl_lines,
)

router = APIRouter()

ACTIVE_STATUSES = {"queued", "generating", "validating"}
# Jobs actually running in this process, so a second start cannot double-spend
# budget and a cancel can reach the runner.
_RUNNING: Dict[str, Dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TeacherEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    model_id: Optional[str] = None
    role: Optional[str] = None
    subject: Optional[str] = None


class GenerationIn(BaseModel):
    count: int = Field(default=10, ge=1)
    languages: List[str] = Field(default_factory=lambda: ["en"])
    subjects: List[str] = Field(default_factory=lambda: list(SUBJECTS))
    difficulties: List[str] = Field(default_factory=lambda: list(DIFFICULTIES))
    task_types: List[str] = Field(default_factory=lambda: ["instruction"])
    output_format: str = "chat_jsonl"
    temperature: float = Field(default=0.8, ge=0, le=2)
    source_text: Optional[str] = None


class JobCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: Optional[str] = None
    extra_source_text: Optional[str] = Field(default=None, max_length=200_000)
    mode: str = "single"
    teachers: List[TeacherEntry] = Field(min_length=1)
    primary: Optional[TeacherEntry] = None
    evaluators: List[TeacherEntry] = Field(default_factory=list)
    subject_map: List[Dict[str, Any]] = Field(default_factory=list)
    generation: GenerationIn = Field(default_factory=GenerationIn)
    quality: Dict[str, Any] = Field(default_factory=dict)
    budget: Dict[str, Any] = Field(default_factory=dict)
    # Explicit consent to send the selected source material to the teachers.
    allow_external_send: bool = False


class RecordPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instruction: Optional[str] = None
    input: Optional[str] = None
    target: Optional[str] = None
    chosen: Optional[str] = None
    rejected: Optional[str] = None
    status: Optional[str] = None
    review_note: Optional[str] = None


class BulkReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_ids: List[str] = Field(min_length=1, max_length=500)
    action: str  # accept | reject | pending | delete


class ConvertIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    output_format: str = "chat_jsonl"
    train: float = Field(default=0.8, gt=0, lt=1)
    validation: float = Field(default=0.1, ge=0, lt=1)
    test: float = Field(default=0.1, ge=0, lt=1)
    name_prefix: Optional[str] = None
    create_datasets: bool = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _field(job: Any, key: str, default: Any = None) -> Any:
    """Read a job column from either an ORM object or a mapping row."""
    if isinstance(job, dict):
        return job.get(key, default)
    try:
        return job[key]
    except (KeyError, TypeError, IndexError):
        pass
    return getattr(job, key, default)


def _job_out(job: Any, counts: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    job_id = _field(job, "id")
    return {
        "id": job_id,
        "dataset_id": _field(job, "dataset_id"),
        "source_dataset_name": _field(job, "source_dataset_name"),
        "status": _field(job, "status"),
        "mode": _field(job, "mode"),
        "teacher_config": _field(job, "teacher_config") or {},
        "generation_config": _field(job, "generation_config") or {},
        "quality_config": _field(job, "quality_config") or {},
        "budget": _field(job, "budget") or {},
        "progress": _field(job, "progress") or {},
        "student_dataset_id": _field(job, "student_dataset_id"),
        "error": _field(job, "error"),
        "started_at": _iso(_field(job, "started_at")),
        "completed_at": _iso(_field(job, "completed_at")),
        "created_at": _iso(_field(job, "created_at")),
        "updated_at": _iso(_field(job, "updated_at")),
        "counts": counts or {},
        "running_in_this_process": job_id in _RUNNING,
    }


def _record_out(row: Any) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "job_id": row["job_id"],
        "instruction": row["instruction"],
        "input": row["input"],
        "target": row["target"],
        "chosen": row["chosen"],
        "rejected": row["rejected"],
        "task_type": row["task_type"],
        "difficulty": row["difficulty"],
        "language": row["language"],
        "subject": row["subject"],
        "output_format": row["output_format"],
        "provenance": row["provenance"] or {},
        "validation": row["validation"] or {},
        "quality_score": row["quality_score"],
        "status": row["status"],
        "reviewed_by_human": row["reviewed_by_human"],
        "review_note": row["review_note"],
        "created_at": _iso(row["created_at"]),
    }


async def _get_job(db: AsyncSession, job_id: str, owner_id: uuid.UUID) -> Dict[str, Any]:
    row = (await db.execute(
        text("SELECT * FROM public.distillation_jobs WHERE id = :job_id AND owner_id = :owner_id"),
        {"job_id": job_id, "owner_id": owner_id},
    )).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Distillation job not found for this account.")
    return dict(row)


async def _job_counts(db: AsyncSession, job_id: str) -> Dict[str, int]:
    row = (await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
               COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
               COUNT(*) FILTER (WHERE status = 'pending') AS pending,
               COUNT(*) FILTER (WHERE status = 'duplicate') AS duplicates
        FROM public.distillation_records WHERE job_id = :job_id
    """), {"job_id": job_id})).mappings().first()
    return {key: int(row[key] or 0) for key in ("total", "accepted", "rejected", "pending", "duplicates")}


async def _validate_teachers(db: AsyncSession, owner_id: uuid.UUID,
                             entries: List[TeacherEntry]) -> Dict[str, Dict[str, Any]]:
    """Every reference must be an enabled provider owned by this account."""
    if not entries:
        raise HTTPException(status_code=400, detail="Select at least one teacher provider.")
    ids = sorted({entry.provider_id for entry in entries})
    rows = (await db.execute(text("""
        SELECT id, name, provider_type, enabled, status, default_teacher_model
        FROM public.ai_provider_connections
        WHERE owner_id = :owner_id AND id = ANY(:ids)
    """), {"owner_id": owner_id, "ids": ids})).mappings().all()
    found = {row["id"]: dict(row) for row in rows}
    missing = set(ids) - set(found)
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Provider not found for this account: {', '.join(sorted(missing))}.",
        )
    for row in found.values():
        if not row["enabled"]:
            raise HTTPException(
                status_code=400,
                detail=f"Provider '{row['name']}' is disabled. Enable it before using it as a teacher.",
            )

    models_by_provider: Dict[str, set] = {}
    model_rows = (await db.execute(text("""
        SELECT provider_id, model_id FROM public.ai_teacher_models
        WHERE owner_id = :owner_id AND provider_id = ANY(:ids)
    """), {"owner_id": owner_id, "ids": ids})).mappings().all()
    for row in model_rows:
        models_by_provider.setdefault(row["provider_id"], set()).add(row["model_id"])

    for entry in entries:
        provider = found[entry.provider_id]
        model_id = entry.model_id or provider["default_teacher_model"]
        if not model_id:
            raise HTTPException(
                status_code=400,
                detail=(f"Provider '{provider['name']}' has no default teacher model and no model "
                        "was chosen for this job."),
            )
        allowed = models_by_provider.get(entry.provider_id, set())
        if allowed and model_id not in allowed:
            raise HTTPException(
                status_code=400,
                detail=(f"Model '{model_id}' is not registered for provider '{provider['name']}'. "
                        "Discover or add it in Provider Management first."),
            )
    return found


def _merge_quality(config: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(DEFAULT_QUALITY)
    for key, value in (config or {}).items():
        if key in merged and value is not None:
            merged[key] = value
    return merged


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------

@router.get("/options", tags=["distillation"])
async def distillation_options(user=Depends(require_user)):
    """Task types, languages, subjects, difficulties, modes and formats."""
    return {
        "modes": MODES,
        "task_types": TASK_TYPES,
        "languages": LANGUAGES,
        "subjects": SUBJECTS,
        "difficulties": DIFFICULTIES,
        "output_formats": [{"key": key, "label": FORMAT_LABELS[key]} for key in SUPPORTED_FORMATS],
        "quality_defaults": DEFAULT_QUALITY,
        "budget_defaults": DEFAULT_BUDGET,
        "max_examples_per_run": int(getattr(settings, "DISTILLATION_MAX_EXAMPLES_PER_RUN", 200) or 200),
        "max_source_chars": int(getattr(settings, "DISTILLATION_MAX_SOURCE_CHARS", 60_000) or 60_000),
    }


@router.get("/source-preview", tags=["distillation"])
async def source_preview(
    dataset_id: Optional[str] = Query(default=None),
    task_type: str = Query(default="instruction"),
    subject: str = Query(default="general"),
    difficulty: str = Query(default="beginner"),
    language: str = Query(default="en"),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Exactly what would be sent to a teacher, so consent is informed.

    Shows the resolved prompt template with the real dataset excerpt (or the
    sample prompt when no dataset is selected), the character budget and the
    truncation flag.
    """
    owner_id = uuid.UUID(user["user_id"])
    if task_type not in TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown task type '{task_type}'.")
    text_value = ""
    source: Dict[str, Any] = {"kind": "prompt_only", "detail": "No dataset selected; the prompt contains no dataset text."}
    if dataset_id:
        try:
            loaded = await load_dataset_text(db, dataset_id, owner_id)
        except DatasetSourceUnavailable as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        text_value = loaded["text"]
        source = {
            "kind": "dataset",
            "dataset_id": dataset_id,
            "file_name": loaded["file_name"],
            "total_characters": loaded["total_characters"],
            "characters_available_to_teachers": loaded["returned_characters"],
            "truncated": loaded["truncated"],
        }
    prompt = build_prompt(task_type, source_text=text_value, subject=subject,
                          difficulty=difficulty, language=language,
                          output_format="chat_jsonl", index=0)
    return {
        "task_type": task_type,
        "system_prompt_sent": True,
        "prompt": prompt,
        "prompt_characters": len(prompt),
        "dataset_excerpt_characters": len(text_value[:4000]),
        "source": source,
        "note": ("Only the excerpt shown here — capped at 4000 characters per request — is sent "
                 "to a teacher. Retry attempts resend the same prompt."),
    }


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@router.post("/jobs", tags=["distillation"], status_code=201)
async def create_job(
    body: JobCreateIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    if body.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"Unknown mode '{body.mode}'.")
    if not body.allow_external_send:
        raise HTTPException(
            status_code=400,
            detail=("Generation sends dataset text to an external AI provider. Confirm that you allow "
                    "this by setting allow_external_send=true."),
        )

    generation = body.generation
    max_examples = int(getattr(settings, "DISTILLATION_MAX_EXAMPLES_PER_RUN", 200) or 200)
    if generation.count > max_examples:
        raise HTTPException(
            status_code=400,
            detail=f"This deployment allows at most {max_examples} examples per run; requested {generation.count}.",
        )
    unknown_tasks = [task for task in generation.task_types if task not in TASK_TYPES]
    if unknown_tasks:
        raise HTTPException(status_code=400, detail=f"Unknown task types: {', '.join(unknown_tasks)}.")
    unknown_langs = [lang for lang in generation.languages if lang not in LANGUAGES]
    if unknown_langs:
        raise HTTPException(status_code=400, detail=f"Unknown languages: {', '.join(unknown_langs)}.")
    if generation.output_format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unknown output format '{generation.output_format}'.")

    teachers = body.teachers + ([body.primary] if body.primary else []) + body.evaluators
    providers = await _validate_teachers(db, owner_id, teachers)
    if body.mode in {"evaluator", "competition"} and not body.evaluators:
        raise HTTPException(
            status_code=400,
            detail="This mode needs a separate evaluator model. Add at least one evaluator provider.",
        )
    if body.mode == "multi" and len({entry.provider_id for entry in body.teachers}) < 2:
        raise HTTPException(status_code=400, detail="Mode B needs at least two teacher providers.")

    max_chars = int(getattr(settings, "DISTILLATION_MAX_SOURCE_CHARS", 60_000) or 60_000)
    source_text = (body.extra_source_text or "").strip()
    dataset_name = None
    dataset_meta = None
    if body.dataset_id:
        try:
            loaded = await load_dataset_text(db, body.dataset_id, owner_id,
                                             max_chars=max(1000, max_chars - len(source_text)))
        except DatasetSourceUnavailable as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        dataset_name = loaded["file_name"]
        dataset_meta = {
            "file_name": loaded["file_name"],
            "total_characters": loaded["total_characters"],
            "characters_used": loaded["returned_characters"],
            "truncated": loaded["truncated"],
        }
        # Dataset text first, then the extra material, so the excerpt rotation
        # walks the real dataset before the uploaded notes.
        source_text = (loaded["text"] + "\n\n" + source_text).strip()
    source_text = source_text[:max_chars]
    if not source_text:
        raise HTTPException(
            status_code=400,
            detail="Select a dataset with a stored file, or paste source material to distill from.",
        )

    now = datetime.now(timezone.utc)
    job_id = "dj_" + uuid.uuid4().hex[:10]
    teacher_config = {
        "teachers": [entry.model_dump() for entry in body.teachers],
        "primary": body.primary.model_dump() if body.primary else None,
        "evaluators": [entry.model_dump() for entry in body.evaluators],
        "subject_map": body.subject_map,
        "auto_complete": False,
    }
    generation_config = {
        **generation.model_dump(exclude={"source_text"}),
        "source_text": source_text,
        "source_chars": len(source_text),
        "dataset_file_name": dataset_name,
        "consent": {
            "allow_external_send": True,
            "recorded_at": now.isoformat(),
            "destinations": [
                {"provider_id": pid, "provider_name": row["name"], "provider_type": row["provider_type"]}
                for pid, row in providers.items()
            ],
            "characters_sent_per_request_max": 4000,
        },
        "dataset_source": dataset_meta,
    }
    job = DistillationJob(
        id=job_id,
        owner_id=owner_id,
        dataset_id=body.dataset_id,
        source_dataset_name=dataset_name,
        status="draft",
        mode=body.mode,
        teacher_config=teacher_config,
        generation_config=generation_config,
        quality_config=_merge_quality(body.quality),
        budget=merge_budget(body.budget),
        progress={},
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return _job_out(job, {})


@router.get("/jobs", tags=["distillation"])
async def list_jobs(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    params: Dict[str, Any] = {"owner_id": owner_id, "limit": limit}
    clause = ""
    if status:
        clause = "AND j.status = :status"
        params["status"] = status
    rows = (await db.execute(text(f"""
        SELECT j.*,
               COALESCE(c.total, 0) AS total_records,
               COALESCE(c.accepted, 0) AS accepted_records,
               COALESCE(c.pending, 0) AS pending_records
        FROM public.distillation_jobs j
        LEFT JOIN (
            SELECT job_id,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
                   COUNT(*) FILTER (WHERE status = 'pending') AS pending
            FROM public.distillation_records GROUP BY job_id
        ) c ON c.job_id = j.id
        WHERE j.owner_id = :owner_id {clause}
        ORDER BY j.created_at DESC
        LIMIT :limit
    """), params)).mappings().all()
    return {
        "jobs": [
            _job_out(row, {
                "total": int(row["total_records"] or 0),
                "accepted": int(row["accepted_records"] or 0),
                "pending": int(row["pending_records"] or 0),
            })
            for row in rows
        ]
    }


@router.get("/jobs/{job_id}", tags=["distillation"])
async def get_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_job(db, job_id, owner_id)
    return _job_out(job, await _job_counts(db, job_id))


@router.post("/jobs/{job_id}/start", tags=["distillation"])
async def start_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Run the pipeline in the background. Refuses to double-run a job."""
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_job(db, job_id, owner_id)
    if job["status"] in ACTIVE_STATUSES or job_id in _RUNNING:
        raise HTTPException(status_code=409, detail="This job is already running.")
    if job["status"] == "completed":
        raise HTTPException(status_code=409, detail="This job is already completed. Create a new job to generate more.")

    providers = []
    cfg = job["teacher_config"] or {}
    for entry in (cfg.get("teachers") or []) + (cfg.get("evaluators") or []):
        if isinstance(entry, dict) and entry.get("provider_id"):
            providers.append(entry["provider_id"])
    if cfg.get("primary"):
        providers.append(cfg["primary"].get("provider_id"))
    if providers:
        usable = (await db.execute(text("""
            SELECT COUNT(*) FROM public.ai_provider_connections
            WHERE owner_id = :owner_id AND id = ANY(:ids) AND enabled = true
        """), {"owner_id": owner_id, "ids": providers})).scalar_one()
        if not usable:
            raise HTTPException(
                status_code=400,
                detail="None of this job's teacher providers is enabled. Re-enable one in Provider Management.",
            )

    stop_event = asyncio.Event()
    _RUNNING[job_id] = {"stop": stop_event, "started_at": datetime.now(timezone.utc)}
    await db.execute(text("""
        UPDATE public.distillation_jobs
        SET status = 'queued', error = NULL, completed_at = NULL, updated_at = now()
        WHERE id = :job_id AND owner_id = :owner_id
    """), {"job_id": job_id, "owner_id": owner_id})
    await db.commit()

    async def _run() -> None:
        try:
            await run_distillation_job(job_id, str(owner_id), stop_event=stop_event)
        except TeacherCallError:
            pass
        except Exception:  # already recorded on the job row by run_distillation_job
            pass
        finally:
            _RUNNING.pop(job_id, None)

    background_tasks.add_task(_run)
    return {"ok": True, "job_id": job_id, "status": "queued"}


@router.post("/jobs/{job_id}/cancel", tags=["distillation"])
async def cancel_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_job(db, job_id, owner_id)
    entry = _RUNNING.get(job_id)
    if entry:
        entry["stop"].set()
    if job["status"] not in ACTIVE_STATUSES and not entry:
        raise HTTPException(status_code=409, detail="This job is not running.")
    await db.execute(text("""
        UPDATE public.distillation_jobs
        SET status = 'cancelled', error = :error, completed_at = now(), updated_at = now()
        WHERE id = :job_id AND owner_id = :owner_id
    """), {"job_id": job_id, "owner_id": owner_id,
            "error": "Stopped by the owner." if entry else "Cancelled before any generation started."})
    await db.commit()
    return {"ok": True, "job_id": job_id, "status": "cancelled"}


@router.delete("/jobs/{job_id}", tags=["distillation"])
async def delete_job(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Delete a job and its records. Datasets created from it are kept."""
    owner_id = uuid.UUID(user["user_id"])
    await _get_job(db, job_id, owner_id)
    entry = _RUNNING.pop(job_id, None)
    if entry:
        entry["stop"].set()
    await db.execute(text("""
        DELETE FROM public.distillation_jobs WHERE id = :job_id AND owner_id = :owner_id
    """), {"job_id": job_id, "owner_id": owner_id})
    await db.commit()
    return {"ok": True, "job_id": job_id, "deleted": True}


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}/records", tags=["distillation"])
async def list_records(
    job_id: str,
    status: Optional[str] = Query(default=None),
    task_type: Optional[str] = Query(default=None),
    language: Optional[str] = Query(default=None),
    subject: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    await _get_job(db, job_id, owner_id)
    clauses = ["owner_id = :owner_id", "job_id = :job_id"]
    params: Dict[str, Any] = {"owner_id": owner_id, "job_id": job_id,
                              "limit": limit, "offset": offset}
    if status:
        clauses.append("status = :status")
        params["status"] = status
    if task_type:
        clauses.append("task_type = :task_type")
        params["task_type"] = task_type
    if language:
        clauses.append("language = :language")
        params["language"] = language
    if subject:
        clauses.append("subject = :subject")
        params["subject"] = subject
    if search:
        clauses.append("(instruction ILIKE :search OR target ILIKE :search OR chosen ILIKE :search)")
        params["search"] = f"%{search}%"
    where = " AND ".join(clauses)
    total = (await db.execute(text(
        f"SELECT COUNT(*) FROM public.distillation_records WHERE {where}"
    ), params)).scalar_one()
    rows = (await db.execute(text(f"""
        SELECT * FROM public.distillation_records
        WHERE {where}
        ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
    """), params)).mappings().all()
    return {
        "job_id": job_id,
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "records": [_record_out(row) for row in rows],
    }


@router.patch("/records/{record_id}", tags=["distillation"])
async def update_record(
    record_id: str,
    body: RecordPatchIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Edit or approve/reject a single record. Human decisions are tagged."""
    owner_id = uuid.UUID(user["user_id"])
    row = (await db.execute(text("""
        SELECT * FROM public.distillation_records WHERE id = :record_id AND owner_id = :owner_id
    """), {"record_id": record_id, "owner_id": owner_id})).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Record not found for this account.")

    updates: Dict[str, Any] = {}
    values = body.model_dump(exclude_unset=True)
    for field in ("instruction", "input", "target", "chosen", "rejected"):
        if field in values and values[field] is not None:
            updates[field] = values[field]
    if "status" in values and values["status"] is not None:
        if values["status"] not in {"pending", "accepted", "rejected"}:
            raise HTTPException(status_code=400, detail="Status must be pending, accepted or rejected.")
        updates["status"] = values["status"]
        updates["reviewed_by_human"] = True
    if "review_note" in values:
        updates["review_note"] = values["review_note"]

    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = ", ".join(f"{key} = :{key}" for key in updates)
    await db.execute(text(f"""
        UPDATE public.distillation_records SET {assignments}
        WHERE id = :record_id AND owner_id = :owner_id
    """), {**updates, "record_id": record_id, "owner_id": owner_id})
    await db.commit()
    fresh = (await db.execute(text("""
        SELECT * FROM public.distillation_records WHERE id = :record_id AND owner_id = :owner_id
    """), {"record_id": record_id, "owner_id": owner_id})).mappings().first()
    return _record_out(fresh)


@router.delete("/records/{record_id}", tags=["distillation"])
async def delete_record(record_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    owner_id = uuid.UUID(user["user_id"])
    result = await db.execute(text("""
        DELETE FROM public.distillation_records WHERE id = :record_id AND owner_id = :owner_id
    """), {"record_id": record_id, "owner_id": owner_id})
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Record not found for this account.")
    return {"ok": True, "record_id": record_id, "deleted": True}


@router.post("/jobs/{job_id}/records/bulk", tags=["distillation"])
async def bulk_review(
    job_id: str,
    body: BulkReviewIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    await _get_job(db, job_id, owner_id)
    if body.action not in {"accept", "reject", "pending", "delete"}:
        raise HTTPException(status_code=400, detail="Action must be accept, reject, pending or delete.")
    if body.action == "delete":
        result = await db.execute(text("""
            DELETE FROM public.distillation_records
            WHERE owner_id = :owner_id AND job_id = :job_id AND id = ANY(:ids)
        """), {"owner_id": owner_id, "job_id": job_id, "ids": body.record_ids})
        await db.commit()
        return {"ok": True, "action": "delete", "affected": int(result.rowcount or 0)}

    status = {"accept": "accepted", "reject": "rejected", "pending": "pending"}[body.action]
    result = await db.execute(text("""
        UPDATE public.distillation_records
        SET status = :status, reviewed_by_human = true
        WHERE owner_id = :owner_id AND job_id = :job_id AND id = ANY(:ids)
    """), {"owner_id": owner_id, "job_id": job_id, "ids": body.record_ids, "status": status})
    await db.commit()
    return {"ok": True, "action": body.action, "affected": int(result.rowcount or 0)}


# ---------------------------------------------------------------------------
# Review summary
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}/summary", tags=["distillation"])
async def job_summary(job_id: str, user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Everything the review screen shows, calculated from stored rows."""
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_job(db, job_id, owner_id)
    counts = await _job_counts(db, job_id)

    by_language = (await db.execute(text("""
        SELECT COALESCE(language, 'unknown') AS key, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
        FROM public.distillation_records WHERE job_id = :job_id GROUP BY 1 ORDER BY 2 DESC
    """), {"job_id": job_id})).mappings().all()
    by_subject = (await db.execute(text("""
        SELECT COALESCE(subject, 'unknown') AS key, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'accepted') AS accepted
        FROM public.distillation_records WHERE job_id = :job_id GROUP BY 1 ORDER BY 2 DESC
    """), {"job_id": job_id})).mappings().all()
    by_teacher = (await db.execute(text("""
        SELECT COALESCE(provenance->>'provider_name', 'unknown') AS provider_name,
               COALESCE(provenance->>'model_id', 'unknown') AS model_id,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
               COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
        FROM public.distillation_records WHERE job_id = :job_id
        GROUP BY 1, 2 ORDER BY 3 DESC
    """), {"job_id": job_id})).mappings().all()
    quality = (await db.execute(text("""
        SELECT AVG(quality_score) AS avg_score,
               MIN(quality_score) AS min_score,
               MAX(quality_score) AS max_score
        FROM public.distillation_records
        WHERE job_id = :job_id AND quality_score IS NOT NULL
    """), {"job_id": job_id})).mappings().first()
    validation_failures = (await db.execute(text("""
        SELECT COUNT(*) FROM public.distillation_records
        WHERE job_id = :job_id AND status = 'rejected'
          AND COALESCE((validation->>'status'), '') = 'rejected'
    """), {"job_id": job_id})).scalar_one()
    usage = (await db.execute(text("""
        SELECT COUNT(*) AS requests,
               COUNT(*) FILTER (WHERE status = 'success') AS successes,
               COUNT(*) FILTER (WHERE status = 'error') AS failures,
               COUNT(*) FILTER (WHERE status = 'rate_limited') AS rate_limited,
               COUNT(*) FILTER (WHERE status = 'budget_blocked') AS budget_blocked,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(estimated_cost), 0) AS cost,
               AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS avg_latency
        FROM public.ai_provider_requests WHERE job_id = :job_id AND owner_id = :owner_id
    """), {"job_id": job_id, "owner_id": owner_id})).mappings().first()
    evaluations = (await db.execute(text("""
        SELECT COUNT(*) AS total,
               AVG((scores->>'mean')::double precision) AS avg_mean,
               COUNT(*) FILTER (WHERE verdict = 'accept') AS accepts,
               COUNT(*) FILTER (WHERE verdict = 'reject') AS rejects
        FROM public.distillation_evaluations WHERE job_id = :job_id AND owner_id = :owner_id
    """), {"job_id": job_id, "owner_id": owner_id})).mappings().first()

    total = counts["total"]
    return {
        "job_id": job_id,
        "status": job["status"],
        "mode": job["mode"],
        "counts": counts,
        "percentages": {
            "accepted": round(100.0 * counts["accepted"] / total, 1) if total else 0.0,
            "rejected": round(100.0 * counts["rejected"] / total, 1) if total else 0.0,
            "pending": round(100.0 * counts["pending"] / total, 1) if total else 0.0,
            "duplicate": round(100.0 * counts["duplicates"] / total, 1) if total else 0.0,
        },
        "validation_failures": int(validation_failures or 0),
        "by_language": [
            {"language": row["key"], "total": int(row["total"]), "accepted": int(row["accepted"])}
            for row in by_language
        ],
        "by_subject": [
            {"subject": row["key"], "total": int(row["total"]), "accepted": int(row["accepted"])}
            for row in by_subject
        ],
        "teacher_contribution": [
            {
                "provider_name": row["provider_name"],
                "model_id": row["model_id"],
                "total": int(row["total"]),
                "accepted": int(row["accepted"]),
                "rejected": int(row["rejected"]),
                "share_percent": round(100.0 * int(row["total"]) / total, 1) if total else 0.0,
            }
            for row in by_teacher
        ],
        "quality": {
            "avg_score": round(float(quality["avg_score"]), 4) if quality["avg_score"] is not None else None,
            "min_score": quality["min_score"],
            "max_score": quality["max_score"],
        },
        "usage": {
            "requests": int(usage["requests"] or 0),
            "successes": int(usage["successes"] or 0),
            "failures": int(usage["failures"] or 0),
            "rate_limited": int(usage["rate_limited"] or 0),
            "budget_blocked": int(usage["budget_blocked"] or 0),
            "input_tokens": int(usage["input_tokens"] or 0),
            "output_tokens": int(usage["output_tokens"] or 0),
            "total_tokens": int(usage["input_tokens"] or 0) + int(usage["output_tokens"] or 0),
            "estimated_cost": round(float(usage["cost"] or 0.0), 6),
            "avg_latency_ms": round(float(usage["avg_latency"]), 1) if usage["avg_latency"] is not None else None,
            "cost_note": "Estimated cost counts only requests whose teacher model has owner-entered prices.",
        },
        "evaluations": {
            "total": int(evaluations["total"] or 0),
            "avg_mean_score": round(float(evaluations["avg_mean"]), 4) if evaluations["avg_mean"] is not None else None,
            "accepts": int(evaluations["accepts"] or 0),
            "rejects": int(evaluations["rejects"] or 0),
        },
        "teacher_disagreements": (job["progress"] or {}).get("disagreements") or [],
        "budget": job["budget"] or {},
        "progress": job["progress"] or {},
        "error": job["error"],
    }


@router.get("/jobs/{job_id}/evaluations", tags=["distillation"])
async def list_evaluations(
    job_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    await _get_job(db, job_id, owner_id)
    rows = (await db.execute(text("""
        SELECT * FROM public.distillation_evaluations
        WHERE job_id = :job_id AND owner_id = :owner_id
        ORDER BY created_at DESC LIMIT :limit
    """), {"job_id": job_id, "owner_id": owner_id, "limit": limit})).mappings().all()
    return {
        "job_id": job_id,
        "evaluations": [
            {
                "id": row["id"],
                "record_id": row["record_id"],
                "evaluator_provider_id": row["evaluator_provider_id"],
                "evaluator_model_id": row["evaluator_model_id"],
                "scores": row["scores"] or {},
                "verdict": row["verdict"],
                "rationale": row["rationale"],
                "usage": row["usage"] or {},
                "created_at": _iso(row["created_at"]),
            }
            for row in rows
        ],
    }


# ---------------------------------------------------------------------------
# Export & conversion
# ---------------------------------------------------------------------------

async def _accepted_records(db: AsyncSession, job_id: str, owner_id: uuid.UUID) -> List[Dict[str, Any]]:
    rows = (await db.execute(text("""
        SELECT id, instruction, input, target, chosen, rejected, task_type, difficulty,
               language, subject, status, quality_score
        FROM public.distillation_records
        WHERE job_id = :job_id AND owner_id = :owner_id AND status = 'accepted'
        ORDER BY created_at ASC
    """), {"job_id": job_id, "owner_id": owner_id})).mappings().all()
    return [dict(row) for row in rows]


@router.get("/jobs/{job_id}/export", tags=["distillation"])
async def export_records(
    job_id: str,
    format: str = Query(default="chat_jsonl"),
    split: str = Query(default="all"),
    train: float = Query(default=0.8, gt=0, lt=1),
    validation: float = Query(default=0.1, ge=0, lt=1),
    test: float = Query(default=0.1, ge=0, lt=1),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Download approved records as JSONL. Rejected and pending rows never appear."""
    owner_id = uuid.UUID(user["user_id"])
    await _get_job(db, job_id, owner_id)
    if format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unknown format '{format}'.")
    records = await _accepted_records(db, job_id, owner_id)
    payload = format_records(records, format, splits={"train": train, "validation": validation, "test": test})
    if split not in {"all", "train", "validation", "test"}:
        raise HTTPException(status_code=400, detail="split must be all, train, validation or test.")
    rows: List[Dict[str, Any]] = []
    if split == "all":
        for name in ("train", "validation", "test"):
            for example in payload["examples"][name]:
                rows.append({**example, "split": name})
    else:
        rows = payload["examples"][split]
    body = to_jsonl_lines(rows)
    filename = f"{job_id}_{format}_{split}.jsonl"
    return Response(
        content=body,
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Record-Count": str(len(rows)),
            "X-Skipped-Count": str(payload["counts"]["skipped"]),
        },
    )


@router.post("/jobs/{job_id}/convert", tags=["distillation"])
async def convert_job(
    job_id: str,
    body: ConvertIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Convert approved records into real training datasets, one per split.

    Each split is uploaded to private Storage and registered as a dataset row, so
    the training engine can select it exactly like any other dataset. If Storage
    is unavailable nothing is written and the caller is told why.
    """
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_job(db, job_id, owner_id)
    if body.output_format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unknown output format '{body.output_format}'.")
    ratios = {"train": body.train, "validation": body.validation, "test": body.test}
    if abs(sum(ratios.values()) - 1.0) > 1e-6:
        raise HTTPException(status_code=400, detail="train + validation + test must add up to 1.0.")

    records = await _accepted_records(db, job_id, owner_id)
    if not records:
        raise HTTPException(
            status_code=400,
            detail="No accepted records yet. Approve records in the review screen before converting.",
        )
    payload = format_records(records, body.output_format, splits=ratios)

    if not body.create_datasets:
        return {"ok": True, "created": [], "counts": payload["counts"], "skipped": payload["skipped"]}

    from app.api.endpoints.datasets import _storage_client
    from app.config import settings as app_settings

    try:
        storage = _storage_client()
    except HTTPException as exc:
        raise HTTPException(status_code=503, detail=str(exc.detail)) from exc
    bucket_api = storage.storage.from_(app_settings.STORAGE_BUCKET)

    import hashlib

    prefix = (body.name_prefix or f"distill-{job_id}").strip().replace(" ", "-")[:60]
    created: List[Dict[str, Any]] = []
    for split_name, examples in payload["examples"].items():
        if not examples:
            continue
        dataset_id = "ds_" + uuid.uuid4().hex[:12]
        filename = f"{prefix}_{split_name}_{body.output_format}.jsonl"
        contents = to_jsonl_lines(examples).encode("utf-8")
        checksum = hashlib.sha256(contents).hexdigest()
        object_path = f"{owner_id}/datasets/{dataset_id}/{uuid.uuid4().hex}_{filename}"
        try:
            await asyncio.to_thread(
                bucket_api.upload,
                object_path,
                contents,
                file_options={"content-type": "application/x-ndjson", "upsert": "false"},
            )
        except Exception as exc:  # noqa: BLE001 - reported verbatim
            raise HTTPException(
                status_code=502,
                detail=f"Could not store the {split_name} split in Supabase Storage: {str(exc)[:250]}",
            ) from exc
        try:
            await db.execute(text("""
                INSERT INTO public.datasets (id, owner_id, name, format, size, status, checksum, created_at, updated_at)
                VALUES (:id, :owner_id, :name, 'jsonl', :size, 'uploaded', :checksum, now(), now())
            """), {
                "id": dataset_id, "owner_id": owner_id, "name": f"{prefix} · {split_name}",
                "size": len(contents), "checksum": checksum,
            })
            await db.execute(text("""
                INSERT INTO public.dataset_files (id, dataset_id, storage_path, file_name, file_size, checksum)
                VALUES (:id, :dataset_id, :storage_path, :file_name, :file_size, :checksum)
            """), {
                "id": str(uuid.uuid4()), "dataset_id": dataset_id, "storage_path": object_path,
                "file_name": filename, "file_size": len(contents), "checksum": checksum,
            })
        except Exception:
            await db.rollback()
            try:
                await asyncio.to_thread(bucket_api.remove, [object_path])
            except Exception:
                pass
            raise
        created.append({
            "split": split_name,
            "dataset_id": dataset_id,
            "name": f"{prefix} · {split_name}",
            "file_name": filename,
            "records": len(examples),
            "bytes": len(contents),
            "checksum": checksum,
        })

    train_dataset = next((item for item in created if item["split"] == "train"), None)
    await db.execute(text("""
        UPDATE public.distillation_jobs
        SET student_dataset_id = :dataset_id,
            progress = COALESCE(progress, '{}'::jsonb) || CAST(:patch AS jsonb),
            updated_at = now()
        WHERE id = :job_id AND owner_id = :owner_id
    """), {
        "dataset_id": (train_dataset or {}).get("dataset_id"),
        "job_id": job_id, "owner_id": owner_id,
        "patch": json.dumps({
            "conversion": {
                "format": body.output_format,
                "splits": ratios,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "datasets": created,
            }
        }),
    })
    await db.commit()
    return {"ok": True, "format": body.output_format, "created": created, "counts": payload["counts"],
            "skipped": payload["skipped"]}


@router.get("/providers/{provider_id}/redaction-check", tags=["distillation"])
async def redaction_check(provider_id: str, text_value: str = Query(default=""),
                          user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """Show how a string would appear after provider-error redaction.

    Useful for confirming that a key cannot leak through an error message the UI
    displays. The real key is never returned; only the redacted form is.
    """
    owner_id = uuid.UUID(user["user_id"])
    provider = (await db.execute(text("""
        SELECT credential_ciphertext FROM public.ai_provider_connections
        WHERE id = :provider_id AND owner_id = :owner_id
    """), {"provider_id": provider_id, "owner_id": owner_id})).mappings().first()
    if provider is None:
        raise HTTPException(status_code=404, detail="Provider connection not found for this account.")
    try:
        secret = crypto.decrypt_secret(provider["credential_ciphertext"])
    except crypto.CredentialError as exc:
        raise HTTPException(status_code=409, detail=f"The stored credential cannot be used: {exc}") from exc
    return {
        "redacted": crypto.redact(text_value, secret),
        "contains_key": secret in text_value if text_value else False,
        "masked_credential": crypto.mask_secret(secret),
    }
