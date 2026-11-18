"""Knowledge Distillation — parsing, quality gates, budgets and a real run.

The end-to-end test drives two OpenAI-compatible teacher "providers" through
``httpx.MockTransport`` (no network), asserts provenance/usage rows, then reviews,
exports and converts the records. Nothing here stubs the distillation pipeline
itself: the runner, the SQL writes and the exporter are the production code.
"""
import json
import uuid

import httpx
import pytest
from sqlalchemy import text

from app.core.database import get_session_factory
from app.services import distillation as distill
from app.services.providers import Usage
from app.services.distillation_export import format_records
from tests.conftest import OTHER_USER_ID, USER_ID


# ------------------------------------------------------------------ unit level

def test_parse_instruction_pair():
    candidate = distill.parse_response(
        "instruction",
        "Instruction: Explain photosynthesis.\nResponse: Plants convert light into chemical energy.",
    )
    assert candidate.parse_error is None
    assert candidate.instruction == "Explain photosynthesis."
    assert candidate.target.startswith("Plants convert")


def test_parse_qa_and_preference_and_classification():
    qa = distill.parse_response("qa", "Question: What is 2+2?\nAnswer: 4")
    assert qa.instruction == "What is 2+2?" and qa.target == "4"

    pref = distill.parse_response("preference", json.dumps({
        "prompt": "Why is the sky blue?", "chosen": "Rayleigh scattering.",
        "rejected": "Because it is.",
    }))
    assert pref.chosen == "Rayleigh scattering." and pref.rejected == "Because it is."

    clf = distill.parse_response("classification", '{"label": "science", "confidence": 0.9, "reason": "x"}')
    assert json.loads(clf.target)["label"] == "science"

    broken = distill.parse_response("instruction", "I'm sorry, but I can't help with that.")
    assert broken.parse_error is not None


def test_validation_rejects_short_refusal_and_duplicate():
    cfg = dict(distill.DEFAULT_QUALITY)
    short = distill.parse_response("instruction", "Instruction: Q?\nResponse: Yes.")
    result = distill.validate_candidate(short, task_type="instruction", language="en",
                                       config=cfg, seen_hashes={})
    assert result.status == "rejected"
    assert "too short" in result.reasons[0]

    refusal = distill.parse_response(
        "instruction", "Instruction: Explain X.\nResponse: I'm sorry, I cannot help with that at all, sorry.")
    refused = distill.validate_candidate(refusal, task_type="instruction", language="en",
                                         config=cfg, seen_hashes={})
    assert refused.status == "rejected"

    good = distill.parse_response(
        "instruction",
        "Instruction: Explain gravity.\nResponse: " + "Gravity attracts masses with a force proportional to both." * 2)
    first = distill.validate_candidate(good, task_type="instruction", language="en",
                                       config=cfg, seen_hashes={})
    assert first.status == "accepted" and first.score > 0
    seen = {distill.content_hash(good.as_dict()): "rec_1"}
    duplicate = distill.validate_candidate(good, task_type="instruction", language="en",
                                           config=cfg, seen_hashes=seen)
    assert duplicate.status == "duplicate"


def test_language_gate_catches_wrong_script():
    cfg = dict(distill.DEFAULT_QUALITY)
    english = distill.parse_response(
        "instruction",
        "Instruction: Explain gravity.\nResponse: " + "Gravity pulls objects toward each other every day." * 2)
    result = distill.validate_candidate(english, task_type="instruction", language="hi",
                                       config=cfg, seen_hashes={})
    assert result.status == "rejected"
    assert "language" in result.reasons[0].lower()


def test_budget_state_stops_on_limits():
    state = distill.BudgetState(limits={"max_requests": 2, "max_tokens": 1000,
                                        "max_spend_usd": 0.0, "max_concurrency": 2})
    assert state.exhausted() is None
    state.requests = 2
    assert "request" in state.exhausted().lower()
    assert state.as_dict()["limits"]["max_requests"] == 2


def test_cost_is_none_without_prices():
    usage = Usage(input_tokens=1000, output_tokens=500)

    class Teacher:
        input_price_per_million = None
        output_price_per_million = None

    assert distill.compute_cost(usage, Teacher()) is None

    class Priced:
        input_price_per_million = 2.0
        output_price_per_million = 4.0

    assert distill.compute_cost(usage, Priced()) == pytest.approx(0.004)


def test_export_conversion_splits_are_deterministic_and_skip_incomplete():
    records = [
        {"id": "rec_a", "status": "accepted", "instruction": "Q1", "target": "A1", "language": "en"},
        {"id": "rec_b", "status": "accepted", "instruction": "Q2", "target": "", "language": "en"},
        {"id": "rec_c", "status": "rejected", "instruction": "Q3", "target": "A3", "language": "en"},
    ]
    first = format_records(records, "chat_jsonl")
    second = format_records(records, "chat_jsonl")
    assert first["counts"] == second["counts"]
    assert first["counts"]["total"] == 1
    assert first["counts"]["skipped"] == 1
    assert first["examples"]["train"][0]["messages"][0]["content"] == "Q1"
    # Rejected rows never appear anywhere in the payload.
    assert "Q3" not in json.dumps(first["examples"])


# --------------------------------------------------------------- HTTP helpers

class FakeTeachers:
    """Two OpenAI-compatible endpoints that answer deterministically."""

    def __init__(self):
        self.calls = {"a.example": 0, "b.example": 0}
        self.models = {"a.example": ["teacher-a-large"], "b.example": ["teacher-b-large"]}

    def handler(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [
                {"id": model_id, "context_length": 32000} for model_id in self.models[host]
            ]})
        if "fine_tuning" in request.url.path:
            return httpx.Response(404, json={"error": {"message": "not available"}})
        if request.url.path.endswith("/chat/completions"):
            body = json.loads(request.content)
            prompt = body["messages"][-1]["content"]
            if "strict JSON only" in prompt and "accuracy" in prompt:
                return httpx.Response(200, json=self._completion(
                    body["model"], json.dumps({
                        "accuracy": 0.9, "relevance": 0.8, "completeness": 0.85,
                        "instruction_following": 0.95, "verdict": "accept",
                        "rationale": "Correct and complete.",
                    }), host))
            self.calls[host] += 1
            index = self.calls[host]
            answer = (
                f"Instruction: Explain concept {index} from the source material.\n"
                f"Response: Concept {index} works by moving energy between two systems, and the "
                f"source text shows exactly how that transfer happens in practice."
            )
            return httpx.Response(200, json=self._completion(body["model"], answer, host))
        return httpx.Response(404, json={"error": {"message": "unknown path"}})

    def _completion(self, model_id, answer, host):
        return {
            "id": f"cmpl-{host}-{uuid.uuid4().hex[:6]}",
            "model": model_id,
            "choices": [{"message": {"content": answer}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 60},
        }


async def _make_provider(http, name, base_url, api_key, price=(2.0, 4.0)):
    created = await http.post("/api/v1/teachers/providers", json={
        "provider_type": "custom",
        "name": name,
        "api_key": api_key,
        "base_url": base_url,
        "test_on_save": False,
    })
    assert created.status_code == 201, created.text
    provider = created.json()
    model = await http.post(f"/api/v1/teachers/providers/{provider['id']}/models", json={
        "model_id": "teacher-a-large" if "a.example" in base_url else "teacher-b-large",
        "input_price_per_million": price[0],
        "output_price_per_million": price[1],
    })
    assert model.status_code == 201, model.text
    await http.patch(f"/api/v1/teachers/providers/{provider['id']}",
                     json={"default_teacher_model": model.json()["model_id"]})
    return provider, model.json()


async def _make_dataset(http):
    dataset = (await http.post("/api/v1/datasets/", json={"name": "Distillation source", "format": "txt"})).json()
    upload = await http.post(
        f"/api/v1/datasets/{dataset['id']}/upload",
        files={"file": ("source.txt", b"Photosynthesis converts light energy into chemical energy.\n" * 40,
                        "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    return upload.json()["dataset"]


def _job_payload(dataset_id, provider, model, **overrides):
    payload = {
        "dataset_id": dataset_id,
        "mode": "single",
        "teachers": [{"provider_id": provider["id"], "model_id": model["model_id"]}],
        "generation": {
            "count": 2, "languages": ["en"], "subjects": ["science"],
            "difficulties": ["beginner"], "task_types": ["instruction"],
        },
        "allow_external_send": True,
    }
    payload.update(overrides)
    return payload


# --------------------------------------------------------------- HTTP surface

async def test_job_creation_requires_consent_and_valid_teachers(http, http_as_other):
    dataset = await _make_dataset(http)
    provider_a, model_a = await _make_provider(http, "Teacher A", "https://a.example/v1", "sk-teacher-a-0001")

    no_consent = await http.post("/api/v1/distillation/jobs",
                                 json=_job_payload(dataset["id"], provider_a, model_a,
                                                   allow_external_send=False))
    assert no_consent.status_code == 400
    assert "allow_external_send" in no_consent.json()["detail"]

    foreign = await http_as_other.post("/api/v1/distillation/jobs",
                                       json=_job_payload(dataset["id"], provider_a, model_a))
    assert foreign.status_code == 404  # provider not visible to the other account

    unknown_task = await http.post("/api/v1/distillation/jobs",
                                   json=_job_payload(dataset["id"], provider_a, model_a,
                                                     generation={"count": 1, "task_types": ["telepathy"]}))
    assert unknown_task.status_code == 400

    mode_b_single = await http.post("/api/v1/distillation/jobs",
                                    json=_job_payload(dataset["id"], provider_a, model_a, mode="multi"))
    assert mode_b_single.status_code == 400
    assert "two teacher providers" in mode_b_single.json()["detail"]

    evaluator_mode = await http.post("/api/v1/distillation/jobs",
                                     json=_job_payload(dataset["id"], provider_a, model_a, mode="evaluator"))
    assert evaluator_mode.status_code == 400
    assert "evaluator" in evaluator_mode.json()["detail"]

    created = await http.post("/api/v1/distillation/jobs", json=_job_payload(dataset["id"], provider_a, model_a))
    assert created.status_code == 201, created.text
    job = created.json()
    assert job["status"] == "draft"
    assert job["generation_config"]["consent"]["allow_external_send"] is True
    assert job["generation_config"]["source_chars"] > 0
    assert job["quality_config"]["min_quality_score"] == 0.6

    preview = await http.get("/api/v1/distillation/source-preview", params={
        "dataset_id": dataset["id"], "task_type": "instruction",
    })
    assert preview.status_code == 200
    body = preview.json()
    assert "Photosynthesis" in body["prompt"]
    assert body["source"]["characters_available_to_teachers"] > 0


async def test_dry_run_discovers_models_and_tests_connection(http, monkeypatch):
    from app.api.endpoints import teachers as teachers_endpoints
    from app.services.providers import build_adapter as real_build

    fake = FakeTeachers()
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(
        teachers_endpoints, "build_adapter",
        lambda provider_type, api_key, base_url=None: real_build(provider_type, api_key, base_url,
                                                                 transport=transport),
    )
    created = await http.post("/api/v1/teachers/providers", json={
        "provider_type": "custom", "name": "Discovered", "api_key": "sk-discover-0001",
        "base_url": "https://a.example/v1", "test_on_save": True,
    })
    assert created.status_code == 201, created.text
    provider = created.json()
    assert provider["status"] == "connected"
    assert provider["capabilities"]["teacher_inference"] is True
    # fine-tuning endpoint answered 404 -> not available, never "supported"
    # A custom OpenAI-compatible endpoint is never *assumed* to allow fine-tuning.
    assert provider["capabilities"]["provider_managed_finetuning"] is None
    assert "not assumed" in provider["capabilities"]["provider_managed_finetuning_evidence"]

    discovery = await http.post(f"/api/v1/teachers/providers/{provider['id']}/discover")
    assert discovery.status_code == 200, discovery.text
    body = discovery.json()
    assert body["created"] == 1
    assert body["models"][0]["model_id"] == "teacher-a-large"
    assert body["models"][0]["context_window"] == 32000
    # No price was returned by the provider, so none is invented.
    assert body["models"][0]["input_price_per_million"] is None


async def test_manual_model_add_and_usage_endpoint(http):
    provider, model = await _make_provider(http, "Manual", "https://a.example/v1", "sk-manual-0001")
    assert model["price_source"] == "owner"
    usage = await http.get("/api/v1/teachers/usage")
    assert usage.status_code == 200
    assert usage.json()["providers"][0]["requests"] == 0
    assert "unpriced" in usage.json()["pricing_note"]


# --------------------------------------------------------- end-to-end pipeline

async def test_end_to_end_run_review_export_convert(http, http_as_other):
    dataset = await _make_dataset(http)
    provider_a, model_a = await _make_provider(http, "Teacher A", "https://a.example/v1", "sk-teacher-a-0001")
    provider_b, model_b = await _make_provider(http, "Teacher B", "https://b.example/v1", "sk-teacher-b-0001")

    job = (await http.post("/api/v1/distillation/jobs", json={
        "dataset_id": dataset["id"],
        "mode": "evaluator",
        "teachers": [{"provider_id": provider_a["id"], "model_id": model_a["model_id"]}],
        "evaluators": [{"provider_id": provider_b["id"], "model_id": model_b["model_id"]}],
        "generation": {"count": 2, "languages": ["en"], "subjects": ["science"],
                       "difficulties": ["beginner"], "task_types": ["instruction"]},
        "allow_external_send": True,
        "budget": {"max_requests": 20, "max_tokens": 100000, "max_spend_usd": 1.0,
                   "max_concurrency": 2},
    })).json()

    fake = FakeTeachers()
    report = await distill.run_distillation_job(
        job["id"], USER_ID, transport=httpx.MockTransport(fake.handler)
    )
    assert report["stats"]["generated"] == 2
    assert report["stats"]["evaluated"] >= 1
    assert report["budget"]["spend_usd"] > 0  # prices were entered by the owner

    detail = (await http.get(f"/api/v1/distillation/jobs/{job['id']}")).json()
    assert detail["status"] == "review"
    assert detail["counts"]["total"] == 2

    records = (await http.get(f"/api/v1/distillation/jobs/{job['id']}/records")).json()
    assert records["total"] == 2
    first = records["records"][0]
    assert first["provenance"]["provider_name"] in {"Teacher A", "Teacher B"}
    assert first["provenance"]["request_id"].startswith("cmpl-")
    assert first["provenance"]["usage"]["input_tokens"] == 120
    assert first["validation"]["checks"]["format_parse"]["ok"] is True
    assert first["quality_score"] > 0

    # Provenance and usage rows are real database rows, not computed on the fly.
    async with get_session_factory()() as db:
        requests = (await db.execute(text("""
            SELECT status, input_tokens, output_tokens, estimated_cost, latency_ms
            FROM public.ai_provider_requests WHERE job_id = :job_id
        """), {"job_id": job["id"]})).mappings().all()
    assert requests and all(row["input_tokens"] == 120 for row in requests)
    assert all(row["estimated_cost"] is not None for row in requests)

    summary = (await http.get(f"/api/v1/distillation/jobs/{job['id']}/summary")).json()
    assert summary["counts"]["total"] == 2
    assert summary["usage"]["requests"] == len(requests)
    assert summary["usage"]["total_tokens"] == 120 * len(requests) + 60 * len(requests)
    assert summary["teacher_contribution"][0]["provider_name"] in {"Teacher A", "Teacher B"}
    assert summary["quality"]["avg_score"] is not None

    # Human review: approve everything, then export only what was approved.
    ids = [row["id"] for row in records["records"]]
    bulk = await http.post(f"/api/v1/distillation/jobs/{job['id']}/records/bulk",
                           json={"record_ids": ids, "action": "accept"})
    assert bulk.json()["affected"] == 2

    exported = await http.get(f"/api/v1/distillation/jobs/{job['id']}/export",
                              params={"format": "chat_jsonl"})
    assert exported.status_code == 200
    lines = [json.loads(line) for line in exported.text.strip().splitlines()]
    assert len(lines) == 2
    assert lines[0]["messages"][-1]["role"] == "assistant"
    assert all(line["split"] in {"train", "validation", "test"} for line in lines)

    alpaca = await http.get(f"/api/v1/distillation/jobs/{job['id']}/export", params={"format": "alpaca"})
    assert "instruction" in json.loads(alpaca.text.splitlines()[0])

    conversion = await http.post(f"/api/v1/distillation/jobs/{job['id']}/convert", json={
        "output_format": "chat_jsonl", "train": 0.8, "validation": 0.1, "test": 0.1,
        "name_prefix": "science-distill",
    })
    assert conversion.status_code == 200, conversion.text
    created = conversion.json()["created"]
    assert sum(item["records"] for item in created) == 2
    assert all(item["dataset_id"] for item in created)

    datasets = (await http.get("/api/v1/datasets/")).json()
    names = [item["name"] for item in datasets if item["id"] != dataset["id"]]
    assert any("science-distill" in name for name in names)

    # Another account sees nothing of this job.
    assert (await http_as_other.get(f"/api/v1/distillation/jobs/{job['id']}")).status_code == 404
    assert (await http_as_other.get(f"/api/v1/distillation/jobs/{job['id']}/records")).status_code == 404
    assert (await http_as_other.delete(f"/api/v1/distillation/jobs/{job['id']}")).status_code == 404


async def test_budget_cap_stops_generation(http):
    dataset = await _make_dataset(http)
    provider_a, model_a = await _make_provider(http, "Teacher A", "https://a.example/v1", "sk-teacher-a-0001")

    job = (await http.post("/api/v1/distillation/jobs", json={
        "dataset_id": dataset["id"],
        "mode": "single",
        "teachers": [{"provider_id": provider_a["id"], "model_id": model_a["model_id"]}],
        "generation": {"count": 4, "task_types": ["instruction"]},
        "allow_external_send": True,
        "budget": {"max_requests": 1, "max_tokens": 10000, "max_spend_usd": 0.5,
                   "max_concurrency": 1},
    })).json()

    fake = FakeTeachers()
    report = await distill.run_distillation_job(
        job["id"], USER_ID, transport=httpx.MockTransport(fake.handler)
    )
    assert report["stats"]["generated"] == 1
    assert report["budget"]["requests"] == 1
    stop_reason = report["budget"].get("stop_reason") or ""
    assert "request" in stop_reason.lower()

    rows = (await http.get(f"/api/v1/distillation/jobs/{job['id']}/records")).json()
    assert rows["total"] == 1


async def test_provider_failure_is_recorded_not_swallowed(http):
    dataset = await _make_dataset(http)
    provider_a, model_a = await _make_provider(http, "Broken", "https://a.example/v1", "sk-teacher-a-0001")
    job = (await http.post("/api/v1/distillation/jobs", json=_job_payload(
        dataset["id"], provider_a, model_a,
        generation={"count": 1, "task_types": ["instruction"]},
    ))).json()

    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "upstream exploded"}})

    report = await distill.run_distillation_job(job["id"], USER_ID, transport=httpx.MockTransport(failing))
    assert report["stats"]["generated"] == 0
    assert report["stats"]["failed_calls"] >= 1

    async with get_session_factory()() as db:
        statuses = [row[0] for row in (await db.execute(text(
            "SELECT status FROM public.ai_provider_requests WHERE job_id = :job_id"
        ), {"job_id": job["id"]})).all()]
    assert statuses and set(statuses) == {"error"}

    detail = (await http.get(f"/api/v1/distillation/jobs/{job['id']}")).json()
    assert detail["status"] == "review"
    assert detail["counts"]["total"] == 0
