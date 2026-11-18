"""Anthropic Claude adapter.

Authentication: ``x-api-key`` header plus a required ``anthropic-version``.
Discovery: ``GET /v1/models`` (newest first, paginated).
Inference: ``POST /v1/messages`` with system prompts as a top-level field and
``max_tokens`` mandatory.
Usage: ``usage.input_tokens`` / ``output_tokens`` plus cache read/creation counts.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from app.services.providers.base import (
    ChatMessage,
    ChatResult,
    ProviderAdapter,
    ProviderError,
    TeacherModelInfo,
    Usage,
)

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicAdapter(ProviderAdapter):
    family = "anthropic"
    type_key = "anthropic"
    default_base_url = "https://api.anthropic.com/v1"

    def auth_headers(self) -> Dict[str, str]:
        return {"x-api-key": self._api_key, "anthropic-version": ANTHROPIC_VERSION}

    async def list_models(self) -> List[TeacherModelInfo]:
        models: List[TeacherModelInfo] = []
        after_id: Optional[str] = None
        for _ in range(10):  # bounded pagination
            params: Dict[str, Any] = {"limit": 100}
            if after_id:
                params["after_id"] = after_id
            payload = await self._send("GET", "/models", params=params)
            data = payload.get("data")
            if not isinstance(data, list):
                raise ProviderError("Anthropic returned an unexpected model list.",
                                    code="invalid_response")
            for item in data:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                models.append(TeacherModelInfo(
                    model_id=str(item["id"]),
                    display_name=str(item.get("display_name") or item["id"]),
                    context_window=_int(item.get("context_window")),
                    max_output_tokens=_int(item.get("max_output_tokens")),
                    capabilities={"type": item.get("type")} if item.get("type") else {},
                ))
            if not payload.get("has_more") or not payload.get("last_id"):
                break
            after_id = str(payload.get("last_id"))
        if not models:
            raise ProviderError("Anthropic returned an empty model list.", code="empty_model_list")
        return models

    async def chat(self, messages: List[ChatMessage], model: str, *,
                   temperature: float = 0.7, max_tokens: Optional[int] = None,
                   top_p: Optional[float] = None,
                   response_format: Optional[str] = None,
                   stop: Optional[List[str]] = None) -> ChatResult:
        if not model:
            raise ProviderError("A teacher model ID is required.", code="missing_model")
        system_parts = [m.content for m in messages if m.role == "system"]
        conversation = [
            {"role": ("assistant" if m.role == "assistant" else "user"), "content": m.content}
            for m in messages if m.role != "system"
        ]
        if not conversation:
            raise ProviderError("Anthropic needs at least one user message.", code="bad_request")
        body: Dict[str, Any] = {
            "model": model,
            "messages": conversation,
            # Anthropic requires max_tokens; this is the request's own limit, not
            # a claim about the model's maximum.
            "max_tokens": int(max_tokens or 1024),
            "temperature": float(temperature),
        }
        if system_parts:
            body["system"] = "\n\n".join(system_parts)
        if top_p is not None:
            body["top_p"] = float(top_p)
        if stop:
            body["stop_sequences"] = stop

        started = time.monotonic()
        payload = await self._send("POST", "/messages", json_body=body)
        latency_ms = int((time.monotonic() - started) * 1000)

        blocks = payload.get("content")
        text = ""
        if isinstance(blocks, list):
            text = "".join(
                block.get("text", "") for block in blocks
                if isinstance(block, dict) and block.get("type", "text") == "text"
            )
        usage = payload.get("usage") or {}
        cached = None
        if isinstance(usage.get("cache_read_input_tokens"), (int, float)):
            cached = int(usage["cache_read_input_tokens"])
        return ChatResult(
            text=text,
            model_id=str(payload.get("model") or model),
            usage=Usage(
                input_tokens=_int(usage.get("input_tokens")),
                output_tokens=_int(usage.get("output_tokens")),
                cached_tokens=cached,
            ),
            request_id=payload.get("id"),
            latency_ms=latency_ms,
            finish_reason=payload.get("stop_reason"),
            raw_meta={"type": payload.get("type")},
        )

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        return {
            "supported": None,
            "evidence": "Anthropic does not expose a fine-tuning jobs API to this app, so "
                        "provider-managed fine-tuning is not claimed for this connection.",
        }


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
