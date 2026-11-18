"""Student Model Studio and Training Intelligence.

The point of these tests is the honesty rules: a method is offered only when the
libraries and hardware really allow it, an architecture is reported from the
instantiated model, and every value the dashboard cannot read is null rather than
a plausible-looking constant.
"""
import json
import uuid

import pytest
from sqlalchemy import text

from app.core.database import get_session_factory
from app.services import student_studio as studio
from app.services import training_worker
from tests.conftest import OTHER_USER_ID, USER_ID


async def _create_model(http, name="Studio model", overrides=None):
    payload = {
        "name": name, "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    }
    payload.update(overrides or {})
    resp = await http.post("/api/v1/models/", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _create_dataset(http, content=b"studio training text\n" * 60):
    dataset = (await http.post("/api/v1/datasets/", json={"name": "Studio corpus", "format": "txt"})).json()
    upload = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("studio.txt", content, "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    return upload.json()["dataset"]


# ---------------------------------------------------------------- system facts

async def test_system_capabilities_reflect_the_real_environment(http):
    body = (await http.get("/api/v1/students/system")).json()
    libraries = body["libraries"]
    assert libraries["peft"] == "0.7.1"
    assert libraries["bitsandbytes"] is None  # genuinely not installed here
    assert libraries["cuda_available"] is False

    hf = body["availability"]["huggingface"]
    corpus = body["availability"]["corpus"]
    assert hf["sft"]["available"] is True
    assert hf["lora"]["available"] is True
    assert hf["qlora"]["available"] is False
    assert any("bitsandbytes" in reason for reason in hf["qlora"]["reasons"])
    assert corpus["lora"]["available"] is False
    assert "custom transformer" in corpus["lora"]["reasons"][0]
    assert corpus["dpo"]["available"] is False


async def test_inspect_corpus_model_uses_the_loaded_architecture(http):
    model = await _create_model(http)
    resp = await http.post("/api/v1/students/inspect",
                           json={"base_source": "corpus", "model_id": model["id"]})
    assert resp.status_code == 200, resp.text
    inspection = resp.json()
    architecture = inspection["architecture"]

    # The reported parameter count is the instantiated model's own count.
    from corpus_engine.pytorch_engine.pytorch_model import CorpusTransformerPT
    reference = CorpusTransformerPT({
        "vocab_size": 128, "context_length": 16, "d_model": 32,
        "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })
    assert architecture["total_parameters"] == reference.parameter_count()
    assert architecture["layers"] == 1
    assert architecture["attention_heads"] == 4
    assert architecture["context_window"] == 16
    assert architecture["weight_size_bytes"] == architecture["total_parameters"] * 4
    assert inspection["compatibility"]["hf_weights_loadable"] is False
    assert set(architecture["parameter_breakdown"]) and architecture["parameter_breakdown"]


async def test_inspect_rejects_foreign_models(http, http_as_other):
    model = await _create_model(http)
    resp = await http_as_other.post("/api/v1/students/inspect",
                                    json={"base_source": "corpus", "model_id": model["id"]})
    assert resp.status_code == 404


async def test_hf_inspection_failure_is_reported_not_guessed(http, monkeypatch):
    def boom(repo_id, *, load_weights=False, token=None):
        raise studio.InspectError("Hugging Face could not load a config for 'nope/nope'.")

    monkeypatch.setattr(studio, "inspect_hf_model", boom)
    resp = await http.post("/api/v1/students/inspect",
                           json={"base_source": "huggingface", "base_ref": "nope/nope"})
    assert resp.status_code == 502
    assert "could not load a config" in resp.json()["detail"]


# ------------------------------------------------------- method gating + config

async def test_lora_is_refused_for_the_corpus_engine(http):
    model = await _create_model(http)
    resp = await http.post("/api/v1/students/configs", json={
        "base_source": "corpus", "model_id": model["id"], "method": "lora",
        "method_config": {"lora_r": 8, "target_modules": ["q_proj"]},
    })
    assert resp.status_code == 409
    assert "custom transformer" in resp.json()["detail"]


async def test_sft_config_is_saved_with_its_capability_snapshot(http):
    model = await _create_model(http)
    resp = await http.post("/api/v1/students/configs", json={
        "base_source": "corpus", "model_id": model["id"], "method": "sft",
        "training_config": {"learning_rate": 0.001, "epochs": 1, "batch_size": 1},
    })
    assert resp.status_code == 201, resp.text
    config = resp.json()
    assert config["method"] == "sft"
    assert config["architecture"]["total_parameters"] > 0
    assert config["capability"]["availability"]["available"] is True
    assert config["capability"]["libraries"]["bitsandbytes"] is None
    listed = (await http.get("/api/v1/students/configs")).json()["configs"]
    assert [item["id"] for item in listed] == [config["id"]]


async def test_lora_plan_reports_an_estimate_with_its_formula(http):
    resp = await http.post("/api/v1/students/lora-plan", json={
        "architecture": {"hidden_dim": 64, "intermediate_dim": 128, "layers": 2,
                         "attention_heads": 4, "kv_heads": 4},
        "lora_r": 8, "target_modules": ["q_proj", "v_proj"],
    })
    assert resp.status_code == 200
    plan = resp.json()
    assert plan["estimated_adapter_parameters"] == 8 * 2 * (64 + 64) * 2
    assert "Estimate" in plan["note"]


async def test_student_models_lists_corpus_models_with_checkpoints(http):
    model = await _create_model(http, name="Checkpointed")
    dataset = await _create_dataset(http)
    async with get_session_factory()() as db:
        # checkpoints reference a real training job, so create one first.
        await db.execute(text("""
            INSERT INTO public.training_jobs
            (id, owner_id, model_id, dataset_id, status, engine, compute, config, created_at, updated_at)
            VALUES (:id, :owner_id, :model_id, :dataset_id, 'completed', 'pytorch', 'local',
                    '{}'::jsonb, now(), now())
        """), {"id": "job_ckpt_test", "owner_id": USER_ID, "model_id": model["id"],
               "dataset_id": dataset["id"]})
        await db.execute(text("""
            INSERT INTO public.checkpoints (id, model_id, job_id, storage_path, step, loss)
            VALUES (:id, :model_id, :job_id, :path, :step, :loss)
        """), {"id": "ckpt_test1", "model_id": model["id"], "job_id": "job_ckpt_test",
               "path": "checkpoints/x/model.pt", "step": 12, "loss": 1.5})
        await db.commit()
    body = (await http.get("/api/v1/students/models")).json()
    entry = next(item for item in body["models"] if item["id"] == model["id"])
    assert entry["checkpoints"] == 1
    assert entry["last_step"] == 12
    assert entry["last_loss"] == 1.5


# --------------------------------------------------------- training intelligence

async def _make_job(http, monkeypatch):
    model = await _create_model(http)
    dataset = await _create_dataset(http)
    job_id = "job_" + uuid.uuid4().hex[:10]
    async with get_session_factory()() as db:
        await db.execute(text("""
            INSERT INTO public.training_jobs
            (id, owner_id, model_id, dataset_id, status, engine, compute, config,
             stage, total_steps, completed_steps, total_epochs, current_epoch,
             processed_tokens, progress_updated_at, created_at, updated_at)
            VALUES (:id, :owner_id, :model_id, :dataset_id, 'running', 'pytorch', 'local',
                    CAST(:config AS jsonb), 'training', 10, 0, 2, 1, 0, now(),
                    now(), now())
        """), {
            "id": job_id, "owner_id": USER_ID, "model_id": model["id"],
            "dataset_id": dataset["id"],
            "config": json.dumps({"batch_size": 2, "gradient_accumulation_steps": 4,
                                  "learning_rate": 0.0005, "epochs": 2, "seed": 42,
                                  "gradient_clip": 1.0}),
        })
        await db.commit()
    return job_id, model, dataset


async def test_intelligence_reports_real_values_and_nulls(http):
    job_id, model, dataset = await _make_job(http, None)
    factory = get_session_factory()

    # Exactly what the worker emits: a stage event carrying measured dataset
    # analytics, then genuine optimizer-step metrics.
    await training_worker._persist_training_metric(factory, job_id, {
        "kind": "stage", "stage": "initializing", "total_steps": 10, "total_epochs": 2,
        "completed_steps": 0, "processed_tokens": 0,
        "dataset_analytics": {
            "records": 8, "tokens": 1024, "train_tokens": 1024, "validation_tokens": None,
            "test_tokens": None, "avg_tokens_per_sample": 16.0,
            "max_sample_length": 16, "min_sample_length": 16, "vocab_size": 64,
            "context_length": 16, "stride": 8, "tokenization_status": "tokenized",
            "cleaning_status": "raw extracted text, no filtering applied",
            "split": {"train": 1.0},
        },
    })
    for step, loss in ((1, 3.5), (2, 2.9), (3, 2.4)):
        await training_worker._persist_training_metric(factory, job_id, {
            "step": step, "loss": loss, "learning_rate": 0.0005,
            "tokens_per_second": 120.0, "completed_steps": step, "total_steps": 10,
            "processed_tokens": step * 32, "stage": "training",
        })

    resp = await http.get(f"/api/v1/training/{job_id}/intelligence")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    architecture = body["architecture"]
    assert architecture["total_parameters"] > 0
    assert architecture["layers"] == 1
    assert architecture["compatibility"]["hf_weights_loadable"] is False

    training = body["training"]
    assert training["effective_global_batch"] == 8
    assert training["learning_rate"] == 0.0005
    assert training["seed"] == 42

    dataset_block = body["dataset"]
    assert dataset_block["available"] is True
    assert dataset_block["records"] == 8
    assert dataset_block["tokens"] == 1024
    assert dataset_block["validation_tokens"] is None
    assert dataset_block["language_distribution"] == {"unknown": 8}
    assert any("unknown" in note for note in dataset_block["limitations"])

    metrics = body["metrics"]
    assert metrics["completed_steps"] == 3
    assert metrics["progress_percent"] == 30.0
    assert metrics["train_loss"] == 2.4
    assert metrics["learning_rate"] == 0.0005
    assert metrics["eta_seconds"] is not None
    assert len(metrics["series"]) == 3

    hardware = body["hardware"]
    latest = hardware["latest"]
    assert latest is not None
    assert latest["device"] == "cpu"
    assert latest["gpu_name"] is None
    assert latest["cpu_count"] and latest["cpu_count"] > 0
    assert any("GPU" in note for note in hardware["unavailable"])

    assert [point["step"] for point in body["charts"]["loss"]] == [1, 2, 3]
    assert body["statuses"]["generation"] is None
    assert body["statuses"]["training"] == "running"

    telemetry = (await http.get(f"/api/v1/training/{job_id}/telemetry")).json()
    assert telemetry["count"] >= 1

    # Cross-account isolation.
    from tests.conftest import _make_http_client
    async with _make_http_client(OTHER_USER_ID) as other:
        assert (await other.get(f"/api/v1/training/{job_id}/intelligence")).status_code == 404


async def test_intelligence_says_unavailable_before_analytics_exist(http):
    job_id, _model, _dataset = await _make_job(http, None)
    body = (await http.get(f"/api/v1/training/{job_id}/intelligence")).json()
    assert body["dataset"]["available"] is False
    assert any("not recorded" in note for note in body["dataset"]["limitations"])
    assert body["metrics"]["progress_percent"] == 0.0  # no optimizer step recorded yet
    assert body["metrics"]["eta_seconds"] is None  # no throughput means no honest ETA
    assert body["hardware"]["latest"] is None
