"""P1 — rate limiter safety regression tests.

The old limiter used an unbounded defaultdict, counted Render health probes and
trusted the raw socket IP even behind a proxy (or a spoofed X-Forwarded-For).
These tests hit the middleware directly so no live server or network is needed.
"""
import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.core import security

pytestmark = pytest.mark.asyncio


def make_request(path="/api/v1/models/", client=("1.2.3.4", 1234), headers=None):
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": raw_headers,
        "client": client,
        "server": ("testserver", 80),
    }
    return Request(scope)


async def call_next(_request):
    return JSONResponse({"ok": True})


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    security.reset_rate_limit_state()
    # conftest raises the env-based limit for the whole suite; override the
    # effective function so these unit tests control the budget directly.
    monkeypatch.setattr(security, "request_limit", lambda: 2)
    yield
    security.reset_rate_limit_state()


async def test_health_and_readiness_probes_are_exempt():
    for path in ("/health", "/ready", "/api/v1/health", "/api/v1/ready"):
        for _ in range(5):
            response = await security.rate_limit_middleware(make_request(path), call_next)
            assert response.status_code == 200, f"{path} must not consume the budget"
    assert not security._request_counts, "health checks never create buckets"


async def test_limit_is_per_client_and_returns_429():
    first = await security.rate_limit_middleware(make_request(), call_next)
    second = await security.rate_limit_middleware(make_request(), call_next)
    third = await security.rate_limit_middleware(make_request(), call_next)
    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    assert third.body and b"Rate limit exceeded" in third.body

    other = await security.rate_limit_middleware(
        make_request(client=("5.6.7.8", 1234)), call_next
    )
    assert other.status_code == 200, "a different client has its own budget"


async def test_forwarded_header_is_trusted_only_from_configured_proxy(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", ["10.0.0.1"])
    headers = {"x-forwarded-for": "9.9.9.9, 10.0.0.1"}
    trusted = make_request(client=("10.0.0.1", 1234), headers=headers)
    assert security._client_ip(trusted) == "9.9.9.9"

    assert (await security.rate_limit_middleware(trusted, call_next)).status_code == 200
    assert (await security.rate_limit_middleware(trusted, call_next)).status_code == 200
    assert (await security.rate_limit_middleware(trusted, call_next)).status_code == 429

    # The same header from an untrusted peer must NOT join the 9.9.9.9 bucket.
    spoofed = make_request(client=("5.6.7.8", 1234), headers=headers)
    assert security._client_ip(spoofed) == "5.6.7.8"
    assert (await security.rate_limit_middleware(spoofed, call_next)).status_code == 200


async def test_expired_requests_are_pruned(monkeypatch):
    monkeypatch.setattr(security, "request_limit", lambda: 1)
    now = [1000.0]
    monkeypatch.setattr(security.time, "time", lambda: now[0])

    assert (await security.rate_limit_middleware(make_request(), call_next)).status_code == 200
    assert (await security.rate_limit_middleware(make_request(), call_next)).status_code == 429

    now[0] += security.RATE_LIMIT_WINDOW + 1
    assert (await security.rate_limit_middleware(make_request(), call_next)).status_code == 200
    assert len(security._request_counts) == 1


async def test_tracked_client_dictionary_is_bounded(monkeypatch):
    monkeypatch.setattr(security, "MAX_TRACKED_CLIENTS", 3)
    for i in range(10):
        await security.rate_limit_middleware(
            make_request(client=(f"10.0.0.{i}", 1234)), call_next
        )
    assert len(security._request_counts) <= 3
