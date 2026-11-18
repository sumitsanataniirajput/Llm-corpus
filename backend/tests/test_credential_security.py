"""Credential encryption and provider-management security.

These tests are the guard rails for the strongest promise in the teacher network:
an API key is stored encrypted, is never returned, never logged, and cannot be
stored at all when the encryption key is missing.
"""
import os

import pytest

from app.services import crypto

TEST_KEY = os.environ["CREDENTIAL_ENCRYPTION_KEY"]
OTHER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"


# --------------------------------------------------------------- crypto unit

def test_encrypt_decrypt_round_trip():
    secret = "sk-live-abcdef0123456789"
    envelope = crypto.encrypt_secret(secret)
    assert envelope.startswith("v1:")
    assert secret not in envelope
    assert crypto.decrypt_secret(envelope) == secret
    # A second encryption of the same secret differs (random nonce).
    assert crypto.encrypt_secret(secret) != envelope


def test_wrong_key_cannot_decrypt():
    envelope = crypto.encrypt_secret("sk-another-secret-value", key_material=TEST_KEY)
    with pytest.raises(crypto.CredentialError):
        crypto.decrypt_secret(envelope, key_material=OTHER_KEY)


def test_tampered_envelope_is_rejected():
    envelope = crypto.encrypt_secret("sk-tamper-check-1234")
    body = envelope[3:]
    flipped = body[:-4] + ("AAAA" if body[-4:] != "AAAA" else "BBBB")
    with pytest.raises(crypto.CredentialError):
        crypto.decrypt_secret("v1:" + flipped)


def test_missing_key_refuses_to_encrypt(monkeypatch):
    monkeypatch.setattr("app.config.settings.CREDENTIAL_ENCRYPTION_KEY", "")
    monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
    with pytest.raises(crypto.CredentialKeyMissing):
        crypto.encrypt_secret("sk-should-not-be-stored")
    assert crypto.key_available() is False


def test_mask_and_fingerprint_never_reveal_the_secret():
    secret = "sk-very-secret-value-0001"
    masked = crypto.mask_secret(secret)
    assert secret not in masked
    assert masked.endswith(secret[-4:])
    digest = crypto.fingerprint(secret)
    assert secret not in digest
    assert digest == crypto.fingerprint("  " + secret + "  ")  # normalised
    assert digest != crypto.fingerprint(secret + "x")


def test_redact_removes_key_from_provider_errors():
    secret = "sk-error-leak-9999"
    message = f"401 Unauthorized for key {secret} (check sk-error-leak-99)"
    cleaned = crypto.redact(message, secret)
    assert secret not in cleaned
    assert "sk-error-leak-99" not in cleaned


# --------------------------------------------------------------- HTTP surface

async def test_credential_status_reports_missing_key(http, monkeypatch):
    monkeypatch.setattr("app.config.settings.CREDENTIAL_ENCRYPTION_KEY", "")
    monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
    resp = await http.get("/api/v1/teachers/credential-status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["encryption_configured"] is False
    assert "CREDENTIAL_ENCRYPTION_KEY" in body["message"]


async def test_create_provider_is_refused_without_key(http, monkeypatch):
    monkeypatch.setattr("app.config.settings.CREDENTIAL_ENCRYPTION_KEY", "")
    monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
    resp = await http.post("/api/v1/teachers/providers", json={
        "provider_type": "openai",
        "name": "No-key provider",
        "api_key": "sk-should-never-be-stored",
        "test_on_save": False,
    })
    assert resp.status_code == 409
    assert "CREDENTIAL_ENCRYPTION_KEY" in resp.json()["detail"]


async def test_provider_create_hides_key_and_rejects_duplicates(http):
    payload = {
        "provider_type": "openai",
        "name": "Primary OpenAI",
        "api_key": "sk-test-provider-key-0001",
        "test_on_save": False,
    }
    resp = await http.post("/api/v1/teachers/providers", json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert "credential_ciphertext" not in body
    assert body["credential_hint"].endswith("0001")
    assert len(body["credential_fingerprint"]) == 8
    assert body["status"] == "unverified"

    duplicate = await http.post("/api/v1/teachers/providers", json={**payload, "name": "Second copy"})
    assert duplicate.status_code == 409
    assert "already connected" in duplicate.json()["detail"]

    listing = (await http.get("/api/v1/teachers/providers")).json()
    assert len(listing["providers"]) == 1
    assert "sk-test-provider-key-0001" not in str(listing)


async def test_provider_is_owner_scoped(http, http_as_other):
    created = (await http.post("/api/v1/teachers/providers", json={
        "provider_type": "groq", "name": "Owner only", "api_key": "gsk-owner-scoped-1234",
        "test_on_save": False,
    })).json()

    other_list = (await http_as_other.get("/api/v1/teachers/providers")).json()
    assert other_list["providers"] == []
    assert (await http_as_other.patch(f"/api/v1/teachers/providers/{created['id']}",
                                      json={"name": "hijack"})).status_code == 404
    assert (await http_as_other.post(f"/api/v1/teachers/providers/{created['id']}/test")).status_code == 404
    assert (await http_as_other.delete(f"/api/v1/teachers/providers/{created['id']}")).status_code == 404


async def test_provider_delete_revokes_credential(http):
    created = (await http.post("/api/v1/teachers/providers", json={
        "provider_type": "anthropic", "name": "Temp", "api_key": "sk-ant-temp-key-9999",
        "test_on_save": False,
    })).json()
    import uuid
    from sqlalchemy import text
    from app.core.database import get_session_factory

    async with get_session_factory()() as db:
        before = (await db.execute(text(
            "SELECT credential_ciphertext FROM public.ai_provider_connections WHERE id = :id"
        ), {"id": created["id"]})).scalar_one()
        assert before.startswith("v1:")

    assert (await http.delete(f"/api/v1/teachers/providers/{created['id']}")).status_code == 200
    async with get_session_factory()() as db:
        after = (await db.execute(text(
            "SELECT COUNT(*) FROM public.ai_provider_connections WHERE id = :id"
        ), {"id": created["id"]})).scalar_one()
    assert after == 0


async def test_budget_limits_are_stored_and_returned(http):
    created = (await http.post("/api/v1/teachers/providers", json={
        "provider_type": "gemini", "name": "Budgeted", "api_key": "AIza-budget-test-1234",
        "test_on_save": False,
    })).json()
    resp = await http.put(f"/api/v1/teachers/providers/{created['id']}/budget", json={
        "max_spend_usd_per_day": 2.5, "max_requests_per_day": 40, "max_concurrent_requests": 2,
    })
    assert resp.status_code == 200
    assert resp.json()["budget"]["max_spend_usd_per_day"] == 2.5
    listing = (await http.get("/api/v1/teachers/providers")).json()
    assert listing["providers"][0]["budget"]["max_requests_per_day"] == 40
