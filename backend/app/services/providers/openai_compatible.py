"""OpenAI-compatible adapters.

Covers OpenAI itself plus the providers that expose the same wire format
(OpenRouter, Groq, Together AI, DeepSeek, Fireworks AI and any custom endpoint the
owner points at). Each provider differs only by base URL and by which optional
features it actually implements, and those differences are detected rather than
assumed:

* discovery: ``GET {base}/models``
* inference: ``POST {base}/chat/completions``
* fine-tuning access: ``GET {base}/fine_tuning/jobs?limit=1`` (OpenAI-compatible
  servers that do not implement it answer 404, which is reported as "not
  available", never as support)
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import httpx

from app.services.providers.base import (
    ChatMessage,
    ChatResult,
    ProviderAdapter,
    ProviderError,
    ProviderNotSupported,
    TeacherModelInfo,
    Usage,
)


class OpenAICompatibleAdapter(ProviderAdapter):
    family = "openai_compatible"
    type_key = "openai"
    default_base_url = "https://api.openai.com/v1"
    #: Discovery can be noisy for aggregators; the response is normalised instead
    #: of filtering it, so the owner sees exactly what the provider offers.
    max_models = 3000

    def auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    # -- discovery -------------------------------------------------------
    async def list_models(self) -> List[TeacherModelInfo]:
        payload = await self._send("GET", "/models")
        data = payload.get("data")
        if data is None and isinstance(payload.get("models"), list):
            data = payload["models"]
        if not isinstance(data, list):
            raise ProviderError(
                "The provider's model list is not in the expected format.",
                code="invalid_response",
            )
        models: List[TeacherModelInfo] = []
        for item in data[: self.max_models]:
            if isinstance(item, str):
                models.append(TeacherModelInfo(model_id=item, display_name=item))
                continue
            if not isinstance(item, dict):
                continue
            model_id = item.get("id") or item.get("name") or item.get("model")
            if not model_id:
                continue
            context = item.get("context_length") or item.get("context_window") or item.get("max_context_length")
            capabilities: Dict[str, Any] = {}
            # Only report what the provider actually returned.
            modalities = item.get("architecture", {}).get("input_modalities") if isinstance(item.get("architecture"), dict) else None
            if modalities:
                capabilities["input_modalities"] = modalities
            if isinstance(item.get("supports_vision"), bool):
                capabilities["vision"] = item["supports_vision"]
            if item.get("owned_by"):
                capabilities["owned_by"] = item["owned_by"]
            models.append(TeacherModelInfo(
                model_id=str(model_id),
                display_name=str(item.get("name") or model_id),
                context_window=int(context) if isinstance(context, (int, float)) else None,
                max_output_tokens=int(item["max_output_tokens"]) if isinstance(item.get("max_output_tokens"), (int, float)) else None,
                capabilities=capabilities,
            ))
        if not models:
            raise ProviderError("The provider returned an empty model list.", code="empty_model_list")
        return models

    # -- inference -------------------------------------------------------
    async def chat(self, messages: List[ChatMessage], model: str, *,
                   temperature: float = 0.7, max_tokens: Optional[int] = None,
                   top_p: Optional[float] = None,
                   response_format: Optional[str] = None,
                   stop: Optional[List[str]] = None) -> ChatResult:
        if not model:
            raise ProviderError("A teacher model ID is required.", code="missing_model")
        body: Dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": float(temperature),
        }
        if max_tokens is not None:
            body["max_tokens"] = int(max_tokens)
        if top_p is not None:
            body["top_p"] = float(top_p)
        if stop:
            body["stop"] = stop
        if response_format == "json":
            body["response_format"] = {"type": "json_object"}

        started = time.monotonic()
        payload = await self._send("POST", "/chat/completions", json_body=body)
        latency_ms = int((time.monotonic() - started) * 1000)

        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ProviderError("The provider returned no completion choices.", code="empty_response")
        first = choices[0] or {}
        message = first.get("message") or {}
        text = message.get("content")
        if isinstance(text, list):
            # Some compatible servers return content parts.
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        if not isinstance(text, str):
            text = ""
        usage_payload = payload.get("usage") or {}
        cached = None
        details = usage_payload.get("prompt_tokens_details")
        if isinstance(details, dict) and isinstance(details.get("cached_tokens"), (int, float)):
            cached = int(details["cached_tokens"])
        return ChatResult(
            text=text,
            model_id=str(payload.get("model") or model),
            usage=Usage(
                input_tokens=_int_or_none(usage_payload.get("prompt_tokens")),
                output_tokens=_int_or_none(usage_payload.get("completion_tokens")),
                cached_tokens=cached,
            ),
            request_id=payload.get("id"),
            latency_ms=latency_ms,
            finish_reason=first.get("finish_reason"),
            raw_meta={"system_fingerprint": payload.get("system_fingerprint")},
        )

    # -- fine-tuning access probe ---------------------------------------
    async def probe_fine_tuning(self) -> Dict[str, Any]:
        try:
            await self._send("GET", "/fine_tuning/jobs", params={"limit": 1})
        except ProviderError as exc:
            if exc.code in {"not_found", "invalid_response"}:
                return {"supported": False,
                        "evidence": "The provider does not expose a fine-tuning jobs endpoint."}
            if exc.code in {"invalid_credential", "forbidden"}:
                return {"supported": False,
                        "evidence": "The provider refused fine-tuning access for this key ("
                                    + exc.code + ")."}
            if exc.code == "bad_request":
                return {"supported": False,
                        "evidence": "The provider rejected the fine-tuning probe; access is not verified."}
            return {"supported": None, "evidence": "Fine-tuning access could not be verified: " + exc.code}
        return {
            "supported": True,
            "evidence": "GET /fine_tuning/jobs answered successfully, so provider-managed fine-tuning "
                        "is available to this key (model eligibility and regional rules still apply).",
        }


class OpenRouterAdapter(OpenAICompatibleAdapter):
    type_key = "openrouter"
    default_base_url = "https://openrouter.ai/api/v1"

    def auth_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "HTTP-Referer": "https://corpus-ultimate-web.onrender.com",
            "X-Title": "CORPUS ULTIMATE",
        }

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        return {"supported": None,
                "evidence": "OpenRouter is an inference router; hosted fine-tuning is not offered by this API."}


class GroqAdapter(OpenAICompatibleAdapter):
    type_key = "groq"
    default_base_url = "https://api.groq.com/openai/v1"

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        return await super().probe_fine_tuning()


class TogetherAdapter(OpenAICompatibleAdapter):
    type_key = "together"
    default_base_url = "https://api.together.xyz/v1"


class DeepSeekAdapter(OpenAICompatibleAdapter):
    type_key = "deepseek"
    default_base_url = "https://api.deepseek.com/v1"


class FireworksAdapter(OpenAICompatibleAdapter):
    type_key = "fireworks"
    default_base_url = "https://api.fireworks.ai/inference/v1"


class CustomOpenAIAdapter(OpenAICompatibleAdapter):
    """Any OpenAI-compatible endpoint the owner provides."""

    type_key = "custom"
    default_base_url = ""

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        if not base_url:
            raise ProviderError(
                "A custom OpenAI-compatible provider needs an endpoint URL.",
                code="missing_base_url",
            )
        super().__init__(api_key, base_url=base_url, **kwargs)

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        return {"supported": None,
                "evidence": "A custom endpoint does not advertise fine-tuning capability; it is not assumed."}


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
