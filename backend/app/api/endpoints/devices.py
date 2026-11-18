"""CORPUS ULTIMATE — Training devices, task leases and collaboration endpoints.

What this module actually does
------------------------------
A device registers itself with the capabilities its browser truly exposes,
heartbeats while it is available, and receives lease-backed tasks:

* ``train``      — one training job assigned to one device (independent jobs run
  side by side; each job keeps its own model, dataset, progress and checkpoint).
* ``preprocess`` — one shard of a dataset for one job. Several devices can take
  the shards of the *same* dataset; the coordinator aggregates the shard results
  when every shard reports back.

What it deliberately does not do: synchronised gradient updates across devices.
That would require a parameter server or federated averaging over compatible
adapters, neither of which the current PyTorch engine exposes. The API therefore
never claims a job is "distributed": it reports ``mode`` as ``parallel`` or
``collaborative-preprocess`` and the UI says exactly that.

Every query is scoped by ``owner_id``; a device or task belonging to another
account answers 404, not 403, so membership cannot be probed.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Model, TrainingDevice, TrainingDeviceTask, TrainingJob
from app.dependencies import get_db_session, require_user

router = APIRouter()

# A device with no heartbeat for this long is considered gone, and its leases
# are released so the work can be picked up again.
HEARTBEAT_TIMEOUT_SECONDS = 75
DEFAULT_LEASE_SECONDS = 90
ACTIVE_TASK_STATUSES = ("assigned", "running")
FINISHED_JOB_STATUSES = {"completed", "failed", "stopped", "cancelled", "interrupted"}


class DeviceCapabilities(BaseModel):
    """Only what the browser genuinely reports; unknown values stay None."""

    model_config = ConfigDict(extra="allow")

    webgpu: Optional[bool] = None
    webgl: Optional[bool] = None
    wasm: Optional[bool] = None
    wasm_simd: Optional[bool] = None
    cpu_cores: Optional[int] = None
    device_memory_gb: Optional[float] = None
    storage_quota_gb: Optional[float] = None
    battery_percent: Optional[float] = None
    battery_charging: Optional[bool] = None
    connection_type: Optional[str] = None
    execution_method: Optional[str] = None


class DeviceRegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    device_type: Optional[str] = None
    platform: Optional[str] = None
    capabilities: Dict[str, Any] = Field(default_factory=dict)


class DeviceUpdateIn(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    capabilities: Optional[Dict[str, Any]] = None


class HeartbeatIn(BaseModel):
    status: Optional[str] = None
    capabilities: Optional[Dict[str, Any]] = None
    task_id: Optional[str] = None
    progress_percent: Optional[float] = Field(default=None, ge=0, le=100)


class AssignIn(BaseModel):
    job_id: str
    kind: str = "train"
    shards: Optional[int] = Field(default=None, ge=1, le=32)


class ShardPlanIn(BaseModel):
    job_id: str
    device_ids: Optional[List[str]] = None
    shards: Optional[int] = Field(default=None, ge=1, le=32)


class AutoAssignIn(BaseModel):
    job_ids: List[str]


class TaskProgressIn(BaseModel):
    progress_percent: float = Field(ge=0, le=100)
    detail: Optional[Dict[str, Any]] = None


class TaskCompleteIn(BaseModel):
    detail: Dict[str, Any] = Field(default_factory=dict)
    status: str = Field(default="completed")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value) -> Optional[str]:
    return value.isoformat() if value else None


def _device_out(device: TrainingDevice, task: Optional[TrainingDeviceTask] = None, job: Optional[TrainingJob] = None) -> Dict[str, Any]:
    heartbeat_age = None
    if device.last_heartbeat:
        heartbeat_age = max(0.0, (_now() - device.last_heartbeat).total_seconds())
    return {
        "id": device.id,
        "name": device.name,
        "device_type": device.device_type,
        "platform": device.platform,
        "status": device.status,
        "capabilities": device.capabilities or {},
        "last_heartbeat": _iso(device.last_heartbeat),
        "heartbeat_age_seconds": heartbeat_age,
        "online": heartbeat_age is not None and heartbeat_age <= HEARTBEAT_TIMEOUT_SECONDS,
        "created_at": _iso(device.created_at),
        "task": _task_out(task) if task else None,
        "job": _job_summary(job) if job else None,
    }


def _task_out(task: TrainingDeviceTask) -> Dict[str, Any]:
    return {
        "id": task.id,
        "device_id": task.device_id,
        "job_id": task.job_id,
        "kind": task.kind,
        "status": task.status,
        "progress_percent": task.progress_percent,
        "shard_index": task.shard_index,
        "shard_count": task.shard_count,
        "lease_expires_at": _iso(task.lease_expires_at),
        "detail": task.detail or {},
        "created_at": _iso(task.created_at),
        "updated_at": _iso(task.updated_at),
    }


def _job_summary(job: TrainingJob) -> Dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress_percent": job.progress_percent,
        "completed_steps": job.completed_steps,
        "total_steps": job.total_steps,
        "current_epoch": job.current_epoch,
        "total_epochs": job.total_epochs,
        "model_id": job.model_id,
        "dataset_id": job.dataset_id,
    }


async def _get_device(db: AsyncSession, device_id: str, owner_id: uuid.UUID) -> TrainingDevice:
    result = await db.execute(select(TrainingDevice).where(TrainingDevice.id == device_id))
    device = result.scalar_one_or_none()
    if not device or device.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Device not found for this account.")
    return device


async def _get_task(db: AsyncSession, device_id: str, task_id: str, owner_id: uuid.UUID) -> TrainingDeviceTask:
    result = await db.execute(select(TrainingDeviceTask).where(TrainingDeviceTask.id == task_id))
    task = result.scalar_one_or_none()
    if not task or task.device_id != device_id or task.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="Task not found for this device.")
    return task


async def _get_owned_job(db: AsyncSession, job_id: str, owner_id: uuid.UUID) -> TrainingJob:
    result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job or job.owner_id != owner_id or job.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Training job not found for this account.")
    return job


async def sweep_expired(db: AsyncSession, owner_id: uuid.UUID) -> Dict[str, int]:
    """Release work that belongs to devices which stopped reporting.

    Two things are swept, in this order: devices whose heartbeat is older than
    the timeout become ``offline``; their leased tasks become ``expired`` so the
    same job or shard can be assigned again. Nothing is deleted — the history of
    what a device was doing stays intact.
    """
    now = _now()
    cutoff = now - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)

    stale_devices = await db.execute(
        text("""
            UPDATE public.training_devices
            SET status = 'offline', updated_at = now()
            WHERE owner_id = :owner_id
              AND status IN ('online', 'busy')
              AND (last_heartbeat IS NULL OR last_heartbeat < :cutoff)
            RETURNING id
        """),
        {"owner_id": owner_id, "cutoff": cutoff},
    )
    offline_ids = [row[0] for row in stale_devices.fetchall()]

    expired = await db.execute(
        text("""
            UPDATE public.training_device_tasks
            SET status = 'expired', lease_expires_at = NULL, updated_at = now()
            WHERE owner_id = :owner_id
              AND status IN ('assigned', 'running')
              AND ((lease_expires_at IS NOT NULL AND lease_expires_at < :now)
                   OR device_id = ANY(:offline_ids))
            RETURNING id
        """),
        {"owner_id": owner_id, "now": now, "offline_ids": offline_ids},
    )
    expired_ids = [row[0] for row in expired.fetchall()]
    if offline_ids or expired_ids:
        await db.commit()
    return {"devices_offline": len(offline_ids), "tasks_expired": len(expired_ids)}


def _capability_score(capabilities: Dict[str, Any]) -> float:
    """Rank devices for a job using only reported capabilities.

    WebGPU dominates (real GPU acceleration), then core count, then reported
    memory. A device that reports nothing scores 0 and is still usable — it just
    sorts last. This is a scheduling heuristic, not a performance claim.
    """
    caps = capabilities or {}
    score = 0.0
    if caps.get("webgpu"):
        score += 50.0
    if caps.get("wasm_simd"):
        score += 10.0
    cores = caps.get("cpu_cores")
    if isinstance(cores, (int, float)):
        score += min(float(cores), 16.0)
    memory = caps.get("device_memory_gb")
    if isinstance(memory, (int, float)):
        score += min(float(memory), 16.0)
    if caps.get("execution_method") == "webgpu":
        score += 5.0
    return score


# --------------------------------------------------------------------- devices

@router.post("", include_in_schema=False)
@router.post("/", tags=["devices"])
async def register_device(
    body: DeviceRegisterIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Register this browser as a training device for the signed-in account."""
    owner_id = uuid.UUID(user["user_id"])
    device = TrainingDevice(
        id="dev_" + uuid.uuid4().hex[:10],
        owner_id=owner_id,
        name=body.name.strip()[:80] or "Device",
        device_type=body.device_type,
        platform=(body.platform or "")[:200] or None,
        capabilities=body.capabilities or {},
        status="online",
        last_heartbeat=_now(),
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)
    return _device_out(device)


@router.get("", include_in_schema=False)
@router.get("/", tags=["devices"])
async def list_devices(user=Depends(require_user), db: AsyncSession = Depends(get_db_session)):
    """All devices for this account, with their current task and job."""
    owner_id = uuid.UUID(user["user_id"])
    sweep = await sweep_expired(db, owner_id)

    devices = (await db.execute(
        select(TrainingDevice).where(TrainingDevice.owner_id == owner_id)
        .order_by(TrainingDevice.created_at.asc())
    )).scalars().all()

    tasks = (await db.execute(
        select(TrainingDeviceTask)
        .where(TrainingDeviceTask.owner_id == owner_id, TrainingDeviceTask.status.in_(ACTIVE_TASK_STATUSES))
        .order_by(TrainingDeviceTask.created_at.desc())
    )).scalars().all()
    active_by_device = {}
    for task in tasks:
        active_by_device.setdefault(task.device_id, task)

    job_ids = {t.job_id for t in active_by_device.values() if t.job_id}
    jobs = {}
    if job_ids:
        for job in (await db.execute(select(TrainingJob).where(TrainingJob.id.in_(job_ids)))).scalars().all():
            jobs[job.id] = job

    return {
        "devices": [
            _device_out(d, active_by_device.get(d.id), jobs.get(active_by_device.get(d.id).job_id) if active_by_device.get(d.id) else None)
            for d in devices
        ],
        "sweep": sweep,
        "heartbeat_timeout_seconds": HEARTBEAT_TIMEOUT_SECONDS,
        "lease_seconds": DEFAULT_LEASE_SECONDS,
    }


@router.post("/{device_id}/heartbeat", tags=["devices"])
async def heartbeat(
    device_id: str,
    body: HeartbeatIn = HeartbeatIn(),
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Keep the device alive; optionally report the state of its current task."""
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)

    now = _now()
    device.last_heartbeat = now
    device.updated_at = now
    if body.capabilities:
        device.capabilities = body.capabilities
    if body.status in {"online", "busy", "paused", "offline"}:
        device.status = body.status
    elif device.status == "offline":
        device.status = "online"

    if body.task_id:
        task = await _get_task(db, device_id, body.task_id, owner_id)
        if task.status in ACTIVE_TASK_STATUSES:
            task.lease_expires_at = now + timedelta(seconds=DEFAULT_LEASE_SECONDS)
            task.updated_at = now
            if body.progress_percent is not None:
                task.progress_percent = body.progress_percent
            if task.status == "assigned":
                task.status = "running"
            if device.status == "online":
                device.status = "busy"
    await db.commit()
    await db.refresh(device)

    active = (await db.execute(
        select(TrainingDeviceTask).where(
            TrainingDeviceTask.device_id == device.id,
            TrainingDeviceTask.status.in_(ACTIVE_TASK_STATUSES),
        ).order_by(TrainingDeviceTask.created_at.desc())
    )).scalars().first()
    job = None
    if active and active.job_id:
        job = (await db.execute(select(TrainingJob).where(TrainingJob.id == active.job_id))).scalar_one_or_none()
    return _device_out(device, active, job)


@router.patch("/{device_id}", tags=["devices"])
async def update_device(
    device_id: str,
    body: DeviceUpdateIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Rename a device, or pause/resume it. Pausing releases its leases."""
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)
    now = _now()

    if body.name:
        device.name = body.name.strip()[:80]
    if body.status == "paused":
        device.status = "paused"
        await db.execute(
            text("""
                UPDATE public.training_device_tasks
                SET status = 'expired', lease_expires_at = NULL, updated_at = now()
                WHERE device_id = :device_id AND status IN ('assigned', 'running')
            """),
            {"device_id": device.id},
        )
    elif body.status == "online":
        device.status = "online"
        device.last_heartbeat = now
    device.updated_at = now
    await db.commit()
    await db.refresh(device)
    return _device_out(device)


@router.post("/{device_id}/disconnect", tags=["devices"])
async def disconnect_device(
    device_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Take a device offline now and release its tasks (it can come back)."""
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)
    device.status = "offline"
    device.updated_at = _now()
    released = await db.execute(
        text("""
            UPDATE public.training_device_tasks
            SET status = 'expired', lease_expires_at = NULL, updated_at = now()
            WHERE device_id = :device_id AND status IN ('assigned', 'running')
            RETURNING id
        """),
        {"device_id": device.id},
    )
    released_ids = [row[0] for row in released.fetchall()]
    await db.commit()
    return {"ok": True, "device_id": device.id, "status": "offline", "released_tasks": released_ids}


@router.delete("/{device_id}", tags=["devices"])
async def delete_device(
    device_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Remove a device from the account.

    Only the device registration and its task rows go away. Models, datasets,
    checkpoints and training history are separate resources and are untouched.
    """
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)
    await db.execute(text("DELETE FROM public.training_device_tasks WHERE device_id = :device_id"), {"device_id": device.id})
    await db.delete(device)
    await db.commit()
    return {"ok": True, "device_id": device_id, "removed": True}


# ----------------------------------------------------------------------- tasks

@router.post("/{device_id}/assign", tags=["devices"])
async def assign_task(
    device_id: str,
    body: AssignIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Assign a job (``train``) or dataset shards (``preprocess``) to one device."""
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)
    job = await _get_owned_job(db, body.job_id, owner_id)

    if job.status in FINISHED_JOB_STATUSES:
        raise HTTPException(status_code=409, detail=f"Job is already {job.status}; nothing to assign.")
    if body.kind not in {"train", "preprocess"}:
        raise HTTPException(status_code=400, detail="kind must be 'train' or 'preprocess'.")

    existing = (await db.execute(
        select(TrainingDeviceTask).where(
            TrainingDeviceTask.device_id == device.id,
            TrainingDeviceTask.job_id == job.id,
            TrainingDeviceTask.kind == body.kind,
            TrainingDeviceTask.status.in_(ACTIVE_TASK_STATUSES),
        )
    )).scalars().first()
    if existing:
        return {"ok": True, "task": _task_out(existing), "already_assigned": True}

    task = TrainingDeviceTask(
        id="task_" + uuid.uuid4().hex[:10],
        owner_id=owner_id,
        device_id=device.id,
        job_id=job.id,
        kind=body.kind,
        status="assigned",
        lease_expires_at=_now() + timedelta(seconds=DEFAULT_LEASE_SECONDS),
        shard_index=0 if body.kind == "preprocess" else None,
        shard_count=body.shards if body.kind == "preprocess" else None,
        detail={"mode": "parallel" if body.kind == "train" else "collaborative-preprocess"},
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return {"ok": True, "task": _task_out(task), "job": _job_summary(job)}


@router.post("/plan/collaborative", tags=["devices"])
async def plan_collaborative(
    body: ShardPlanIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Split one dataset into shards and hand one shard to each chosen device.

    This is the collaborative mode that is genuinely implemented: devices
    *preprocess* (tokenize and count) different shards of the same dataset, and
    the coordinator aggregates the shard results. It is not distributed gradient
    training, and the response says so.
    """
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_owned_job(db, body.job_id, owner_id)
    if not job.dataset_id:
        raise HTTPException(status_code=400, detail="This job has no dataset to shard.")

    devices = (await db.execute(
        select(TrainingDevice).where(TrainingDevice.owner_id == owner_id)
        .order_by(TrainingDevice.created_at.asc())
    )).scalars().all()
    if body.device_ids:
        wanted = set(body.device_ids)
        devices = [d for d in devices if d.id in wanted]
    if not devices:
        raise HTTPException(status_code=400, detail="No devices are registered for this account.")

    shard_count = body.shards or len(devices)
    shard_count = max(1, min(len(devices), shard_count))

    # Re-planning must not leave the previous shard set alive: the coordinator
    # aggregates only when every sibling is complete, so stale active shards
    # would silently block the result. They are expired, never deleted.
    superseded = await db.execute(
        text("""
            UPDATE public.training_device_tasks
            SET status = 'expired',
                lease_expires_at = NULL,
                detail = coalesce(detail, '{}'::jsonb) || '{"superseded": true}'::jsonb,
                updated_at = now()
            WHERE job_id = :job_id AND kind = 'preprocess'
              AND status IN ('assigned', 'running')
            RETURNING id
        """),
        {"job_id": job.id},
    )
    superseded_ids = [row[0] for row in superseded.fetchall()]

    # Every plan has its own id: results of a superseded plan can never be
    # mixed into the current one.
    plan_id = "plan_" + uuid.uuid4().hex[:10]

    created = []
    for index, device in enumerate(devices[:shard_count]):
        task = TrainingDeviceTask(
            id="task_" + uuid.uuid4().hex[:10],
            owner_id=owner_id,
            device_id=device.id,
            job_id=job.id,
            kind="preprocess",
            status="assigned",
            lease_expires_at=_now() + timedelta(seconds=DEFAULT_LEASE_SECONDS),
            shard_index=index,
            shard_count=shard_count,
            detail={
                "mode": "collaborative-preprocess",
                "plan_id": plan_id,
                "shard_index": index,
                "shard_count": shard_count,
            },
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(task)
        created.append(task)
    await db.commit()
    for task in created:
        await db.refresh(task)

    return {
        "ok": True,
        "mode": "collaborative-preprocess",
        "plan_id": plan_id,
        "superseded_tasks": superseded_ids,
        "synchronisation": (
            "Devices tokenize and count separate shards of one dataset; the coordinator "
            "aggregates the shard results. Model weight/gradient synchronisation is not "
            "implemented by this backend and is not claimed."
        ),
        "shard_count": shard_count,
        "tasks": [_task_out(t) for t in created],
        "job": _job_summary(job),
    }


@router.post("/auto-assign", tags=["devices"])
async def auto_assign(
    body: AutoAssignIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Give each unfinished job to the best available device.

    The ranking uses only capabilities the browsers reported (WebGPU, cores,
    memory). A job is skipped when it already has a live task or is finished.
    """
    owner_id = uuid.UUID(user["user_id"])
    await sweep_expired(db, owner_id)

    devices = (await db.execute(
        select(TrainingDevice).where(
            TrainingDevice.owner_id == owner_id,
            TrainingDevice.status.in_(("online", "busy")),
        )
    )).scalars().all()
    if not devices:
        raise HTTPException(status_code=409, detail="No online device is available to take work.")

    ranked = sorted(devices, key=lambda d: _capability_score(d.capabilities or {}), reverse=True)
    load = {d.id: 0 for d in ranked}
    busy = (await db.execute(
        select(TrainingDeviceTask).where(
            TrainingDeviceTask.owner_id == owner_id,
            TrainingDeviceTask.status.in_(ACTIVE_TASK_STATUSES),
        )
    )).scalars().all()
    for task in busy:
        load[task.device_id] = load.get(task.device_id, 0) + 1

    assignments = []
    for job_id in body.job_ids:
        job = await _get_owned_job(db, job_id, owner_id)
        if job.status in FINISHED_JOB_STATUSES:
            assignments.append({"job_id": job_id, "assigned": False, "reason": f"job is {job.status}"})
            continue
        if any(t.job_id == job.id and t.kind == "train" for t in busy):
            assignments.append({"job_id": job_id, "assigned": False, "reason": "already assigned to a device"})
            continue
        device = min(ranked, key=lambda d: (load.get(d.id, 0), -_capability_score(d.capabilities or {})))
        task = TrainingDeviceTask(
            id="task_" + uuid.uuid4().hex[:10],
            owner_id=owner_id,
            device_id=device.id,
            job_id=job.id,
            kind="train",
            status="assigned",
            lease_expires_at=_now() + timedelta(seconds=DEFAULT_LEASE_SECONDS),
            detail={"mode": "parallel", "auto": True},
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(task)
        load[device.id] = load.get(device.id, 0) + 1
        assignments.append({"job_id": job_id, "assigned": True, "device_id": device.id, "device_name": device.name})
    await db.commit()
    return {"ok": True, "assignments": assignments}


@router.get("/{device_id}/tasks", tags=["devices"])
async def list_device_tasks(
    device_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    owner_id = uuid.UUID(user["user_id"])
    device = await _get_device(db, device_id, owner_id)
    tasks = (await db.execute(
        select(TrainingDeviceTask).where(TrainingDeviceTask.device_id == device.id)
        .order_by(TrainingDeviceTask.created_at.desc()).limit(50)
    )).scalars().all()
    return {"tasks": [_task_out(t) for t in tasks]}


@router.post("/{device_id}/tasks/{task_id}/progress", tags=["devices"])
async def task_progress(
    device_id: str,
    task_id: str,
    body: TaskProgressIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Report real progress of a leased task and renew its lease."""
    owner_id = uuid.UUID(user["user_id"])
    task = await _get_task(db, device_id, task_id, owner_id)
    if task.status not in ACTIVE_TASK_STATUSES:
        raise HTTPException(status_code=409, detail=f"Task is {task.status}; progress is no longer accepted.")
    now = _now()
    task.progress_percent = body.progress_percent
    if body.detail:
        task.detail = {**(task.detail or {}), **body.detail}
    task.status = "running"
    task.lease_expires_at = now + timedelta(seconds=DEFAULT_LEASE_SECONDS)
    task.updated_at = now
    await db.commit()
    return {"ok": True, "task": _task_out(task)}


@router.post("/{device_id}/tasks/{task_id}/complete", tags=["devices"])
async def complete_task(
    device_id: str,
    task_id: str,
    body: TaskCompleteIn,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Finish a task with the results the device actually produced.

    When every shard of a collaborative preprocessing plan is complete, the
    aggregated result is recorded once as a job event, so the job's history says
    what the devices contributed.
    """
    owner_id = uuid.UUID(user["user_id"])
    task = await _get_task(db, device_id, task_id, owner_id)
    if task.status not in ACTIVE_TASK_STATUSES and task.status != "expired":
        raise HTTPException(status_code=409, detail=f"Task is already {task.status}.")

    now = _now()
    task.status = "failed" if body.status == "failed" else "completed"
    task.progress_percent = 100.0 if task.status == "completed" else task.progress_percent
    task.detail = {**(task.detail or {}), "result": body.detail}
    task.lease_expires_at = None
    task.updated_at = now
    await db.commit()
    await db.refresh(task)

    aggregate = None
    if task.kind == "preprocess" and task.job_id:
        plan_id = (task.detail or {}).get("plan_id")
        siblings = (await db.execute(
            select(TrainingDeviceTask).where(
                TrainingDeviceTask.job_id == task.job_id,
                TrainingDeviceTask.kind == "preprocess",
            )
        )).scalars().all()
        # Only the shards of the same plan count. Shards from a superseded plan
        # are ignored, and a shard of the current plan that expired still counts
        # as missing work, so nothing partial is ever aggregated.
        plan_tasks = [t for t in siblings if (t.detail or {}).get("plan_id") == plan_id]
        if not plan_id:
            plan_tasks = [t for t in siblings if not (t.detail or {}).get("plan_id")
                          and not (t.detail or {}).get("superseded")]
        completed = [t for t in plan_tasks if t.status == "completed"]
        if completed and len(completed) == len(plan_tasks):
            tokens = 0
            for item in completed:
                result = (item.detail or {}).get("result") or {}
                value = result.get("token_count")
                if isinstance(value, (int, float)):
                    tokens += int(value)
            aggregate = {
                "plan_id": plan_id,
                "shards": len(completed),
                "token_count": tokens,
                "devices": sorted({item.device_id for item in completed}),
            }
            await db.execute(
                text("""
                    INSERT INTO public.training_job_events (job_id, event, data)
                    VALUES (:job_id, 'device_preprocess_complete', CAST(:data AS jsonb))
                """),
                {"job_id": task.job_id, "data": json.dumps(aggregate)},
            )
            await db.commit()

    return {"ok": True, "task": _task_out(task), "aggregate": aggregate}


@router.get("/jobs/{job_id}/tasks", tags=["devices"])
async def list_job_tasks(
    job_id: str,
    user=Depends(require_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Which devices worked on this job, and what each of them finished."""
    owner_id = uuid.UUID(user["user_id"])
    job = await _get_owned_job(db, job_id, owner_id)
    tasks = (await db.execute(
        select(TrainingDeviceTask).where(TrainingDeviceTask.job_id == job.id)
        .order_by(TrainingDeviceTask.created_at.asc())
    )).scalars().all()
    device_ids = {t.device_id for t in tasks}
    names = {}
    if device_ids:
        for device in (await db.execute(select(TrainingDevice).where(TrainingDevice.id.in_(device_ids)))).scalars().all():
            names[device.id] = device.name
    return {
        "job": _job_summary(job),
        "tasks": [{**_task_out(t), "device_name": names.get(t.device_id)} for t in tasks],
    }
