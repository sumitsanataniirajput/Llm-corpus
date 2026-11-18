"""Provider adapters against real HTTP semantics, with a mock transport.

Each adapter owns its own authentication, discovery, request body and response
parsing. These tests pin those wire contracts and the error mapping, using
``httpx.MockTransport`` so no network call is ever made.
"""
import json

import httpx
import pytest

from app.services.providers import (
    ChatMessage,
    ProviderError,
    ProviderNotSupported,
    ProviderRateLimitError,
    build_adapter,
    describe_provider_types,
    normalize_provider_type,
)
from app.services.providers.gemini import GeminiAdapter
from app.services.providers.openai_compatible import OpenAICompatibleAdapter


def transport_for(handler):
    return httpx.MockTransport(handler)


# ------------------------------------------------------------------ registry

def test_provider_catalogue_has_no_model_list_or_prices():
    described = describe_provider_types()
    keys = {item["key"] for item in described}
    assert {"openai", "gemini", "anthropic", "openrouter", "groq", "together",
            "deepseek", "fireworks", "custom"} <= keys
    blob = json.dumps(described).lower()
    for forbidden in ("gpt-4", "gpt-3", "claude-3", "gemini-pro", "per_million", "price"):
        assert forbidden not in blob


def test_aliases_and_unknown_types():
    assert normalize_provider_type("Google") == "gemini"
    assert normalize_provider_type("openai-compatible") == "custom"
    with pytest.raises(ProviderError) as excinfo:
        build_adapter("nope", "key-12345678")
    assert excinfo.value.code == "unknown_provider"


def test_custom_provider_requires_a_base_url():
    with pytest.raises(ProviderError) as excinfo:
        build_adapter("custom", "key-12345678")
    assert excinfo.value.code == "missing_base_url"
    adapter = build_adapter("custom", "key-12345678", "https://llm.internal.example/v1")
    assert adapter.base_url == "https://llm.internal.example/v1"


# --------------------------------------------------- OpenAI-compatible family

@pytest.mark.asyncio
async def test_openai_discovery_reads_only_what_the_provider_returns():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer sk-test-123456"
        assert request.url.path.endswith("/models")
        return httpx.Response(200, json={"data": [
            {"id": "vendor/model-a", "context_length": 8192, "owned_by": "vendor"},
            "vendor/model-b",
        ]})

    adapter = OpenAICompatibleAdapter("sk-test-123456", transport=transport_for(handler))
    models = await adapter.list_models()
    assert [m.model_id for m in models] == ["vendor/model-a", "vendor/model-b"]
    assert models[0].context_window == 8192
    # The provider said nothing about max output tokens, so it stays unknown.
    assert models[0].max_output_tokens is None
    assert models[1].context_window is None


@pytest.mark.asyncio
async def test_openai_chat_parses_text_usage_and_request_id():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "vendor/model-a"
        assert body["messages"][0]["role"] == "system"
        assert body["max_tokens"] == 256
        return httpx.Response(200, json={
            "id": "chatcmpl-abc",
            "model": "vendor/model-a-2024",
            "choices": [{"message": {"content": "Paris is the capital."}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 42, "completion_tokens": 7,
                      "prompt_tokens_details": {"cached_tokens": 10}},
        })

    adapter = OpenAICompatibleAdapter("sk-test-123456", transport=transport_for(handler))
    result = await adapter.chat([ChatMessage(role="system", content="be useful"),
                                 ChatMessage(role="user", content="capital of France?")],
                                model="vendor/model-a", max_tokens=256)
    assert result.text == "Paris is the capital."
    assert result.usage.input_tokens == 42
    assert result.usage.output_tokens == 7
    assert result.usage.cached_tokens == 10
    assert result.request_id == "chatcmpl-abc"
    assert result.model_id == "vendor/model-a-2024"  # the provider's resolved id


@pytest.mark.asyncio
async def test_openai_401_and_429_are_mapped_and_redacted():
    def unauthorised(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid key sk-secret-key-123456"}})

    adapter = OpenAICompatibleAdapter("sk-secret-key-123456", transport=transport_for(unauthorised))
    with pytest.raises(ProviderError) as excinfo:
        await adapter.chat([ChatMessage(role="user", content="hi")], model="m")
    assert excinfo.value.code == "invalid_credential"
    assert "sk-secret-key-123456" not in str(excinfo.value)

    def limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"retry-after": "1.5"},
                              json={"error": {"message": "slow down"}})

    adapter = OpenAICompatibleAdapter("sk-secret-key-123456", transport=transport_for(limited))
    with pytest.raises(ProviderRateLimitError) as limited_exc:
        await adapter.chat([ChatMessage(role="user", content="hi")], model="m")
    assert limited_exc.value.retry_after_seconds == 1.5


@pytest.mark.asyncio
async def test_openai_fine_tuning_probe_distinguishes_404_from_success():
    def missing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"message": "not found"}})

    adapter = OpenAICompatibleAdapter("sk-test-123456", transport=transport_for(missing))
    probe = await adapter.probe_fine_tuning()
    assert probe["supported"] is False

    def present(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    adapter = OpenAICompatibleAdapter("sk-test-123456", transport=transport_for(present))
    probe = await adapter.probe_fine_tuning()
    assert probe["supported"] is True


# ----------------------------------------------------------------- Anthropic

@pytest.mark.asyncio
async def test_anthropic_sends_system_prompt_separately():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "id": "msg_01",
            "model": "claude-x",
            "content": [{"type": "text", "text": "Answer from Anthropic"}],
            "usage": {"input_tokens": 11, "output_tokens": 5,
                      "cache_read_input_tokens": 3},
            "stop_reason": "end_turn",
        })

    adapter = build_adapter("anthropic", "sk-ant-test-123456")
    adapter._transport = transport_for(handler)
    result = await adapter.chat([
        ChatMessage(role="system", content="you are a teacher"),
        ChatMessage(role="user", content="explain gravity"),
    ], model="claude-x", max_tokens=128)

    assert captured["headers"]["x-api-key"] == "sk-ant-test-123456"
    assert captured["headers"]["anthropic-version"]
    assert captured["body"]["system"] == "you are a teacher"
    assert captured["body"]["messages"] == [{"role": "user", "content": "explain gravity"}]
    assert result.text == "Answer from Anthropic"
    assert result.usage.input_tokens == 11
    assert result.usage.cached_tokens == 3


@pytest.mark.asyncio
async def test_anthropic_discovery_paginates():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("after_id") == "claude-p2":
            return httpx.Response(200, json={"data": [
                {"id": "claude-p3", "display_name": "Claude P3", "context_window": 200000}
            ], "has_more": False})
        return httpx.Response(200, json={
            "data": [{"id": "claude-p1"}, {"id": "claude-p2"}],
            "has_more": True, "last_id": "claude-p2",
        })

    adapter = build_adapter("anthropic", "sk-ant-test-123456")
    adapter._transport = transport_for(handler)
    models = await adapter.list_models()
    assert [m.model_id for m in models] == ["claude-p1", "claude-p2", "claude-p3"]
    assert models[2].context_window == 200000


# -------------------------------------------------------------------- Gemini

@pytest.mark.asyncio
async def test_gemini_discovery_keeps_only_generate_content_models():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-goog-api-key"] == "AIza-test-123456"
        return httpx.Response(200, json={"models": [
            {"name": "models/gemini-a", "displayName": "Gemini A",
             "inputTokenLimit": 1000000, "outputTokenLimit": 8192,
             "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/embedding-b", "supportedGenerationMethods": ["embedContent"]},
        ]})

    adapter = GeminiAdapter("AIza-test-123456", transport=transport_for(handler))
    models = await adapter.list_models()
    assert [m.model_id for m in models] == ["gemini-a"]
    assert models[0].context_window == 1000000
    assert models[0].max_output_tokens == 8192


@pytest.mark.asyncio
async def test_gemini_chat_maps_roles_and_usage():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "candidates": [{"Content": None,
                            "content": {"parts": [{"text": "Gravity pulls masses together."}]},
                            "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 9, "candidatesTokenCount": 6},
        })

    adapter = GeminiAdapter("AIza-test-123456", transport=transport_for(handler))
    result = await adapter.chat([
        ChatMessage(role="system", content="teacher"),
        ChatMessage(role="user", content="what is gravity"),
    ], model="gemini-a", max_tokens=64)
    assert captured["body"]["contents"][0]["role"] == "user"
    assert captured["body"]["generationConfig"]["maxOutputTokens"] == 64
    assert result.text == "Gravity pulls masses together."
    assert result.usage.input_tokens == 9
    assert result.usage.output_tokens == 6


@pytest.mark.asyncio
async def test_unsupported_discovery_is_reported_not_faked():
    adapter = build_adapter("openai", "sk-test-123456")
    adapter._transport = transport_for(lambda request: httpx.Response(200, json={}))
    # An empty/malformed list must be an error, never an empty success.
    with pytest.raises(ProviderError):
        await adapter.list_models()

    class NoDiscovery(OpenAICompatibleAdapter):
        type_key = "custom"

        async def list_models(self):
            raise ProviderNotSupported("no discovery")

    no_discovery = NoDiscovery("key-12345678")
    probe = await no_discovery.test_connection()
    assert probe["ok"] is False
    assert probe["discovery_supported"] is False
