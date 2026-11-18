"""Shared contracts for provider adapters (no provider-specific logic here)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from app.services.crypto import mask_secret


@dataclass
class ProviderType:
    """Static description of an API family. Never contains a model list."""
    key: str
    label: str
    family: str
    default_base_url: Optional[str]
    requires_base_url: bool = False
    supports_model_discovery: bool = True
    docs_url: str = ""
    auth_note: str = ""


@dataclass
class TeacherModelInfo:
    model_id: str
    display_name: Optional[str] = None
    context_window: Optional[int] = None
    max_output_tokens: Optional[int] = None
    capabilities: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ChatMessage:
    role: str
    content: str


@dataclass
class Usage:
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None

    @property
    def total_tokens(self) -> Optional[int]:
        if self.input_tokens is None and self.output_tokens is None:
            return None
        return int(self.input_tokens or 0) + int(self.output_tokens or 0)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "total_tokens": self.total_tokens,
        }


@dataclass
class ChatResult:
    text: str
    model_id: str
    usage: Usage = field(default_factory=Usage)
    request_id: Optional[str] = None
    latency_ms: int = 0
    finish_reason: Optional[str] = None
    raw_meta: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "model_id": self.model_id,
            "usage": self.usage.as_dict(),
            "request_id": self.request_id,
            "latency_ms": self.latency_ms,
            "finish_reason": self.finish_reason,
        }


class ProviderNotSupported(RuntimeError):
    """The provider does not expose this capability (discovery, fine-tuning, ...)."""


class ProviderError(RuntimeError):
    """A provider call failed. Carries the mapped reason, never the API key."""

    def __init__(self, message: str, *, code: str = "provider_error",
                 http_status: Optional[int] = None, retryable: bool = False,
                 retry_after_seconds: Optional[float] = None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


class ProviderRateLimitError(ProviderError):
    def __init__(self, message: str, *, http_status: int = 429,
                 retry_after_seconds: Optional[float] = None):
        super().__init__(message, code="rate_limited", http_status=http_status,
                         retryable=True, retry_after_seconds=retry_after_seconds)


def _retry_after(response: httpx.Response) -> Optional[float]:
    value = response.headers.get("retry-after")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _error_detail(response: httpx.Response) -> str:
    """Extract a short, secret-free message from an error body."""
    text = ""
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            text = str(err.get("message") or err.get("type") or "")
        elif isinstance(err, str):
            text = err
        if not text:
            text = str(payload.get("message") or payload.get("detail") or "")
    if not text:
        text = (response.text or "").strip()
    return text[:400]


class ProviderAdapter:
    """Base class: one instance per (provider type, key, endpoint)."""

    type_key: str = ""
    family: str = ""

    def __init__(self, api_key: str, base_url: Optional[str] = None,
                 timeout: float = 60.0, transport: Optional[httpx.AsyncBaseTransport] = None):
        if not api_key:
            raise ProviderError("The provider API key is empty.", code="missing_credential")
        self._api_key = api_key
        self.base_url = (base_url or getattr(self, "default_base_url", "") or "").rstrip("/")
        self.timeout = timeout
        self._transport = transport

    # -- transport -------------------------------------------------------
    def _client(self) -> httpx.AsyncClient:
        kwargs: Dict[str, Any] = {"timeout": self.timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    def auth_headers(self) -> Dict[str, str]:
        raise NotImplementedError

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        headers.update(self.auth_headers())
        return headers

    def _safe(self, text: str) -> str:
        return text.replace(self._api_key, mask_secret(self._api_key))

    def _map_error(self, response: httpx.Response) -> ProviderError:
        status = response.status_code
        detail = self._safe(_error_detail(response))
        if status == 401:
            return ProviderError(
                "The provider rejected the API key (401). Check the key and its permissions.",
                code="invalid_credential", http_status=status,
            )
        if status == 403:
            return ProviderError(
                "The provider refused this request (403): the key may lack access to this model or region.",
                code="forbidden", http_status=status,
            )
        if status == 404:
            return ProviderError(
                "The provider answered 404: the endpoint or model ID does not exist." + (f" {detail}" if detail else ""),
                code="not_found", http_status=status,
            )
        if status == 429:
            return ProviderRateLimitError(
                "The provider rate limit was reached (429)." + (f" {detail}" if detail else ""),
                retry_after_seconds=_retry_after(response),
            )
        if status >= 500:
            return ProviderError(
                "The provider returned a server error (" + str(status) + ")." + (f" {detail}" if detail else ""),
                code="provider_unavailable", http_status=status, retryable=True,
            )
        if status == 400:
            return ProviderError(
                "The provider rejected the request (400)." + (f" {detail}" if detail else ""),
                code="bad_request", http_status=status,
            )
        return ProviderError(
            f"The provider returned HTTP {status}." + (f" {detail}" if detail else ""),
            code="provider_error", http_status=status, retryable=status in (408, 409),
        )

    async def _send(self, method: str, path: str, *, json_body: Optional[dict] = None,
                    params: Optional[dict] = None, url: Optional[str] = None) -> Dict[str, Any]:
        target = url or (self.base_url + path)
        started = time.monotonic()
        try:
            async with self._client() as client:
                response = await client.request(
                    method, target, headers=self._headers(), json=json_body, params=params
                )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "The provider did not answer before the timeout.",
                code="timeout", retryable=True,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                "The provider could not be reached: " + self._safe(str(exc)),
                code="network_error", retryable=True,
            ) from exc
        self.last_latency_ms = int((time.monotonic() - started) * 1000)
        if response.status_code >= 400:
            raise self._map_error(response)
        try:
            payload = response.json()
        except Exception as exc:
            raise ProviderError(
                "The provider returned a response that is not JSON.",
                code="invalid_response", http_status=response.status_code,
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderError("The provider returned an unexpected response shape.",
                                code="invalid_response", http_status=response.status_code)
        return payload

    # -- capabilities ----------------------------------------------------
    async def list_models(self) -> List[TeacherModelInfo]:
        raise ProviderNotSupported(f"{self.type_key} does not support model discovery.")

    async def chat(self, messages: List[ChatMessage], model: str, *,
                   temperature: float = 0.7, max_tokens: Optional[int] = None,
                   top_p: Optional[float] = None,
                   response_format: Optional[str] = None,
                   stop: Optional[List[str]] = None) -> ChatResult:
        raise NotImplementedError

    async def probe_fine_tuning(self) -> Dict[str, Any]:
        """Ask the provider whether *this key* can manage fine-tuning jobs.

        Returns ``{"supported": True|False|None, "evidence": str}``. ``None`` means
        the provider gives no way to check, and the UI must not claim support.
        """
        return {"supported": None, "evidence": f"{self.type_key} exposes no fine-tuning endpoint this app can verify"}

    async def test_connection(self) -> Dict[str, Any]:
        """Real request: discovery when supported, otherwise a minimal completion."""
        started = time.monotonic()
        result: Dict[str, Any] = {
            "ok": False, "models": [], "discovery_supported": True, "note": None,
        }
        try:
            models = await self.list_models()
            result["models"] = [
                {
                    "model_id": item.model_id,
                    "display_name": item.display_name,
                    "context_window": item.context_window,
                    "max_output_tokens": item.max_output_tokens,
                    "capabilities": item.capabilities,
                }
                for item in models
            ]
            result["ok"] = True
        except ProviderNotSupported as exc:
            result["discovery_supported"] = False
            result["note"] = str(exc)
        except ProviderError as exc:
            result["error"] = str(exc)
            result["error_code"] = exc.code
            result["ok"] = False
        result["latency_ms"] = int((time.monotonic() - started) * 1000)
        return result

    # -- static capability labels ---------------------------------------
    def capabilities(self, fine_tuning: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "teacher_inference": True,
            "synthetic_data_generation": True,
            # A teacher API key never implies permission to fine-tune the teacher's
            # weights; this is only True when the provider's own endpoint said so.
            "provider_managed_finetuning": (fine_tuning or {}).get("supported"),
            "provider_managed_finetuning_evidence": (fine_tuning or {}).get("evidence"),
            "student_local_training": True,
        }
