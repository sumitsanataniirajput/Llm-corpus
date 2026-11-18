"""Test fixtures for CORPUS ULTIMATE backend tests.

These tests run against a **real PostgreSQL** instance (started by pgserver)
and a **fake in-memory Supabase Storage** bucket. They never touch the network
and never fabricate training metrics — the ML engine itself is stubbed only
where noted, everything else (SQLAlchemy models, endpoints, worker DB access)
is the real code path.
"""
import asyncio
import os
import sys
import types
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# ---------------------------------------------------------------------------
# Start a throw-away PostgreSQL instance *before* importing app.config,
# because Settings reads DATABASE_URL at import time.
# ---------------------------------------------------------------------------
import pgserver  # noqa: E402

PG_DATA_DIR = Path("/tmp/corpus-test-pg")
PG_DATA_DIR.mkdir(parents=True, exist_ok=True)
_pg = pgserver.get_server(str(PG_DATA_DIR), cleanup_mode=None)
_pg_uri = _pg.get_uri()  # postgresql://postgres:@/postgres?host=/tmp/corpus-test-pg

# SQLAlchemy + asyncpg DSN built from the pgserver URI.
DATABASE_URL = (
    "postgresql+asyncpg://postgres@/postgres?host=" + str(PG_DATA_DIR)
)

os.environ["DATABASE_URL"] = DATABASE_URL
os.environ.setdefault("SUPABASE_URL", "https://test-project.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-a-default-value")
os.environ.setdefault("WORKER_AUTH_SECRET", "test-worker-secret-not-default")
os.environ.setdefault("STORAGE_BUCKET", "corpus-storage")
os.environ.setdefault("ALLOWED_HOSTS", '["*"]')
os.environ.setdefault("LOG_LEVEL", "WARNING")

# ---------------------------------------------------------------------------
# Stub third-party packages that are irrelevant to this test slice
# (Supabase SDK / PyTorch). The application code under test is unchanged.
# ---------------------------------------------------------------------------
from tests.fakes import FakeSupabaseClient, install_dependency_stubs  # noqa: E402

install_dependency_stubs()

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.core.database import Base, dispose_engine, get_session_factory  # noqa: E402
from app.core.models import Model, TrainingJob  # noqa: E402
from app.dependencies import get_db_session, require_user  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.api.endpoints import datasets as datasets_endpoints  # noqa: E402
from app.api.endpoints import models as models_endpoints  # noqa: E402
from app.core import security as security_module  # noqa: E402

USER_ID = str(uuid.uuid4())
OTHER_USER_ID = str(uuid.uuid4())


# Tables that the application uses through raw SQL and therefore has no ORM
# class for. Definitions mirror supabase/migrations/001_initial_schema.sql.
RAW_SQL_TABLES = [
    """
    CREATE TABLE IF NOT EXISTS dataset_files (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      dataset_id text REFERENCES datasets(id) ON DELETE CASCADE,
      storage_path text NOT NULL,
      file_name text,
      file_size bigint,
      checksum text,
      uploaded_at timestamptz DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS training_job_events (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      job_id text REFERENCES training_jobs(id) ON DELETE CASCADE,
      event text NOT NULL,
      data jsonb,
      created_at timestamptz DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS training_metrics (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      job_id text REFERENCES training_jobs(id) ON DELETE CASCADE,
      step bigint,
      loss double precision,
      learning_rate double precision,
      tokens_per_second double precision,
      created_at timestamptz DEFAULT now()
    )
    """,
    """
    ALTER TABLE models ADD COLUMN IF NOT EXISTS tokenizer_ref text
    """,
    # Migration 007/008 columns and tables, applied idempotently so a reused
    # test database file matches the ORM models.
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS stage text DEFAULT 'queued'",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS progress_percent double precision DEFAULT 0",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS total_steps bigint",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS completed_steps bigint DEFAULT 0",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS total_epochs integer",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS current_epoch integer DEFAULT 0",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS processed_tokens bigint DEFAULT 0",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS last_loss double precision",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS failure_reason text",
    "ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz",
    """
    ALTER TABLE evaluation_runs ALTER COLUMN status SET DEFAULT 'completed'
    """,
    """
    CREATE TABLE IF NOT EXISTS model_versions (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      model_id text REFERENCES models(id) ON DELETE CASCADE,
      version text NOT NULL,
      config jsonb,
      storage_ref text,
      created_at timestamptz DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS model_architectures (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      model_id text REFERENCES models(id) ON DELETE CASCADE,
      architecture jsonb NOT NULL,
      parameter_count bigint,
      created_at timestamptz DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id text PRIMARY KEY,
      owner_id uuid NOT NULL,
      model_id text REFERENCES models(id),
      test_type text,
      score double precision,
      status text DEFAULT 'completed',
      created_at timestamptz DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS conversations (
      id text PRIMARY KEY,
      owner_id uuid NOT NULL,
      title text,
      model_id text REFERENCES models(id),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
    """,
]


@pytest.fixture(scope="session", autouse=True)
def _prepare_database():
    """Create the schema once for the whole session."""
    async def _create():
        from sqlalchemy import text
        engine = create_async_engine(DATABASE_URL, future=True)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            for ddl in RAW_SQL_TABLES:
                await conn.execute(text(ddl))
        await engine.dispose()

    asyncio.run(_create())
    yield


async def _safe_dispose():
    """Dispose the app engine, tolerating pools created on another loop."""
    try:
        await dispose_engine()
    except Exception:
        from app.core import database as database_module
        database_module._engine = None
        database_module._session_factory = None


@pytest.fixture(autouse=True)
async def _clean_tables(_prepare_database):
    """Truncate every table between tests and reset the engine caches."""
    async def _truncate():
        engine = create_async_engine(DATABASE_URL, future=True)
        table_names = ", ".join(f"public.{t.name}" for t in reversed(Base.metadata.sorted_tables))
        async with engine.begin() as conn:
            from sqlalchemy import text
            await conn.execute(text(f"TRUNCATE TABLE {table_names} CASCADE"))
        await engine.dispose()

    await _truncate()
    # The app engine is bound to the running event loop; drop it so the next
    # test gets a fresh engine inside its own loop.
    await _safe_dispose()
    yield
    await _safe_dispose()


@pytest.fixture
def storage():
    """In-memory private bucket shared by the app and the worker."""
    return FakeSupabaseClient()


@pytest.fixture(autouse=True)
def _patch_storage(storage, monkeypatch):
    # datasets and models endpoints use `create_client(...)`
    monkeypatch.setattr(datasets_endpoints, "create_client", lambda url, key: storage)
    monkeypatch.setattr(models_endpoints, "create_client", lambda url, key: storage)
    yield


@pytest.fixture(autouse=True)
def _relax_rate_limit(monkeypatch):
    monkeypatch.setattr(security_module, "RATE_LIMIT_REQUESTS", 100000)
    yield


@pytest.fixture
def _auth_overrides(storage):
    """Override authentication + DB session.

    The authenticated user is taken from the ``Authorization: Bearer <uuid>``
    header so a test can act as two different accounts with two clients.
    """
    from fastapi import Request

    async def _override_db():
        factory = get_session_factory()
        async with factory() as session:
            yield session

    async def _override_user(request: Request):
        header = request.headers.get("authorization", "")
        user_id = header.replace("Bearer ", "").strip() or USER_ID
        return {"user_id": user_id, "email": f"{user_id[:8]}@example.com", "token": "test-token"}

    fastapi_app.dependency_overrides[get_db_session] = _override_db
    fastapi_app.dependency_overrides[require_user] = _override_user
    yield
    fastapi_app.dependency_overrides.pop(get_db_session, None)
    fastapi_app.dependency_overrides.pop(require_user, None)


def _make_http_client(user_id):
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=fastapi_app)
    return AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {user_id}"},
    )


@pytest.fixture
async def http(_auth_overrides):
    async with _make_http_client(USER_ID) as client:
        yield client


@pytest.fixture
async def http_as_other(_auth_overrides):
    async with _make_http_client(OTHER_USER_ID) as client:
        yield client


def run_db(coro_fn):
    """Run a DB helper coroutine against a short-lived engine."""
    async def _run():
        engine = create_async_engine(DATABASE_URL, future=True)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with factory() as session:
                return await coro_fn(session)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


async def db_rows(model, **filters):
    """Fetch rows of a model with optional equality filters (async version)."""
    from sqlalchemy import select
    engine = create_async_engine(DATABASE_URL, future=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            query = select(model)
            for key, value in filters.items():
                query = query.where(getattr(model, key) == value)
            result = await session.execute(query)
            return list(result.scalars().all())
    finally:
        await engine.dispose()
