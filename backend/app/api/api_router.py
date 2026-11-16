"""CORPUS ULTIMATE — Versioned API router.

Mounts all endpoint modules under /api/v1.
"""
from fastapi import APIRouter

api_router = APIRouter()

# Import endpoint modules (created in later phases)
try:
    from app.api.endpoints import auth as auth_endpoints
    api_router.include_router(auth_endpoints.router, prefix="/auth", tags=["auth"])
except Exception:
    pass

try:
    from app.api.endpoints import models as models_endpoints
    api_router.include_router(models_endpoints.router, prefix="/models", tags=["models"])
except Exception:
    pass

try:
    from app.api.endpoints import training as training_endpoints
    api_router.include_router(training_endpoints.router, prefix="/training", tags=["training"])
except Exception:
    pass

try:
    from app.api.endpoints import inference as inference_endpoints
    api_router.include_router(inference_endpoints.router, prefix="/inference", tags=["inference"])
except Exception:
    pass

try:
    from app.api.endpoints import datasets as datasets_endpoints
    api_router.include_router(datasets_endpoints.router, prefix="/datasets", tags=["datasets"])
except Exception:
    pass

try:
    from app.api.endpoints import evaluation as evaluation_endpoints
    api_router.include_router(evaluation_endpoints.router, prefix="/evaluation", tags=["evaluation"])
except Exception:
    pass

try:
    from app.api.endpoints import compute as compute_endpoints
    api_router.include_router(compute_endpoints.router, prefix="/compute", tags=["compute"])
except Exception:
    pass

try:
    from app.api.endpoints import storage as storage_endpoints
    api_router.include_router(storage_endpoints.router, prefix="/storage", tags=["storage"])
except Exception:
    pass

try:
    from app.api.endpoints import experiments as experiments_endpoints
    api_router.include_router(experiments_endpoints.router, prefix="/experiments", tags=["experiments"])
except Exception:
    pass

try:
    from app.api.endpoints import settings as settings_endpoints
    api_router.include_router(settings_endpoints.router, prefix="/settings", tags=["settings"])
except Exception:
    pass

try:
    from app.api.endpoints import version as version_endpoints
    api_router.include_router(version_endpoints.router, prefix="/version", tags=["version"])
except Exception:
    pass

# Health is in main.py

__all__ = ["api_router"]