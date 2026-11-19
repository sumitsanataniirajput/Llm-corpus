"""P2 / Phase 2 — real checkpoint loading, tokenization, logits and generation.

These tests build a tiny deterministic PyTorch checkpoint in the exact format
written by ``app.services.training_worker`` (state dict + config + tokenizer),
store it in the fake private bucket, then exercise the real endpoints. No
external model API and no hard-coded ``[untrained]`` reply is involved.
"""
import io
import json
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import settings
from app.core import websocket_auth
from app.core.database import dispose_engine, get_session_factory
from app.main import app as fastapi_app
from app.services import inference_service, training_worker
from corpus_engine.pytorch_engine.pytorch_model import CorpusTransformerPT
from corpus_engine.tokenizer.tokenizer import CorpusTokenizer
from tests.conftest import USER_ID


class _UnsafePicklePayload:
    """A custom class that ``weights_only=True`` must refuse to unpickle."""


@pytest.fixture(autouse=True)
def _clear_inference_cache():
    inference_service.clear_cache()
    yield
    inference_service.clear_cache()


def _checkpoint_bytes():
    torch.manual_seed(17)
    cfg = {
        "vocab_size": 8,
        "context_length": 8,
        "d_model": 16,
        "n_layers": 1,
        "n_heads": 2,
        "d_ff": 32,
        "dropout": 0.0,
        "learning_rate": 0.001,
        "epochs": 1,
    }
    special = {"<pad>": 0, "<unk>": 1, "<bos>": 2, "<eos>": 3}
    token_to_id = {**special, "a": 4, "b": 5, "c": 6, "d": 7}
    tokenizer = CorpusTokenizer(vocab_size=8, special_tokens=special)
    tokenizer.token_to_id = token_to_id
    tokenizer.id_to_token = {value: key for key, value in token_to_id.items()}
    tokenizer._trained = True

    model = CorpusTransformerPT(cfg)
    with torch.no_grad():
        # Make greedy decoding deterministic without pretending this is a
        # language model: the saved weights always select token id 4 ("a").
        model.output_projection.weight.zero_()
        model.output_projection.bias.fill_(-100.0)
        model.output_projection.bias[4] = 100.0
    checkpoint = {
        "model_state": model.state_dict(),
        "config": cfg,
        "epoch": 1,
        "global_step": 3,
        "tokenizer": token_to_id,
        "special_tokens": special,
    }
    buffer = io.BytesIO()
    torch.save(checkpoint, buffer)
    tokenizer_json = json.dumps({
        "vocab_size": 8,
        "special_tokens": special,
        "token_to_id": token_to_id,
    }).encode("utf-8")
    return cfg, buffer.getvalue(), tokenizer_json


async def _seed_trained_model(http, storage, monkeypatch):
    model = (await http.post("/api/v1/models/", json={
        "name": "Checkpoint model", "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()
    cfg, checkpoint_bytes, tokenizer_json = _checkpoint_bytes()
    checkpoint_path = f"checkpoints/{USER_ID}/{model['id']}/model.pt"
    tokenizer_path = f"tokenizers/{USER_ID}/{model['id']}/tokenizer.json"
    storage.put(settings.STORAGE_BUCKET, checkpoint_path, checkpoint_bytes)
    storage.put(settings.STORAGE_BUCKET, tokenizer_path, tokenizer_json)
    monkeypatch.setattr(inference_service, "create_client", lambda url, key: storage)

    config = {**cfg, "checkpoint_path": checkpoint_path, "tokenizer_path": tokenizer_path}
    factory = get_session_factory()
    async with factory() as db:
        await db.execute(text(
            "UPDATE public.models SET status = 'trained', config = CAST(:config AS jsonb) WHERE id = :id"
        ), {"config": json.dumps(config), "id": model["id"]})
        await db.commit()
    return model, checkpoint_path, tokenizer_path


@pytest.mark.asyncio
async def test_generate_uses_real_checkpoint_and_is_owner_scoped(http, http_as_other, storage, monkeypatch):
    model, checkpoint_path, tokenizer_path = await _seed_trained_model(http, storage, monkeypatch)

    resp = await http.post(f"/api/v1/inference/{model['id']}", json={
        "text": "a", "temperature": 0, "top_k": 5, "top_p": 1, "max_tokens": 4,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "available"
    assert body["response"] == "aaaa"
    assert body["tokens_generated"] == 4
    assert body["token_ids"] == [4, 4, 4, 4]
    assert body["prompt_token_ids"] == [4]
    assert body["checkpoint"]["checkpoint_path"] == checkpoint_path
    assert body["checkpoint"]["engine"] == "pytorch"
    assert body["checkpoint"]["global_step"] == 3
    downloaded = {entry["path"] for entry in storage.downloads}
    assert checkpoint_path in downloaded
    assert tokenizer_path in downloaded

    foreign = await http_as_other.post(f"/api/v1/inference/{model['id']}", json={"text": "a"})
    assert foreign.status_code == 404, foreign.text


@pytest.mark.asyncio
async def test_tokenize_and_next_token_use_the_trained_tokenizer_and_real_logits(http, storage, monkeypatch):
    model, _, _ = await _seed_trained_model(http, storage, monkeypatch)

    tokenized = await http.post(f"/api/v1/inference/tokenize/{model['id']}", json={"text": "ab"})
    assert tokenized.status_code == 200, tokenized.text
    tokens = tokenized.json()
    assert tokens["status"] == "available"
    assert tokens["ids"] == [4, 5]
    assert [item["token"] for item in tokens["tokens"]] == ["a", "b"]
    assert tokens["vocab_size"] == 8

    predicted = await http.post(f"/api/v1/inference/predict/{model['id']}", json={
        "text": "ab", "temperature": 0, "top_k": 3, "top_p": 1, "max_tokens": 1,
    })
    assert predicted.status_code == 200, predicted.text
    distribution = predicted.json()
    assert distribution["status"] == "available"
    assert distribution["predictions"][0]["id"] == 4
    assert distribution["predictions"][0]["token"] == "a"
    assert distribution["predictions"][0]["probability"] > 0.99
    assert distribution["predictions"][0]["logit"] > 99
    assert [item["id"] for item in distribution["tokenization"]] == [4, 5]


@pytest.mark.asyncio
async def test_untrained_model_reports_unavailable_without_fabricating_a_reply(http):
    model = (await http.post("/api/v1/models/", json={
        "name": "Untrained model", "vocab_size": 128, "context_length": 16,
        "d_model": 32, "n_layers": 1, "n_heads": 4, "d_ff": 64, "dropout": 0.1,
    })).json()

    generated = await http.post(f"/api/v1/inference/{model['id']}", json={"text": "hello"})
    assert generated.status_code == 200, generated.text
    assert generated.json()["status"] == "unavailable"
    assert generated.json()["response"] == ""
    assert "not trained" in generated.json()["message"]

    tokenized = await http.post(f"/api/v1/inference/tokenize/{model['id']}", json={"text": "hello"})
    assert tokenized.json()["status"] == "unavailable"
    assert tokenized.json()["tokens"] == []

    predicted = await http.post(f"/api/v1/inference/predict/{model['id']}", json={"text": "hello"})
    assert predicted.json()["status"] == "unavailable"
    assert predicted.json()["predictions"] == []


@pytest.mark.asyncio
async def test_inference_socket_streams_real_tokens_after_first_frame_auth(http, storage, monkeypatch):
    model, _, _ = await _seed_trained_model(http, storage, monkeypatch)

    async def _verify(token):
        return {"id": USER_ID, "email": "socket@example.com"} if token == "valid-token" else None

    monkeypatch.setattr(websocket_auth, "verify_supabase_token", _verify)
    await dispose_engine()  # TestClient creates a new event loop

    with TestClient(fastapi_app) as client:
        with client.websocket_connect(f"/api/v1/inference/{model['id']}/ws") as ws:
            ws.send_json({"type": "auth", "token": "valid-token"})
            ws.send_text(json.dumps({
                "text": "a", "temperature": 0, "top_k": 5, "top_p": 1, "max_tokens": 3,
            }))
            start = ws.receive_json()
            assert start["event"] == "start"
            assert start["status"] == "available"
            received = []
            while True:
                msg = ws.receive_json()
                received.append(msg)
                if msg["event"] == "complete":
                    break
    token_frames = [msg for msg in received if msg["event"] == "token"]
    assert len(token_frames) == 3
    assert [msg["token"] for msg in token_frames] == ["a", "a", "a"]
    assert received[-1]["response"] == "aaa"
    assert received[-1]["tokens_generated"] == 3


@pytest.mark.asyncio
async def test_worker_generated_checkpoint_round_trips_into_real_inference(storage):
    """The exact bytes saved by the real trainer must load and produce logits."""
    text = "corpus ultimate checkpoint round trip. " * 40
    cfg, metrics, checkpoint_bytes, tokenizer_json, token_count = training_worker._train_sync(
        text,
        {"vocab_size": 128, "context_length": 8, "d_model": 16, "n_layers": 1,
         "n_heads": 2, "d_ff": 32, "dropout": 0.0},
        {"epochs": 1, "batch_size": 2, "gradient_accumulation_steps": 1,
         "learning_rate": 0.001},
    )
    assert metrics and token_count > cfg["context_length"]
    checkpoint_path = f"checkpoints/{USER_ID}/worker-round-trip/model.pt"
    tokenizer_path = f"tokenizers/{USER_ID}/worker-round-trip/tokenizer.json"
    storage.put(settings.STORAGE_BUCKET, checkpoint_path, checkpoint_bytes)
    storage.put(settings.STORAGE_BUCKET, tokenizer_path, tokenizer_json)

    bundle = await inference_service.load_bundle({
        "checkpoint_path": checkpoint_path,
        "tokenizer_path": tokenizer_path,
    }, storage_client=storage)
    assert bundle.meta["engine"] == "pytorch"
    assert bundle.config["vocab_size"] == cfg["vocab_size"]
    assert bundle.tokenizer.get_vocab_size() <= bundle.config["vocab_size"]

    result = await inference_service.next_token_distribution(
        bundle, text[:24], {"temperature": 0, "top_k": 3, "top_p": 1}
    )
    assert result["tokenization"], "worker tokenizer must encode the training text"
    assert result["predictions"], "restored worker weights must produce real logits"
    assert 0 <= result["predictions"][0]["probability"] <= 1
    assert result["checkpoint"]["checkpoint_path"] == checkpoint_path


@pytest.mark.asyncio
async def test_unsafe_checkpoint_pickle_is_reported_unavailable(http, storage, monkeypatch):
    model, checkpoint_path, _ = await _seed_trained_model(http, storage, monkeypatch)
    unsafe = io.BytesIO()
    torch.save({
        "model_state": {},
        "config": {},
        "payload": _UnsafePicklePayload(),
    }, unsafe)
    storage.put(settings.STORAGE_BUCKET, checkpoint_path, unsafe.getvalue())
    inference_service.clear_cache()

    resp = await http.post(f"/api/v1/inference/{model['id']}", json={"text": "a"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "unavailable"
    assert resp.json()["response"] == ""
    assert "read safely" in resp.json()["message"]


def test_checkpoint_loader_has_no_unsafe_pickle_fallback():
    service_source = (
        Path(__file__).resolve().parents[1] / "app" / "services" / "inference_service.py"
    ).read_text()
    assert "torch.load(buffer, map_location=\"cpu\", weights_only=True)" in service_source
    assert "torch.load(buffer, map_location=\"cpu\")" not in service_source
    assert "weights_only" in service_source


def test_frontend_api_uses_the_mounted_prediction_lab_routes():
    api_source = (
        Path(__file__).resolve().parents[1].parent / "frontend" / "js" / "api.js"
    ).read_text()
    assert "/api/v1/inference/tokenize/" in api_source
    assert "/api/v1/inference/predict/" in api_source
    assert "/api/v1/tokenize/" not in api_source
    assert "/api/v1/predict/" not in api_source
    assert "/api/v1/inference/' + encodeURIComponent(modelId) + '/ws" in api_source
