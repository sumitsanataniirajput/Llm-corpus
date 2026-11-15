"""CORPUS ULTIMATE — FastAPI dependencies.

Provides database session, current user, and worker auth.

Supabase JWT verification:
Supabase issues JWTs that can be verified by calling the Supabase Auth
user endpoint (GET /auth/v1/user) with the Bearer token in the Authorization
header and the project's public API key in the apikey header. Supabase
validates the JWT signature, expiry, and returns the user record if valid.
This is the recommended server-side verification method.

The application's internal SECRET_KEY is NEVER used to verify Supabase-issued
user tokens.
"""
import httpx
import logging
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.config import settings
from app.core.database import get_session_factory, AsyncSessionLocal
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("corpus")

security = HTTPBearer(auto_error=False)


async def get_db_session() -> AsyncSession:
    """Yield an async database session using the lazy session factory."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        finally:
            await session.close()


def _get_supabase_public_key() -> str:
    """Return the Supabase public key for verifying user tokens.

    Prefers SUPABASE_PUBLISHABLE_KEY, falls back to SUPABASE_ANON_KEY.
    Raises HTTPException 500 if neither is configured (backend config failure,
    not a user error).
    """
    key = settings.SUPABASE_PUBLISHABLE_KEY or settings.SUPABASE_ANON_KEY
    if not key:
        logger.error("Supabase public key not configured in backend")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service not configured: missing Supabase public key",
        )
    return key


async def verify_supabase_token(token: str) -> Optional[dict]:
    """Verify a Supabase access token by calling the Supabase Auth user endpoint.

    Returns the user dict (id, email, etc.) if valid, or None if invalid/expired.
    Raises HTTPException 503 if the backend Supabase configuration is invalid.
    """
    if not settings.SUPABASE_URL:
        logger.error("Supabase URL not configured in backend")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service not configured: missing Supabase URL",
        )

    api_key = _get_supabase_public_key()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                settings.SUPABASE_URL.rstrip("/") + "/auth/v1/user",
                headers={
                    "Authorization": "Bearer " + token,
                    "apikey": api_key,
                },
            )
            if resp.status_code == 200:
                return resp.json()
            # 401/403 = invalid or expired user token
            if resp.status_code in (401, 403):
                return None
            # Other errors = Supabase service issue
            logger.warning(
                "Supabase /auth/v1/user returned %s: %s",
                resp.status_code,
                resp.text[:200],
            )
            return None
    except httpx.ConnectError:
        logger.error("Cannot connect to Supabase Auth at %s", settings.SUPABASE_URL)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable: cannot reach Supabase",
        )
    except httpx.TimeoutException:
        logger.error("Supabase Auth request timed out")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable: request timed out",
        )
    except Exception as exc:
        logger.error("Supabase token verification failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """Extract and validate the current user from a Bearer JWT.

    Verifies the token against Supabase Auth. Returns the authenticated
    Supabase user (id, email, etc.) or None if no token provided.
    """
    if credentials is None:
        return None
    token = credentials.credentials
    if not token:
        return None
    try:
        user = await verify_supabase_token(token)
    except HTTPException:
        # Configuration or service errors are re-raised as-is (503)
        raise
    if user is None:
        return None
    return {
        "user_id": user.get("id"),
        "email": user.get("email"),
        "token": token,
        "user": user,
    }


async def require_user(
    user: dict = Depends(get_current_user),
):
    """Dependency that requires an authenticated user."""
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def verify_worker_secret(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """Verify worker registration secret."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Worker authentication required",
        )
    if credentials.credentials != settings.WORKER_AUTH_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid worker secret",
        )
    return True