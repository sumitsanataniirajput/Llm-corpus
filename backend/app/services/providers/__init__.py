"""External AI teacher provider adapters.

One adapter per API family. Each adapter owns its own authentication, model
discovery, request formatting, response parsing, usage extraction, error mapping
and capability detection — nothing is shared by assumption.

No model list and no price is hardcoded anywhere in this package. Models come from
the provider's discovery endpoint or from the owner typing an ID; prices come from
the owner (or a provider that returns them) and are stored per teacher model.
"""
from app.services.providers.base import (  # noqa: F401
    ChatMessage,
    ChatResult,
    ProviderAdapter,
    ProviderError,
    ProviderRateLimitError,
    ProviderNotSupported,
    TeacherModelInfo,
    Usage,
)
from app.services.providers.registry import (  # noqa: F401
    PROVIDER_TYPES,
    build_adapter,
    describe_provider_types,
    normalize_provider_type,
)

__all__ = [
    "ChatMessage",
    "ChatResult",
    "ProviderAdapter",
    "ProviderError",
    "ProviderRateLimitError",
    "ProviderNotSupported",
    "TeacherModelInfo",
    "Usage",
    "PROVIDER_TYPES",
    "build_adapter",
    "describe_provider_types",
    "normalize_provider_type",
]
