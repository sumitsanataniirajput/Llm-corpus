"""CORPUS ULTIMATE — Security utilities.

Rate limiting middleware, JWT helpers, and input validation.
"""
import time
from collections import OrderedDict
from fastapi import Request, HTTPException, status
from fastapi.responses import JSONResponse

from app.config import settings

# In-memory per-client rate limiter. The limit is configurable through
# RATE_LIMIT_REQUESTS_PER_MINUTE so an operator can raise it for a busy deploy
# without editing code; 60 remains the default.
#
# The store is bounded: an unbounded defaultdict keyed by client IP grew forever
# on long-lived Render instances, and a spoofed X-Forwarded-For header could
# create unlimited keys. Health checks are exempt so Render's liveness probes
# cannot consume a user's request budget.
_request_counts = OrderedDict()
_last_cleanup = 0.0
RATE_LIMIT_REQUESTS = 60
RATE_LIMIT_WINDOW = 60  # seconds
MAX_TRACKED_CLIENTS = 10_000
RATE_LIMIT_EXEMPT_PATHS = frozenset({
    "/health", "/ready", "/api/v1/health", "/api/v1/ready",
})


def request_limit() -> int:
    """Effective per-minute request limit for one client IP."""
    configured = getattr(settings, "RATE_LIMIT_REQUESTS_PER_MINUTE", None)
    try:
        value = int(configured) if configured is not None else 0
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else RATE_LIMIT_REQUESTS


def _client_ip(request: Request) -> str:
    """Resolve the client IP without trusting a spoofable proxy header.

    X-Forwarded-For / X-Real-IP are honored only when the immediate peer is a
    configured trusted proxy. Otherwise the socket address is used.
    """
    peer = request.client.host if request.client else "unknown"
    trusted = getattr(settings, "TRUSTED_PROXY_IPS", None) or []
    if peer not in trusted:
        return peer
    forwarded = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")
    if not forwarded:
        return peer
    candidate = forwarded.split(",")[0].strip()
    return candidate or peer


def _prune(now: float) -> None:
    """Drop expired timestamps and empty client buckets at most once per window."""
    global _last_cleanup
    if now - _last_cleanup < RATE_LIMIT_WINDOW:
        return
    _last_cleanup = now
    for key in list(_request_counts.keys()):
        timestamps = [t for t in _request_counts[key] if now - t < RATE_LIMIT_WINDOW]
        if timestamps:
            _request_counts[key] = timestamps
        else:
            _request_counts.pop(key, None)


def reset_rate_limit_state() -> None:
    """Test helper / operational safety valve; never exposed as an endpoint."""
    global _last_cleanup
    _request_counts.clear()
    _last_cleanup = 0.0


async def rate_limit_middleware(request: Request, call_next):
    if request.url.path in RATE_LIMIT_EXEMPT_PATHS:
        return await call_next(request)

    now = time.time()
    _prune(now)
    client_ip = _client_ip(request)
    timestamps = [t for t in _request_counts.get(client_ip, []) if now - t < RATE_LIMIT_WINDOW]

    if len(timestamps) >= request_limit():
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": "Rate limit exceeded"},
        )

    timestamps.append(now)
    _request_counts[client_ip] = timestamps
    _request_counts.move_to_end(client_ip)
    while len(_request_counts) > MAX_TRACKED_CLIENTS:
        _request_counts.popitem(last=False)
    return await call_next(request)


def create_access_token(data: dict, expires_delta_minutes: int = None):
    """Create an application-specific JWT token.

    Uses settings.SECRET_KEY (not hardcoded). This is for internal app tokens
    only — Supabase user tokens are verified via the Supabase Auth API.
    """
    from jose import jwt
    from datetime import datetime, timedelta, timezone

    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=expires_delta_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def validate_model_config(config: dict) -> dict:
    """Validate a model configuration. Returns {valid, errors, parameters}."""
    errors = []
    vocab = config.get("vocab_size", 0)
    context = config.get("context_length", 0)
    d_model = config.get("d_model", 0)
    n_layers = config.get("n_layers", 0)
    n_heads = config.get("n_heads", 0)
    d_ff = config.get("d_ff", 0)

    if vocab < 100:
        errors.append("Vocabulary size must be at least 100.")
    if context < 16:
        errors.append("Context length must be at least 16.")
    if d_model < 16:
        errors.append("Embedding dimension must be at least 16.")
    if n_layers < 1:
        errors.append("At least 1 layer is required.")
    if n_heads < 1:
        errors.append("At least 1 attention head is required.")
    if d_model % n_heads != 0:
        errors.append("Embedding dimension must be divisible by attention heads.")
    if d_ff < 32:
        errors.append("Feed-forward dimension must be at least 32.")

    # Parameter estimate
    parameters = 0
    if vocab and d_model and context:
        embeddings = vocab * d_model + context * d_model
        per_layer = 4 * d_model * d_model + 2 * d_model * d_ff + 4 * d_model
        parameters = embeddings + n_layers * per_layer + d_model * vocab

    if parameters > settings.MAX_PARAMETERS_DEFAULT:
        errors.append(
            f"Estimated parameters ({parameters:,}) exceed {settings.MAX_PARAMETERS_DEFAULT:,} "
            "— explicit confirmation required."
        )

    return {"valid": len(errors) == 0, "errors": errors, "parameters": parameters}
