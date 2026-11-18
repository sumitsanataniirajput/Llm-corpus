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
    tokenizer_ref = Column(Text, nullable=True)
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
    # Real progress, written by the worker from the engine's own step counter
    # (migration 007). Anything the engine cannot measure stays NULL so the UI
    # can say "not available" instead of inventing a number.
    stage = Column(String, nullable=True, default="queued")
    progress_percent = Column(Float, nullable=True, default=0.0)
    total_steps = Column(BigInteger, nullable=True)
    completed_steps = Column(BigInteger, nullable=True, default=0)
    total_epochs = Column(BigInteger, nullable=True)
    current_epoch = Column(BigInteger, nullable=True, default=0)
    processed_tokens = Column(BigInteger, nullable=True, default=0)
    last_loss = Column(Float, nullable=True)
    progress_updated_at = Column(DateTime(timezone=True), nullable=True)
    failure_reason = Column(Text, nullable=True)
    # Soft delete of the history record only; checkpoints/models/datasets keep
    # their own rows and are never removed by deleting a job.
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_training_jobs_owner_id", "owner_id"),
        Index("ix_training_jobs_model_id", "model_id"),
        Index("ix_training_jobs_owner_created_live", "owner_id", "created_at"),
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
    status = Column(String, nullable=False, default="pending", server_default="'pending'")
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
    file_size = Column(BigInteger, nullable=True)  # bigint in DB
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


class TrainingDevice(Base):
    """A device that may contribute compute to this account (migration 008)."""
    __tablename__ = "training_devices"

    id = Column(String, primary_key=True, default=lambda: "dev_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    name = Column(String, nullable=False)
    device_type = Column(String, nullable=True)
    platform = Column(String, nullable=True)
    capabilities = Column(JSONB, nullable=False, default=dict)
    # online | busy | paused | offline
    status = Column(String, nullable=False, default="offline")
    last_heartbeat = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_training_devices_owner_id", "owner_id"),
    )


class TrainingDeviceTask(Base):
    """Lease-backed unit of work handed to one device (migration 008)."""
    __tablename__ = "training_device_tasks"

    id = Column(String, primary_key=True, default=lambda: "task_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    device_id = Column(String, ForeignKey("training_devices.id", ondelete="CASCADE"), nullable=False)
    job_id = Column(String, ForeignKey("training_jobs.id", ondelete="CASCADE"), nullable=True)
    # train | preprocess
    kind = Column(String, nullable=False, default="train")
    # assigned | running | completed | failed | expired
    status = Column(String, nullable=False, default="assigned")
    lease_expires_at = Column(DateTime(timezone=True), nullable=True)
    progress_percent = Column(Float, nullable=False, default=0.0)
    shard_index = Column(BigInteger, nullable=True)
    shard_count = Column(BigInteger, nullable=True)
    detail = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_training_device_tasks_owner_id", "owner_id"),
        Index("ix_training_device_tasks_device_id", "device_id"),
        Index("ix_training_device_tasks_job_id", "job_id"),
    )


class Checkpoint(Base):
    """Model checkpoint; ownership is inherited from its parent model.

    The live public.checkpoints table has no owner_id column. All reads and
    writes must therefore authorize through the referenced models.owner_id.
    """
    __tablename__ = "checkpoints"

    id = Column(String, primary_key=True, default=lambda: "ckpt_" + uuid.uuid4().hex[:12])
    model_id = Column(String, ForeignKey("models.id"), nullable=True)
    job_id = Column(String, ForeignKey("training_jobs.id"), nullable=True)
    storage_path = Column(String, nullable=False)
    step = Column(BigInteger, nullable=True)
    loss = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_checkpoints_model_id", "model_id"),
    )


# ---------------------------------------------------------------------------
# AI teacher network, distillation and student-training telemetry (migrations
# 010/011). Provider credentials live only as an AES-256-GCM envelope; nothing
# on these tables can reproduce a raw API key.
# ---------------------------------------------------------------------------

class AiProviderConnection(Base):
    """An external AI teacher provider connection owned by one account."""
    __tablename__ = "ai_provider_connections"

    id = Column(String, primary_key=True, default=lambda: "prov_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    provider_type = Column(String, nullable=False)
    name = Column(String, nullable=False)
    base_url = Column(Text, nullable=True)
    credential_ciphertext = Column(Text, nullable=False)
    credential_hint = Column(String, nullable=True)
    credential_fingerprint = Column(String, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    status = Column(String, nullable=False, default="unverified")
    last_error = Column(Text, nullable=True)
    last_tested_at = Column(DateTime(timezone=True), nullable=True)
    default_teacher_model = Column(String, nullable=True)
    budget = Column(JSONB, nullable=False, default=dict)
    capabilities = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_ai_provider_connections_owner", "owner_id"),
    )


class AiTeacherModel(Base):
    """A teacher model offered by a provider connection (discovered or manual)."""
    __tablename__ = "ai_teacher_models"

    id = Column(String, primary_key=True, default=lambda: "tm_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    provider_id = Column(String, ForeignKey("ai_provider_connections.id", ondelete="CASCADE"), nullable=False)
    model_id = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    context_window = Column(BigInteger, nullable=True)
    max_output_tokens = Column(BigInteger, nullable=True)
    capabilities = Column(JSONB, nullable=False, default=dict)
    input_price_per_million = Column(Float, nullable=True)
    output_price_per_million = Column(Float, nullable=True)
    price_source = Column(String, nullable=True)
    price_updated_at = Column(DateTime(timezone=True), nullable=True)
    discovered = Column(Boolean, nullable=False, default=False)
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_ai_teacher_models_owner", "owner_id"),
        Index("ix_ai_teacher_models_provider_id", "provider_id"),
    )


class AiProviderRequest(Base):
    """One outbound teacher request: usage, cost estimate, latency, outcome."""
    __tablename__ = "ai_provider_requests"

    # Raw SQL inserts rely on the database default; the column is a real uuid in
    # both the migration and the test schema.
    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    provider_id = Column(String, ForeignKey("ai_provider_connections.id", ondelete="CASCADE"), nullable=False)
    job_id = Column(String, nullable=True)
    model_id = Column(String, nullable=True)
    status = Column(String, nullable=False)
    http_status = Column(BigInteger, nullable=True)
    input_tokens = Column(BigInteger, nullable=True)
    output_tokens = Column(BigInteger, nullable=True)
    cached_tokens = Column(BigInteger, nullable=True)
    estimated_cost = Column(Float, nullable=True)
    latency_ms = Column(BigInteger, nullable=True)
    error_code = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_ai_provider_requests_owner_created", "owner_id", "created_at"),
        Index("ix_ai_provider_requests_provider_id", "provider_id"),
        Index("ix_ai_provider_requests_job_id", "job_id"),
    )


class DistillationJob(Base):
    """A teacher-generation / validation run owned by one account."""
    __tablename__ = "distillation_jobs"

    id = Column(String, primary_key=True, default=lambda: "dist_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    dataset_id = Column(String, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True)
    source_dataset_name = Column(String, nullable=True)
    status = Column(String, nullable=False, default="draft")
    mode = Column(String, nullable=False, default="single")
    teacher_config = Column(JSONB, nullable=False, default=dict)
    generation_config = Column(JSONB, nullable=False, default=dict)
    quality_config = Column(JSONB, nullable=False, default=dict)
    budget = Column(JSONB, nullable=False, default=dict)
    progress = Column(JSONB, nullable=False, default=dict)
    student_dataset_id = Column(String, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_distillation_jobs_owner_id", "owner_id"),
        Index("ix_distillation_jobs_status", "status"),
    )


class DistillationRecord(Base):
    """One generated training example with provenance and validation results."""
    __tablename__ = "distillation_records"

    id = Column(String, primary_key=True, default=lambda: "rec_" + uuid.uuid4().hex[:12])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    job_id = Column(String, ForeignKey("distillation_jobs.id", ondelete="CASCADE"), nullable=False)
    instruction = Column(Text, nullable=True)
    input = Column(Text, nullable=True)
    target = Column(Text, nullable=True)
    chosen = Column(Text, nullable=True)
    rejected = Column(Text, nullable=True)
    task_type = Column(String, nullable=True)
    difficulty = Column(String, nullable=True)
    language = Column(String, nullable=True)
    subject = Column(String, nullable=True)
    output_format = Column(String, nullable=True)
    provenance = Column(JSONB, nullable=False, default=dict)
    validation = Column(JSONB, nullable=False, default=dict)
    quality_score = Column(Float, nullable=True)
    content_hash = Column(String, nullable=True)
    simhash = Column(BigInteger, nullable=True)
    status = Column(String, nullable=False, default="pending")
    reviewed_by_human = Column(Boolean, nullable=False, default=False)
    review_note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_distillation_records_job_id", "job_id"),
        Index("ix_distillation_records_owner_id", "owner_id"),
        Index("ix_distillation_records_status", "status"),
    )


class DistillationEvaluation(Base):
    """An evaluator teacher's verdict about one generated record."""
    __tablename__ = "distillation_evaluations"

    id = Column(String, primary_key=True, default=lambda: "dev_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    job_id = Column(String, ForeignKey("distillation_jobs.id", ondelete="CASCADE"), nullable=False)
    record_id = Column(String, ForeignKey("distillation_records.id", ondelete="CASCADE"), nullable=False)
    evaluator_provider_id = Column(String, nullable=True)
    evaluator_model_id = Column(String, nullable=True)
    scores = Column(JSONB, nullable=False, default=dict)
    verdict = Column(String, nullable=True)
    rationale = Column(Text, nullable=True)
    usage = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_distillation_evaluations_record_id", "record_id"),
        Index("ix_distillation_evaluations_job_id", "job_id"),
    )


class StudentTrainingConfig(Base):
    """Inspected base architecture + training method for a student model."""
    __tablename__ = "student_training_configs"

    id = Column(String, primary_key=True, default=lambda: "stu_" + uuid.uuid4().hex[:10])
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    # No ORM-level FK: models can be deleted independently and Supabase already
    # carries the constraint with ON DELETE SET NULL.
    model_id = Column(String, nullable=True)
    base_source = Column(String, nullable=False)
    base_ref = Column(Text, nullable=True)
    architecture = Column(JSONB, nullable=False, default=dict)
    method = Column(String, nullable=False, default="sft")
    method_config = Column(JSONB, nullable=False, default=dict)
    training_config = Column(JSONB, nullable=False, default=dict)
    capability = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_student_training_configs_owner_id", "owner_id"),
    )


class TrainingRuntimeSnapshot(Base):
    """One hardware sample captured while a job was running."""
    __tablename__ = "training_runtime_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    job_id = Column(String, ForeignKey("training_jobs.id", ondelete="CASCADE"), nullable=False)
    captured_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    stage = Column(String, nullable=True)
    step = Column(BigInteger, nullable=True)
    device = Column(String, nullable=True)
    cpu_count = Column(BigInteger, nullable=True)
    cpu_model = Column(Text, nullable=True)
    cpu_utilization = Column(Float, nullable=True)
    ram_used_mb = Column(BigInteger, nullable=True)
    ram_total_mb = Column(BigInteger, nullable=True)
    gpu_name = Column(Text, nullable=True)
    gpu_memory_used_mb = Column(BigInteger, nullable=True)
    gpu_memory_total_mb = Column(BigInteger, nullable=True)
    gpu_utilization = Column(Float, nullable=True)
    cpu_temperature_c = Column(Float, nullable=True)
    battery_percent = Column(Float, nullable=True)
    worker_count = Column(BigInteger, nullable=True)
    detail = Column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        Index("ix_training_runtime_snapshots_job_id", "job_id"),
    )


class TrainingDatasetAnalytics(Base):
    """Dataset statistics (and the split) used by one training job."""
    __tablename__ = "training_dataset_analytics"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    owner_id = Column(UUID(as_uuid=True), nullable=False)
    job_id = Column(String, ForeignKey("training_jobs.id", ondelete="CASCADE"), nullable=False)
    dataset_id = Column(String, nullable=True)
    records = Column(BigInteger, nullable=True)
    accepted_records = Column(BigInteger, nullable=True)
    rejected_records = Column(BigInteger, nullable=True)
    duplicate_records = Column(BigInteger, nullable=True)
    tokens = Column(BigInteger, nullable=True)
    train_tokens = Column(BigInteger, nullable=True)
    validation_tokens = Column(BigInteger, nullable=True)
    test_tokens = Column(BigInteger, nullable=True)
    avg_tokens_per_sample = Column(Float, nullable=True)
    max_sample_length = Column(BigInteger, nullable=True)
    min_sample_length = Column(BigInteger, nullable=True)
    language_distribution = Column(JSONB, nullable=False, default=dict)
    subject_distribution = Column(JSONB, nullable=False, default=dict)
    source_distribution = Column(JSONB, nullable=False, default=dict)
    cleaning_status = Column(String, nullable=True)
    tokenization_status = Column(String, nullable=True)
    checksum = Column(String, nullable=True)
    split = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_training_dataset_analytics_job_id", "job_id"),
    )
