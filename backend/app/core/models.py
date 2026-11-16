"""CORPUS ULTIMATE — SQLAlchemy database models.

Defines persistent tables for model configurations and API keys.
All user-owned tables include owner_id for Row Level Security.

IMPORTANT: These models must match the existing Supabase database schema.
- owner_id is UUID type (matches live DB, not text)
- ApiKey table is "api_keys_metadata" (matches live DB, not "api_keys")
- key_hash is present after migration 002 and stores only a SHA-256 digest.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    Column, String, Text, DateTime, Boolean, ForeignKey, Index, BigInteger, Float, func
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def _utcnow():
    return datetime.now(timezone.utc)


class Model(Base):
    """Model configuration — owned by a Supabase user."""
    __tablename__ = "models"

    id = Column(String, primary_key=True, default=lambda: "model_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    config = Column(JSONB, nullable=False, default=dict)
    version = Column(String, nullable=False, default="1.0")
    status = Column(String, nullable=False, default="idle")
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_models_owner_id", "owner_id"),
    )


class ApiKey(Base):
    """API key metadata — owned by a Supabase user.

    Maps to the existing "api_keys_metadata" table in Supabase.
    Stores key metadata and a SHA-256 hash of the full key, never the raw key.
    """
    __tablename__ = "api_keys_metadata"

    id = Column(String, primary_key=True, default=lambda: "key_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    prefix = Column(String, nullable=False, default="corpus_")
    key_hash = Column(Text, nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    last_used = Column(DateTime(timezone=True), nullable=True)
    revoked = Column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("ix_api_keys_metadata_owner_id", "owner_id"),
    )


class TrainingJob(Base):
    """Training job — owned by a Supabase user."""
    __tablename__ = "training_jobs"

    id = Column(String, primary_key=True, default=lambda: "job_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    model_id = Column(String, ForeignKey("models.id"), nullable=True)
    dataset_id = Column(String, ForeignKey("datasets.id"), nullable=True)
    status = Column(String, nullable=False, default="queued")
    engine = Column(String, nullable=False, default="pytorch")
    compute = Column(String, nullable=False, default="local")
    config = Column(JSONB, nullable=True, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_training_jobs_owner_id", "owner_id"),
        Index("ix_training_jobs_model_id", "model_id"),
    )


class Dataset(Base):
    """Training dataset — owned by a Supabase user."""
    __tablename__ = "datasets"

    id = Column(String, primary_key=True, default=lambda: "ds_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    format = Column(String, nullable=True)
    size = Column(BigInteger, nullable=True, default=0)  # bigint in DB
    # pending → no stored file yet; uploaded → file present and trainable
    status = Column(String, nullable=False, default="pending")
    token_count = Column(BigInteger, nullable=True, default=0)  # bigint in DB
    checksum = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_datasets_owner_id", "owner_id"),
    )


class Experiment(Base):
    """Experiment — owned by a Supabase user."""
    __tablename__ = "experiments"

    id = Column(String, primary_key=True, default=lambda: "exp_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="active")
    config = Column(JSONB, nullable=True, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_experiments_owner_id", "owner_id"),
    )


class ComputeWorker(Base):
    """Compute worker — owned by a Supabase user."""
    __tablename__ = "compute_workers"

    id = Column(String, primary_key=True, default=lambda: "worker_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    os = Column(String, nullable=True)
    cpu = Column(String, nullable=True)
    ram = Column(BigInteger, nullable=True)  # bigint in DB
    gpu = Column(String, nullable=True)
    vram = Column(BigInteger, nullable=True)  # bigint in DB
    backend = Column(String, nullable=True)
    status = Column(String, nullable=False, default="offline")
    last_heartbeat = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_compute_workers_owner_id", "owner_id"),
    )


class StorageObject(Base):
    """Storage object metadata — owned by a Supabase user."""
    __tablename__ = "storage_objects"

    id = Column(String, primary_key=True, default=lambda: "obj_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    bucket = Column(String, nullable=False)
    path = Column(String, nullable=False)
    file_name = Column(String, nullable=True)
    file_size = Column(Text, nullable=True)  # bigint in DB
    mime_type = Column(String, nullable=True)
    checksum = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_storage_objects_owner_id", "owner_id"),
    )


class EvaluationRun(Base):
    """Evaluation run — owned by a Supabase user."""
    __tablename__ = "evaluation_runs"

    id = Column(String, primary_key=True, default=lambda: "eval_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    model_id = Column(String, ForeignKey("models.id"), nullable=True)
    test_type = Column(String, nullable=True)
    score = Column(Float, nullable=True)  # double precision in DB
    status = Column(String, nullable=False, default="completed")
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_evaluation_runs_owner_id", "owner_id"),
        Index("ix_evaluation_runs_model_id", "model_id"),
    )


class Checkpoint(Base):
    """Model checkpoint — owned by a Supabase user."""
    __tablename__ = "checkpoints"

    id = Column(String, primary_key=True, default=lambda: "ckpt_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    model_id = Column(String, ForeignKey("models.id"), nullable=True)
    job_id = Column(String, ForeignKey("training_jobs.id"), nullable=True)
    storage_path = Column(String, nullable=False)
    step = Column(BigInteger, nullable=True)
    loss = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_checkpoints_owner_id", "owner_id"),
        Index("ix_checkpoints_model_id", "model_id"),
    )
