"""Google Gemini adapter (Generative Language API).

Authentication: ``x-goog-api-key`` header (the key is never placed in a URL, so it
cannot leak through logs or browser history).
Discovery: ``GET /v1beta/models`` — filtered to models that actually support
``generateContent``, using the capability list the API returns.
Inference: ``POST /v1beta/models/{model}:generateContent``.
Usage: ``usageMetadata.promptTokenCount`` / ``candidatesTokenCount``.
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


class GeminiAdapter(ProviderAdapter):
    family = "gemini"
    type_key = "gemini"
    default_base_url = "https://generativelanguage.googleapis.com/v1beta"

    def auth_headers(self) -> Dict[str, str]:
        return {"x-goog-api-key": self._api_key}

    async def list_models(self) -> List[TeacherModelInfo]:
        models: List[TeacherModelInfo] = []
        page_token: Optional[str] = None
        for _ in range(10):
            params: Dict[str, Any] = {"pageSize": 200}
            if page_token:
                params["pageToken"] = page_token
            payload = await self._send("GET", "/models", params=params)
            data = payload.get("models")
            if not isinstance(data, list):
                raise ProviderError("Gemini returned an unexpected model list.",
                                    code="invalid_response")
            for item in data:
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                methods = item.get("supportedGenerationMethods") or []
                if methods and "generateContent" not in methods:
                    continue  # embedding-only models cannot teach
                model_id = str(item["name"]).replace("models/", "", 1)
                models.append(TeacherModelInfo(
                    model_id=model_id,
                    display_name=str(item.get("displayName") or model_id),
                    context_window=int(item["inputTokenLimit"]) if isinstance(item.get("inputTokenLimit"), (int, float)) else None,
                    max_output_tokens=int(item["outputTokenLimit"]) if isinstance(item.get("outputTokenLimit"), (int, float)) else None,
                    capabilities={
                        "supported_generation_methods": methods,
                        "description": item.get("description"),
                    },
                ))
            page_token = payload.get("nextPageToken")
            if not page_token:
                break
        if not models:
            raise ProviderError("Gemini returned no model that supports generateContent.",
                                code="empty_model_list")
        return models

    async def chat(self, messages: List[ChatMessage], model: str, *,
                   temperature: float = 0.7, max_tokens: Optional[int] = None,
                   top_p: Optional[float] = None,
                   response_format: Optional[str] = None,
                   stop: Optional[List[str]] = None) -> ChatResult:
        if not model:
            raise ProviderError("A teacher model ID is required.", code="missing_model")
        system_parts = [m.content for m in messages if m.role == "system"]
        contents = []
        for message in messages:
            if message.role == "system":
                continue
            contents.append({
                "role": "model" if message.role == "assistant" else "user",
                "parts": [{"text": message.content}],
            })
        if not contents:
            raise ProviderError("Gemini needs at least one user message.", code="bad_request")
        generation: Dict[str, Any] = {"temperature": float(temperature)}
        if max_tokens is not None:
            generation["maxOutputTokens"] = int(max_tokens)
        if top_p is not None:
            generation["topP"] = float(top_p)
        if stop:
            generation["stopSequences"] = stop
        if response_format == "json":
            generation["responseMimeType"] = "application/json"
        body: Dict[str, Any] = {"contents": contents, "generationConfig": generation}
        if system_parts:
            body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}

        started = time.monotonic()
        payload = await self._send(
            "POST", f"/models/{model}:generateContent", json_body=body
        )
        latency_ms = int((time.monotonic() - started) * 1000)

        candidates = payload.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            feedback = payload.get("promptFeedback") or {}
            reason = feedback.get("blockReason") or "no candidates returned"
            raise ProviderError(f"Gemini returned no answer ({reason}).", code="empty_response")
        first = candidates[0] or {}
        parts = ((first.get("content") or {}).get("parts")) or []
        text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        usage = payload.get("usageMetadata") or {}
        return ChatResult(
            text=text,
            model_id=model,
            usage=Usage(
                input_tokens=_int(usage.get("promptTokenCount")),
                output_tokens=_int(usage.get("candidatesTokenCount")),
                cached_tokens=_int(usage.get("cachedContentTokenCount")),
            ),
            request_id=payload.get("responseId"),
            latency_ms=latency_ms,
            finish_reason=first.get("finishReason"),
            raw_meta={"safety_ratings": first.get("safetyRatings")},
        )

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        return {
            "supported": None,
            "evidence": "Supervised tuning for Gemini runs through a separate Google Cloud project; "
                        "this API key alone does not establish access, so it is not claimed.",
        }


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
