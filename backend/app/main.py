"""CORPUS ULTIMATE — FastAPI application entry point.

Versioned REST API under /api/v1 with WebSocket endpoints for
real-time training progress, logs, job status, and chat streaming.

No automatic database table creation — migrations are managed separately.
"""
import logging
import datetime
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.api.api_router import api_router
from app.core.database import get_session_factory, dispose_engine
from app.core.security import rate_limit_middleware

logging.basicConfig(level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))
logger = logging.getLogger("corpus")

app = FastAPI(
    title="CORPUS ULTIMATE API",
    description="Personal LLM development, training, and monitoring platform",
    version="1.0.0",
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
)

# CORS — restrict to configured origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}):\d+",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

# Trusted host — use environment-configured allowed hosts, safe dev defaults
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.ALLOWED_HOSTS,
)

# Rate limiting middleware
app.middleware("http")(rate_limit_middleware)

# Include versioned API router
app.include_router(api_router, prefix="/api/v1")


# ── Liveness endpoint ──
# Reports only that the process is running. Does NOT check database.
@app.get("/health", tags=["Health"])
async def health_liveness():
    """Liveness check — confirms the process is running."""
    return {
        "status": "ok",
        "service": "CORPUS ULTIMATE",
        "version": "1.0.0",
        "check": "liveness",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# ── Readiness endpoint ──
# Verifies required dependencies (database, Supabase config) without modifying data.
@app.get("/ready", tags=["Health"])
async def health_readiness():
    """Readiness check — verifies database and Supabase connectivity."""
    checks = {}
    overall = "ok"

    # Database connectivity
    try:
        factory = get_session_factory()
        async with factory() as session:
            from sqlalchemy import text
            await session.execute(text("SELECT 1"))
        checks["database"] = "connected"
    except RuntimeError as e:
        checks["database"] = "not_configured"
        checks["database_error"] = str(e)[:200]
        overall = "degraded"
    except Exception as e:
        checks["database"] = "disconnected"
        checks["database_error"] = str(e)[:200]
        overall = "degraded"

    # Supabase configuration
    if settings.SUPABASE_URL and settings.SUPABASE_ANON_KEY:
        checks["supabase"] = "configured"
    else:
        checks["supabase"] = "not_configured"
        overall = "degraded"

    return {
        "status": overall,
        "service": "CORPUS ULTIMATE",
        "version": "1.0.0",
        "check": "readiness",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **checks,
    }


# ── Versioned health endpoint ──
# Existing /api/v1/health — reports database status but does not fail fast.
@app.get("/api/v1/health", tags=["Health"])
async def health_versioned():
    """Versioned health check with database connectivity diagnostics."""
    db_status = "disconnected"
    db_error = None

    try:
        factory = get_session_factory()
        async with factory() as session:
            from sqlalchemy import text
            await session.execute(text("SELECT 1"))
            db_status = "connected"
    except RuntimeError as e:
        db_status = "not_configured"
        db_error = str(e)[:200]
    except Exception as e:
        db_status = "disconnected"
        db_error = str(e)[:200]

    overall = "ok" if db_status == "connected" else "degraded"

    return {
        "status": overall,
        "service": "CORPUS ULTIMATE",
        "version": "1.0.0",
        "database": db_status,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **({"db_error": db_error} if db_error else {}),
    }


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# Startup — validate configuration only. No automatic table creation.
@app.on_event("startup")
async def startup():
    # Validate required configuration
    missing = []
    if not settings.SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not settings.SUPABASE_ANON_KEY:
        missing.append("SUPABASE_ANON_KEY")
    if not settings.DATABASE_URL:
        missing.append("DATABASE_URL")

    if missing:
        logger.warning(
            "Missing required configuration: %s. "
            "Some features may be unavailable.", ", ".join(missing)
        )

    logger.info("CORPUS ULTIMATE API started (no automatic database migration)")


# Shutdown — clean up resources
@app.on_event("shutdown")
async def shutdown():
    await dispose_engine()
    logger.info("Database engine disposed")


if __name__ == "__main__":
    import uvicorn
    # Bind to 0.0.0.0 so the backend is reachable from Android devices
    # on the same Wi-Fi network. For local-only operation, use 127.0.0.1.
    port = int(settings.PORT) if hasattr(settings, "PORT") and settings.PORT else 8000
    uvicorn.run(app, host="0.0.0.0", port=port)
