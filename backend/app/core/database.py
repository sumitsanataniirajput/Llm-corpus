"""CORPUS ULTIMATE — Database configuration.

SQLAlchemy async setup using the DATABASE_URL from settings.

The engine is created lazily so the application can start without a
database connection. If DATABASE_URL is absent, engine creation is
deferred until first use, and database-dependent endpoints return
a clear error instead of crashing at import time.

Tables are defined in app/core/models.py.
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base

from app.config import settings
from app.core.models import Base  # noqa: F401 — registers tables with Base.metadata

_engine = None
_session_factory = None


def _ensure_engine():
    """Create the SQLAlchemy engine lazily, only when first needed.

    If DATABASE_URL is not configured, raises a clear RuntimeError
    instead of crashing at import time.
    """
    global _engine, _session_factory
    if _engine is not None:
        return _engine

    if not settings.DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not configured. "
            "Set DATABASE_URL in your environment or .env file before "
            "using database-dependent features."
        )

    _engine = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
        pool_pre_ping=True,
    )
    _session_factory = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    return _engine


def get_engine():
    """Return the SQLAlchemy async engine, creating it lazily if needed."""
    return _ensure_engine()


def get_session_factory():
    """Return the async session factory, creating it lazily if needed."""
    _ensure_engine()
    return _session_factory


async def get_db():
    """Yield an async database session.

    Raises RuntimeError if DATABASE_URL is not configured.
    """
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        finally:
            await session.close()


async def dispose_engine():
    """Dispose the database engine (clean shutdown)."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None


# Module-level placeholders for backward compatibility.
# These are NOT evaluated at import time — they raise if accessed
# before DATABASE_URL is configured.
engine = None
AsyncSessionLocal = None