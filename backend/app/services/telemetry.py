"""Hardware telemetry for the Training Intelligence dashboard.

Every value is read from the machine that actually ran the job. When a value
cannot be read — no GPU, no battery, no temperature sensor, no psutil — the field
is ``None`` and the API says "Unavailable" instead of substituting a number.

A cloud teacher model is never described as local compute: this module only ever
reports the host it is imported on.
"""
from __future__ import annotations

import os
import platform
import shutil
from typing import Any, Dict, Optional

try:  # psutil is optional so the API can boot in a minimal image
    import psutil
except Exception:  # pragma: no cover - exercised only in stripped images
    psutil = None  # type: ignore[assignment]

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore[assignment]


def _cpu_model() -> Optional[str]:
    """Read the CPU model string from the OS, or None."""
    if platform.system() == "Linux":
        try:
            with open("/proc/cpuinfo", "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            return None
    if platform.system() == "Darwin":
        try:
            import subprocess
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                 capture_output=True, text=True, timeout=2)
            return out.stdout.strip() or None
        except Exception:
            return None
    return platform.processor() or None


def _gpu_snapshot() -> Dict[str, Any]:
    if torch is None:
        return {"gpu_name": None, "gpu_memory_used_mb": None, "gpu_memory_total_mb": None,
                "gpu_utilization": None, "acceleration": None}
    try:
        if not torch.cuda.is_available():
            return {
                "gpu_name": None, "gpu_memory_used_mb": None, "gpu_memory_total_mb": None,
                "gpu_utilization": None, "acceleration": "CPU only (torch reports no CUDA device)",
            }
        name = torch.cuda.get_device_name(0)
        total = int(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024))
        used = int(torch.cuda.memory_reserved(0) / (1024 * 1024))
        utilization = None
        try:  # NVML is the only honest source of a utilisation percentage
            import pynvml  # type: ignore
            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            utilization = float(pynvml.nvmlDeviceGetUtilizationRates(handle).gpu)
        except Exception:
            utilization = None
        return {
            "gpu_name": name,
            "gpu_memory_used_mb": used,
            "gpu_memory_total_mb": total,
            "gpu_utilization": utilization,
            "acceleration": "CUDA",
        }
    except Exception:  # pragma: no cover - driver issues
        return {"gpu_name": None, "gpu_memory_used_mb": None, "gpu_memory_total_mb": None,
                "gpu_utilization": None, "acceleration": None}


def collect_runtime_sample(*, stage: Optional[str] = None, step: Optional[int] = None,
                           worker_count: Optional[int] = None,
                           detail: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One point-in-time hardware sample of the host running the job."""
    gpu = _gpu_snapshot()
    sample: Dict[str, Any] = {
        "stage": stage,
        "step": step,
        "device": "cuda" if gpu.get("acceleration") == "CUDA" else "cpu",
        "acceleration": gpu.get("acceleration"),
        "gpu_name": gpu.get("gpu_name"),
        "gpu_memory_used_mb": gpu.get("gpu_memory_used_mb"),
        "gpu_memory_total_mb": gpu.get("gpu_memory_total_mb"),
        "gpu_utilization": gpu.get("gpu_utilization"),
        "cpu_count": None,
        "cpu_model": _cpu_model(),
        "cpu_utilization": None,
        "ram_used_mb": None,
        "ram_total_mb": None,
        "cpu_temperature_c": None,
        "battery_percent": None,
        "disk_free_gb": None,
        "worker_count": worker_count,
        "detail": detail or {},
    }
    try:
        sample["cpu_count"] = os.cpu_count()
    except Exception:
        sample["cpu_count"] = None
    if psutil is not None:
        try:
            sample["cpu_count"] = psutil.cpu_count(logical=True) or sample["cpu_count"]
        except Exception:
            pass
        try:
            sample["cpu_utilization"] = float(psutil.cpu_percent(interval=None))
        except Exception:
            sample["cpu_utilization"] = None
        try:
            memory = psutil.virtual_memory()
            sample["ram_used_mb"] = int(memory.used / (1024 * 1024))
            sample["ram_total_mb"] = int(memory.total / (1024 * 1024))
        except Exception:
            pass
        try:
            temperatures = psutil.sensors_temperatures() or {}
            for entries in temperatures.values():
                if entries:
                    sample["cpu_temperature_c"] = float(entries[0].current)
                    break
        except Exception:
            sample["cpu_temperature_c"] = None
        try:
            battery = psutil.sensors_battery()
            sample["battery_percent"] = float(battery.percent) if battery is not None else None
        except Exception:
            sample["battery_percent"] = None
    try:
        usage = shutil.disk_usage("/")
        sample["disk_free_gb"] = round(usage.free / (1024 ** 3), 2)
    except Exception:
        sample["disk_free_gb"] = None
    return sample


async def persist_snapshot(db, owner_id, job_id: str, sample: Dict[str, Any]) -> None:
    """Insert one snapshot row. Never raises into the training loop."""
    from sqlalchemy import text

    await db.execute(text("""
        INSERT INTO public.training_runtime_snapshots
        (id, owner_id, job_id, stage, step, device, cpu_count, cpu_model, cpu_utilization,
         ram_used_mb, ram_total_mb, gpu_name, gpu_memory_used_mb, gpu_memory_total_mb,
         gpu_utilization, cpu_temperature_c, battery_percent, worker_count, detail)
        VALUES (gen_random_uuid(), :owner_id, :job_id, :stage, :step, :device, :cpu_count, :cpu_model,
                :cpu_utilization, :ram_used_mb, :ram_total_mb, :gpu_name,
                :gpu_memory_used_mb, :gpu_memory_total_mb, :gpu_utilization,
                :cpu_temperature_c, :battery_percent, :worker_count, CAST(:detail AS jsonb))
    """), {
        "owner_id": owner_id, "job_id": job_id,
        "stage": sample.get("stage"), "step": sample.get("step"),
        "device": sample.get("device"), "cpu_count": sample.get("cpu_count"),
        "cpu_model": sample.get("cpu_model"), "cpu_utilization": sample.get("cpu_utilization"),
        "ram_used_mb": sample.get("ram_used_mb"), "ram_total_mb": sample.get("ram_total_mb"),
        "gpu_name": sample.get("gpu_name"),
        "gpu_memory_used_mb": sample.get("gpu_memory_used_mb"),
        "gpu_memory_total_mb": sample.get("gpu_memory_total_mb"),
        "gpu_utilization": sample.get("gpu_utilization"),
        "cpu_temperature_c": sample.get("cpu_temperature_c"),
        "battery_percent": sample.get("battery_percent"),
        "worker_count": sample.get("worker_count"),
        "detail": _json(sample.get("detail") or {}),
    })


def _json(value: Any) -> str:
    import json
    return json.dumps(value, default=str)
