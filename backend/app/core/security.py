"""CORPUS ULTIMATE — Security utilities.

Rate limiting middleware, JWT helpers, and input validation.
"""
import time
from collections import defaultdict
from fastapi import Request, HTTPException, status
from fastapi.responses import JSONResponse

from app.config import settings

# Simple in-memory rate limiter (per IP). The limit is configurable through
# RATE_LIMIT_REQUESTS_PER_MINUTE so an operator can raise it for a busy deploy
# without editing code; 60 remains the default.
_request_counts = defaultdict(list)
RATE_LIMIT_REQUESTS = 60
RATE_LIMIT_WINDOW = 60  # seconds


def request_limit() -> int:
    """Effective per-minute request limit for one client IP."""
    configured = getattr(settings, "RATE_LIMIT_REQUESTS_PER_MINUTE", None)
    try:
        value = int(configured) if configured is not None else 0
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else RATE_LIMIT_REQUESTS


async def rate_limit_middleware(request: Request, call_next):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Clean old entries
    _request_counts[client_ip] = [
        t for t in _request_counts[client_ip] if now - t < RATE_LIMIT_WINDOW
    ]

    if len(_request_counts[client_ip]) >= request_limit():
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": "Rate limit exceeded"},
        )

    _request_counts[client_ip].append(now)
    response = await call_next(request)
    return response


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
