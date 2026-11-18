"""Credential encryption for external AI provider API keys.

The raw key is encrypted with AES-256-GCM before it is written to the database.
Only the backend holds the key material (``CREDENTIAL_ENCRYPTION_KEY``, a Render
environment variable); the frontend never receives anything but a masked hint.

Envelope format (one text column)::

    v1:<base64(nonce || ciphertext || tag)>

* 32-byte AES key, 12-byte random nonce per encryption, 16-byte GCM tag.
* Authenticated encryption: a modified ciphertext fails to decrypt instead of
  returning attacker-controlled plaintext.
* No key material, plaintext or plaintext-derived secret is ever logged: errors
  raised here mention only the *reason*, never the value.

If the key is absent or malformed, :func:`encrypt_secret` raises
:class:`CredentialKeyMissing`. Saving a provider credential then fails instead of
falling back to plaintext storage.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
from typing import Optional, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_PREFIX = "v1:"
NONCE_BYTES = 12
KEY_BYTES = 32
MIN_SECRET_LENGTH = 8


class CredentialError(RuntimeError):
    """Base class for credential handling errors (never carries the secret)."""


class CredentialKeyMissing(CredentialError):
    """Raised when CREDENTIAL_ENCRYPTION_KEY is not configured or is invalid."""


class CredentialDecryptError(CredentialError):
    """Raised when an envelope cannot be authenticated/decrypted."""


def _settings_key() -> str:
    # Read through app.config so tests and production use exactly one source.
    try:
        from app.config import settings
        value = getattr(settings, "CREDENTIAL_ENCRYPTION_KEY", "") or ""
    except Exception:  # pragma: no cover - config import problems surface elsewhere
        value = ""
    if not value:
        value = os.environ.get("CREDENTIAL_ENCRYPTION_KEY", "") or ""
    return value.strip()


def parse_key_material(raw: Optional[str]) -> bytes:
    """Decode the configured key material into 32 raw bytes."""
    if raw is None:
        raw = _settings_key()
    if not raw:
        raise CredentialKeyMissing(
            "CREDENTIAL_ENCRYPTION_KEY is not configured, so provider credentials cannot be "
            "encrypted. Set it (32 random bytes, base64 or hex) before adding a provider."
        )
    text = raw.strip()
    # Hex form (64 chars) is unambiguous; try it first.
    if len(text) == 64:
        try:
            decoded = bytes.fromhex(text)
            if len(decoded) == KEY_BYTES:
                return decoded
        except ValueError:
            pass
    # base64 / base64url form
    padded = text + "=" * (-len(text) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            decoded = decoder(padded)
        except Exception:
            continue
        if len(decoded) == KEY_BYTES:
            return decoded
    # A raw passphrase is acceptable only if it is long enough, and it is then
    # stretched with SHA-256 (documented, deterministic, no external deps).
    if len(text) >= 32:
        return hashlib.sha256(text.encode("utf-8")).digest()
    raise CredentialKeyMissing(
        "CREDENTIAL_ENCRYPTION_KEY is invalid: provide 32 random bytes encoded as base64 or "
        "hex (or at least 32 characters of high-entropy text)."
    )


def key_available() -> bool:
    """True when credentials can be encrypted right now."""
    try:
        parse_key_material(None)
        return True
    except CredentialError:
        return False


def encrypt_secret(plaintext: str, key_material: Optional[str] = None) -> str:
    """Encrypt a provider API key into the ``v1:`` envelope."""
    if not isinstance(plaintext, str) or not plaintext.strip():
        raise CredentialError("The API key is empty.")
    secret = plaintext.strip()
    if len(secret) < MIN_SECRET_LENGTH:
        raise CredentialError("The API key looks too short to be valid.")
    key = parse_key_material(key_material)
    nonce = secrets.token_bytes(NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(nonce, secret.encode("utf-8"), None)
    return ENVELOPE_PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_secret(envelope: str, key_material: Optional[str] = None) -> str:
    """Decrypt an envelope produced by :func:`encrypt_secret`."""
    if not isinstance(envelope, str) or not envelope.startswith(ENVELOPE_PREFIX):
        raise CredentialDecryptError("Stored credential is not in the expected encrypted format.")
    blob = base64.b64decode(envelope[len(ENVELOPE_PREFIX):])
    if len(blob) <= NONCE_BYTES:
        raise CredentialDecryptError("Stored credential is truncated.")
    key = parse_key_material(key_material)
    nonce, ciphertext = blob[:NONCE_BYTES], blob[NONCE_BYTES:]
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, None).decode("utf-8")
    except Exception as exc:  # InvalidTag and friends
        raise CredentialDecryptError(
            "The stored credential could not be decrypted (wrong key or corrupted record)."
        ) from exc


def mask_secret(secret: Optional[str], visible: int = 4) -> str:
    """Display form: only the last few characters, never the whole key."""
    if not secret:
        return "••••"
    text = str(secret)
    if len(text) <= visible:
        return "••••"
    return "••••" + text[-visible:]


def fingerprint(secret: str) -> str:
    """Stable, non-reversible identifier used for audit and duplicate detection.

    Whitespace is stripped first so the same key pasted with stray spaces maps to
    the same fingerprint, matching how the API normalises user input.
    """
    normalised = str(secret or "").strip()
    return hashlib.sha256(("corpus-credential:" + normalised).encode("utf-8")).hexdigest()[:32]


#: Shortest key fragment treated as sensitive when redacting an error message.
_REDACT_MIN_PREFIX = 8


def redact(text: Optional[str], secret: Optional[str] = None) -> str:
    """Remove an API key — and any prefix of it — from text bound for a log or API.

    Provider error bodies sometimes echo a truncated key (``sk-abc...`` or the
    first characters quoted back). Longest-first prefix replacement covers both
    the full key and those fragments.
    """
    value = "" if text is None else str(text)
    key = str(secret or "").strip()
    if not key:
        return value
    masked = mask_secret(key)
    for cut in range(len(key), _REDACT_MIN_PREFIX - 1, -1):
        fragment = key[:cut]
        if fragment and fragment in value:
            value = value.replace(fragment, masked)
    return value


def envelope_metadata(envelope: str) -> Tuple[str, str]:
    """Return (hint, fingerprint) for a plaintext key without storing the key."""
    return mask_secret(envelope), fingerprint(envelope)
