"""CORPUS ULTIMATE — real checkpoint-backed inference.

The old inference endpoints returned hard-coded ``[untrained]`` text and an
input-derived character tokenizer. This service loads the exact PyTorch state
dict and tokenizer produced by ``app.services.training_worker``, then computes
logits from the real ``CorpusTransformerPT``. No external model API is called.

Storage downloads and every forward pass run in a worker thread so a generation
request cannot block the FastAPI event loop. A small bounded LRU keeps the last
few decoded checkpoints in memory; cache entries are keyed by their private
storage paths and never by a user-supplied path.
"""
from __future__ import annotations

import asyncio
import io
import json
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import torch

from app.config import settings
from corpus_engine.pytorch_engine.pytorch_model import CorpusTransformerPT
from corpus_engine.tokenizer.tokenizer import CorpusTokenizer

try:  # Supabase SDK is optional at import time so the API can boot without it.
    from supabase import create_client
except Exception:  # pragma: no cover - exercised only when SDK is absent
    create_client = None


class InferenceUnavailable(Exception):
    """Raised when this account's model has no usable trained checkpoint."""


@dataclass
class InferenceBundle:
    key: str
    model: CorpusTransformerPT
    tokenizer: CorpusTokenizer
    config: Dict[str, Any]
    meta: Dict[str, Any] = field(default_factory=dict)


_CACHE_LIMIT = 4
_CACHE: "OrderedDict[str, InferenceBundle]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_INFERENCE_LOCK = asyncio.Lock()


def clear_cache() -> None:
    """Drop decoded checkpoints (tests and model deletion can call this)."""
    with _CACHE_LOCK:
        _CACHE.clear()


def _cache_get(key: str) -> Optional[InferenceBundle]:
    with _CACHE_LOCK:
        bundle = _CACHE.get(key)
        if bundle:
            _CACHE.move_to_end(key)
        return bundle


def _cache_put(key: str, bundle: InferenceBundle) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = bundle
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)


def _storage_client():
    if create_client is None:
        raise InferenceUnavailable("Supabase Storage SDK is not installed on the backend.")
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise InferenceUnavailable("Private checkpoint storage is not configured on the backend.")
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


def _config_dict(model_config: Any) -> Dict[str, Any]:
    if isinstance(model_config, dict):
        return dict(model_config)
    if isinstance(model_config, str):
        try:
            parsed = json.loads(model_config)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _paths(model_config: Dict[str, Any]) -> tuple[str, str]:
    checkpoint_path = model_config.get("checkpoint_path")
    tokenizer_path = model_config.get("tokenizer_path")
    if not checkpoint_path or not tokenizer_path:
        raise InferenceUnavailable(
            "This model has no trained checkpoint yet. Train it first; tokenization and next-token logits require the saved tokenizer and weights."
        )
    return str(checkpoint_path), str(tokenizer_path)


def _download(client, path: str) -> bytes:
    try:
        data = client.storage.from_(settings.STORAGE_BUCKET).download(path)
    except FileNotFoundError as exc:
        raise InferenceUnavailable(f"Saved model object is missing: {path}") from exc
    except Exception as exc:
        raise InferenceUnavailable(f"Could not read saved model object: {str(exc)[:180]}") from exc
    if isinstance(data, bytes):
        return data
    if isinstance(data, bytearray):
        return bytes(data)
    raise InferenceUnavailable(f"Saved model object at {path} did not return bytes.")


def _torch_load(data: bytes):
    """Load only tensor/primitive checkpoint data — never an arbitrary pickle.

    The private checkpoint is written by our own worker, but service-role
    Storage is still untrusted input. Older PyTorch versions without
    ``weights_only`` are refused instead of silently falling back to unpickling.
    """
    buffer = io.BytesIO(data)
    try:
        return torch.load(buffer, map_location="cpu", weights_only=True)
    except Exception as exc:
        raise InferenceUnavailable(
            f"Saved checkpoint could not be read safely: {str(exc)[:180]}"
        ) from exc


def _tokenizer_from_checkpoint(checkpoint: dict, tokenizer_json: bytes) -> CorpusTokenizer:
    tokenizer_data: Dict[str, Any] = {}
    if tokenizer_json:
        try:
            raw = json.loads(tokenizer_json.decode("utf-8") if isinstance(tokenizer_json, bytes) else tokenizer_json)
            if isinstance(raw, dict):
                tokenizer_data = raw
        except Exception:
            tokenizer_data = {}
    raw_vocab = checkpoint.get("tokenizer") or tokenizer_data.get("token_to_id") or {}
    raw_special = checkpoint.get("special_tokens") or tokenizer_data.get("special_tokens") or {}
    if not isinstance(raw_vocab, dict) or not raw_vocab:
        raise InferenceUnavailable("The checkpoint does not contain a trained tokenizer vocabulary.")
    try:
        token_to_id = {str(token): int(token_id) for token, token_id in raw_vocab.items()}
        special_tokens = {str(token): int(token_id) for token, token_id in raw_special.items()}
    except (TypeError, ValueError) as exc:
        raise InferenceUnavailable("The checkpoint tokenizer is malformed.") from exc
    if "<bos>" not in special_tokens:
        special_tokens["<bos>"] = 0
    if "<eos>" not in special_tokens:
        special_tokens["<eos>"] = 3
    vocab_size = max(token_to_id.values(), default=0) + 1
    tokenizer = CorpusTokenizer(vocab_size=vocab_size, special_tokens=special_tokens)
    tokenizer.token_to_id = token_to_id
    tokenizer.id_to_token = {token_id: token for token, token_id in token_to_id.items()}
    tokenizer._trained = True
    return tokenizer


def _build_bundle(key: str, checkpoint_bytes: bytes, tokenizer_bytes: bytes,
                  checkpoint_path: str, tokenizer_path: str) -> InferenceBundle:
    checkpoint = _torch_load(checkpoint_bytes)
    if not isinstance(checkpoint, dict) or "model_state" not in checkpoint or "config" not in checkpoint:
        raise InferenceUnavailable("The saved checkpoint is not a CORPUS PyTorch checkpoint.")
    cfg = dict(checkpoint["config"])
    required = ("vocab_size", "context_length", "d_model", "n_layers", "n_heads", "d_ff")
    if any(key not in cfg for key in required):
        raise InferenceUnavailable("The checkpoint does not record a complete model architecture.")
    tokenizer = _tokenizer_from_checkpoint(checkpoint, tokenizer_bytes)
    if max(tokenizer.token_to_id.values(), default=0) >= int(cfg["vocab_size"]):
        raise InferenceUnavailable("The tokenizer vocabulary does not fit the checkpoint's model.")
    try:
        model = CorpusTransformerPT(cfg)
        model.load_state_dict(checkpoint["model_state"], strict=True)
        model.eval()
    except Exception as exc:
        raise InferenceUnavailable(f"Could not restore the trained model weights: {str(exc)[:180]}") from exc
    return InferenceBundle(
        key=key,
        model=model,
        tokenizer=tokenizer,
        config=cfg,
        meta={
            "checkpoint_path": checkpoint_path,
            "tokenizer_path": tokenizer_path,
            "epoch": checkpoint.get("epoch"),
            "global_step": checkpoint.get("global_step"),
            "vocab_size": int(cfg["vocab_size"]),
            "context_length": int(cfg["context_length"]),
            "engine": "pytorch",
        },
    )


async def load_bundle(model_config: Any, storage_client=None) -> InferenceBundle:
    """Return a decoded checkpoint bundle, downloading it at most once per path."""
    cfg = _config_dict(model_config)
    checkpoint_path, tokenizer_path = _paths(cfg)
    key = checkpoint_path + "\0" + tokenizer_path
    cached = _cache_get(key)
    if cached:
        return cached
    client = storage_client or _storage_client()
    checkpoint_bytes, tokenizer_bytes = await asyncio.gather(
        asyncio.to_thread(_download, client, checkpoint_path),
        asyncio.to_thread(_download, client, tokenizer_path),
    )
    bundle = await asyncio.to_thread(
        _build_bundle, key, checkpoint_bytes, tokenizer_bytes,
        checkpoint_path, tokenizer_path,
    )
    _cache_put(key, bundle)
    return bundle


def _clamp(value: Any, low: float, high: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(low, min(high, number))


def sampling_params(payload: Dict[str, Any]) -> Dict[str, Any]:
    temperature = _clamp(payload.get("temperature", 0.8), 0.0, 2.0, 0.8)
    top_k = int(_clamp(payload.get("top_k", 50), 0, 2048, 50))
    top_p = _clamp(payload.get("top_p", 0.9), 0.0, 1.0, 0.9)
    max_tokens = int(_clamp(payload.get("max_tokens", 100), 1, 128, 100))
    seed = payload.get("seed")
    try:
        seed = int(seed) if seed is not None else None
    except (TypeError, ValueError):
        seed = None
    return {
        "temperature": temperature,
        "top_k": top_k,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "seed": seed,
    }


def encode_prompt(bundle: InferenceBundle, text: str) -> List[int]:
    ids = bundle.tokenizer.encode(text or "", add_special=False)
    if not ids:
        ids = [int(bundle.tokenizer.special_tokens.get("<bos>", 0))]
    context_length = max(1, int(bundle.config["context_length"]))
    ids = [int(token_id) for token_id in ids[-context_length:]]
    if any(token_id < 0 or token_id >= int(bundle.config["vocab_size"]) for token_id in ids):
        raise InferenceUnavailable("The prompt contains a token id outside the checkpoint vocabulary.")
    return ids


def _sample_next(bundle: InferenceBundle, raw_logits: torch.Tensor, params: Dict[str, Any]):
    raw = raw_logits.detach().cpu().float()
    vocab = raw.numel()
    work = raw.clone()
    temperature = float(params["temperature"])
    top_k = int(params["top_k"])
    top_p = float(params["top_p"])
    seed = params.get("seed")
    if seed is not None and temperature > 0:
        torch.manual_seed(int(seed))

    if temperature > 0:
        work = work / max(temperature, 1e-3)
        if top_k > 0 and top_k < vocab:
            kth = torch.topk(work, top_k).values[-1]
            work = torch.where(work < kth, torch.tensor(float("-inf")), work)
        if 0 < top_p < 1:
            sorted_logits, sorted_indices = torch.sort(work, descending=True)
            sorted_probs = torch.softmax(sorted_logits, dim=-1)
            cumulative = torch.cumsum(sorted_probs, dim=-1)
            remove = cumulative > top_p
            if bool(remove.any()):
                # Always keep the first token that crossed the nucleus boundary.
                remove[1:] = remove[:-1].clone()
                work[sorted_indices[remove]] = float("-inf")
        if not bool(torch.isfinite(work).any()):
            work = raw.clone()
        probs = torch.softmax(work, dim=-1)
        total = float(probs.sum().item())
        if total > 0 and math.isfinite(total):
            next_id = int(torch.multinomial(probs, 1).item())
        else:
            next_id = int(torch.argmax(raw).item())
            probs = torch.softmax(raw, dim=-1)
    else:
        next_id = int(torch.argmax(raw).item())
        probs = torch.softmax(raw, dim=-1)

    count = min(max(1, top_k or 10), vocab)
    top_probs, top_ids = torch.topk(probs, count)
    eos_id = int(bundle.tokenizer.special_tokens.get("<eos>", 3))
    predictions = []
    for rank, (prob, token_id) in enumerate(zip(top_probs.tolist(), top_ids.tolist()), start=1):
        token_id = int(token_id)
        predictions.append({
            "rank": rank,
            "id": token_id,
            "token": bundle.tokenizer.id_to_token.get(token_id, "<unk>"),
            "text": bundle.tokenizer.id_to_token.get(token_id, ""),
            "probability": float(prob),
            "logit": float(raw[token_id].item()),
        })
    token = bundle.tokenizer.id_to_token.get(next_id, "<unk>")
    done = next_id == eos_id
    return next_id, token, done, predictions


def _next_event(bundle: InferenceBundle, context: List[int], params: Dict[str, Any], index: int) -> Dict[str, Any]:
    with torch.no_grad():
        input_ids = torch.tensor([context], dtype=torch.long)
        logits = bundle.model(input_ids)[0, -1]
    next_id, token, done, predictions = _sample_next(bundle, logits, params)
    special = set(bundle.tokenizer.special_tokens.values())
    piece = "" if done or next_id in special else token
    return {
        "index": index,
        "token_id": next_id,
        "token": token,
        "text": piece,
        "done": done,
        "predictions": predictions,
    }


async def stream_generation(bundle: InferenceBundle, prompt: str,
                            payload: Dict[str, Any]) -> AsyncIterator[Dict[str, Any]]:
    """Yield one real model step at a time, never a canned response."""
    params = sampling_params(payload)
    context = encode_prompt(bundle, prompt)
    eos_id = int(bundle.tokenizer.special_tokens.get("<eos>", 3))
    async with _INFERENCE_LOCK:
        for index in range(params["max_tokens"]):
            event = await asyncio.to_thread(_next_event, bundle, context, params, index)
            yield event
            if event["done"]:
                break
            context = (context + [int(event["token_id"])])[-int(bundle.config["context_length"]):]
            if int(event["token_id"]) == eos_id:
                break


async def generate(bundle: InferenceBundle, prompt: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    pieces: List[str] = []
    token_ids: List[int] = []
    async for event in stream_generation(bundle, prompt, payload):
        if event["done"]:
            break
        pieces.append(event["text"])
        token_ids.append(int(event["token_id"]))
    return {
        "response": "".join(pieces),
        "tokens_generated": len(token_ids),
        "token_ids": token_ids,
        "prompt_token_ids": encode_prompt(bundle, prompt),
        "checkpoint": bundle.meta,
    }


async def tokenize(bundle: InferenceBundle, text: str) -> Dict[str, Any]:
    ids = encode_prompt(bundle, text)
    return {
        "ids": ids,
        "tokens": [
            {"token": bundle.tokenizer.id_to_token.get(token_id, "<unk>"), "id": token_id}
            for token_id in ids
        ],
        "vocab_size": int(bundle.config["vocab_size"]),
        "checkpoint": bundle.meta,
    }


async def next_token_distribution(bundle: InferenceBundle, text: str,
                                  payload: Dict[str, Any]) -> Dict[str, Any]:
    params = sampling_params({**payload, "max_tokens": 1})
    context = encode_prompt(bundle, text)
    async with _INFERENCE_LOCK:
        event = await asyncio.to_thread(_next_event, bundle, context, params, 0)
    return {
        "predictions": event["predictions"],
        "tokenization": [
            {"token": bundle.tokenizer.id_to_token.get(token_id, "<unk>"), "id": token_id}
            for token_id in context
        ],
        "checkpoint": bundle.meta,
    }


__all__ = [
    "InferenceUnavailable", "InferenceBundle", "clear_cache", "load_bundle",
    "generate", "tokenize", "next_token_distribution", "stream_generation",
    "encode_prompt", "sampling_params",
]
