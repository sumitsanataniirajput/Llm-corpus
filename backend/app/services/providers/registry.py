"""Provider type registry: the only place that maps a type to an adapter."""
from __future__ import annotations

from typing import Dict, List, Optional

from app.services.providers.anthropic import AnthropicAdapter
from app.services.providers.base import ProviderAdapter, ProviderError, ProviderType
from app.services.providers.gemini import GeminiAdapter
from app.services.providers.openai_compatible import (
    CustomOpenAIAdapter,
    DeepSeekAdapter,
    FireworksAdapter,
    GroqAdapter,
    OpenAICompatibleAdapter,
    OpenRouterAdapter,
    TogetherAdapter,
)

#: Static descriptors only — no model IDs and no prices anywhere in this table.
PROVIDER_TYPES: Dict[str, ProviderType] = {
    "openai": ProviderType(
        key="openai", label="OpenAI", family="openai_compatible",
        default_base_url="https://api.openai.com/v1",
        docs_url="https://platform.openai.com/docs/api-reference",
        auth_note="Bearer API key from platform.openai.com",
    ),
    "gemini": ProviderType(
        key="gemini", label="Google Gemini", family="gemini",
        default_base_url="https://generativelanguage.googleapis.com/v1beta",
        docs_url="https://ai.google.dev/api",
        auth_note="Google AI Studio API key, sent as x-goog-api-key",
    ),
    "anthropic": ProviderType(
        key="anthropic", label="Anthropic Claude", family="anthropic",
        default_base_url="https://api.anthropic.com/v1",
        docs_url="https://docs.anthropic.com/en/api",
        auth_note="Anthropic API key, sent as x-api-key with anthropic-version",
    ),
    "openrouter": ProviderType(
        key="openrouter", label="OpenRouter", family="openai_compatible",
        default_base_url="https://openrouter.ai/api/v1",
        docs_url="https://openrouter.ai/docs",
        auth_note="OpenRouter key; models from many vendors behind one endpoint",
    ),
    "groq": ProviderType(
        key="groq", label="Groq", family="openai_compatible",
        default_base_url="https://api.groq.com/openai/v1",
        docs_url="https://console.groq.com/docs",
        auth_note="Groq API key",
    ),
    "together": ProviderType(
        key="together", label="Together AI", family="openai_compatible",
        default_base_url="https://api.together.xyz/v1",
        docs_url="https://docs.together.ai",
        auth_note="Together API key",
    ),
    "deepseek": ProviderType(
        key="deepseek", label="DeepSeek", family="openai_compatible",
        default_base_url="https://api.deepseek.com/v1",
        docs_url="https://api-docs.deepseek.com",
        auth_note="DeepSeek API key",
    ),
    "fireworks": ProviderType(
        key="fireworks", label="Fireworks AI", family="openai_compatible",
        default_base_url="https://api.fireworks.ai/inference/v1",
        docs_url="https://docs.fireworks.ai",
        auth_note="Fireworks API key",
    ),
    "custom": ProviderType(
        key="custom", label="Custom OpenAI-compatible endpoint", family="openai_compatible",
        default_base_url=None, requires_base_url=True,
        docs_url="", auth_note="Bearer key for your own compatible server (vLLM, LM Studio, proxy, ...)",
    ),
}

_ADAPTERS = {
    "openai": OpenAICompatibleAdapter,
    "gemini": GeminiAdapter,
    "anthropic": AnthropicAdapter,
    "openrouter": OpenRouterAdapter,
    "groq": GroqAdapter,
    "together": TogetherAdapter,
    "deepseek": DeepSeekAdapter,
    "fireworks": FireworksAdapter,
    "custom": CustomOpenAIAdapter,
}


def normalize_provider_type(value: Optional[str]) -> str:
    text = (value or "").strip().lower()
    aliases = {
        "google": "gemini",
        "google_gemini": "gemini",
        "claude": "anthropic",
        "openai-compatible": "custom",
        "openai_compatible": "custom",
        "custom-openai": "custom",
        "together_ai": "together",
        "together.ai": "together",
        "fireworks_ai": "fireworks",
        "deep_seek": "deepseek",
    }
    return aliases.get(text, text)


def build_adapter(provider_type: str, api_key: str, base_url: Optional[str] = None,
                  *, timeout: float = 60.0, transport=None) -> ProviderAdapter:
    key = normalize_provider_type(provider_type)
    adapter_cls = _ADAPTERS.get(key)
    if adapter_cls is None:
        raise ProviderError(
            f"Unknown provider type '{provider_type}'. Supported: {', '.join(sorted(_ADAPTERS))}.",
            code="unknown_provider",
        )
    descriptor = PROVIDER_TYPES[key]
    if descriptor.requires_base_url and not base_url:
        raise ProviderError("This provider requires a custom endpoint URL.", code="missing_base_url")
    return adapter_cls(api_key, base_url=base_url or descriptor.default_base_url,
                       timeout=timeout, transport=transport)


def describe_provider_types() -> List[Dict[str, object]]:
    return [
        {
            "key": item.key,
            "label": item.label,
            "family": item.family,
            "default_base_url": item.default_base_url,
            "requires_base_url": item.requires_base_url,
            "supports_model_discovery": item.supports_model_discovery,
            "docs_url": item.docs_url,
            "auth_note": item.auth_note,
        }
        for item in sorted(PROVIDER_TYPES.values(), key=lambda entry: entry.label)
    ]
