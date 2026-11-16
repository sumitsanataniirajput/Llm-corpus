"""CORPUS ULTIMATE — canonical ownership helpers.

Why this module exists
----------------------
Every user-owned row stores ``owner_id``. Supabase user ids are UUIDs, but the
value can reach the application in several shapes:

* ``uuid.UUID`` — what PostgreSQL's ``uuid`` type returns through SQLAlchemy,
* ``str`` — what a **text/varchar** ``owner_id`` column returns (this is what
  ``supabase/migrations/001_initial_schema.sql`` creates for ``models``),
* ``str`` with different case/whitespace — e.g. after a manual SQL insert.

Comparing those values naively (``model.owner_id != uuid.UUID(user["user_id"])``)
is *always* true for ``str`` vs ``uuid.UUID``, which made the legitimate owner
of a model receive ``403 Not authorized``. Everything that decides "is this row
mine?" must go through :func:`normalize_owner_id` / :func:`same_owner`.

There is a second, subtler failure mode: filtering in SQL with
``Model.owner_id == uuid.UUID(...)`` raises
``operator does not exist: text = uuid`` against a text column (HTTP 500).
:func:`owner_column_matches` renders a type-agnostic comparison instead, so the
same query works whether the live column is ``uuid`` or ``text``.

Ownership is never widened here: :func:`same_owner` is a strict equality on the
canonical UUID form, and :func:`owner_column_matches` is a strict equality
filter. Nothing in this module can reassign or share a row.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import String, cast, func

__all__ = [
    "normalize_owner_id",
    "same_owner",
    "require_user_uuid",
    "owner_column_matches",
    "owner_fingerprint",
]


def normalize_owner_id(value: Any) -> str:
    """Return ``value`` as a canonical lowercase UUID string.

    Falls back to a stripped, lowercased string when the value is not a UUID
    (so comparison is still deterministic instead of raising).
    """
    if value is None:
        return ""
    if isinstance(value, uuid.UUID):
        return str(value).lower()
    raw = str(value).strip()
    if not raw:
        return ""
    try:
        return str(uuid.UUID(raw)).lower()
    except (ValueError, TypeError, AttributeError):
        return raw.lower()


def same_owner(record_owner_id: Any, user_id: Any) -> bool:
    """True only when both ids resolve to the same canonical UUID."""
    left = normalize_owner_id(record_owner_id)
    right = normalize_owner_id(user_id)
    return bool(left and right and left == right)


def require_user_uuid(user: dict) -> uuid.UUID:
    """Extract the authenticated user's UUID from the ``require_user`` payload."""
    raw = (user or {}).get("user_id")
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    try:
        return uuid.UUID(str(raw).strip())
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticated user identifier",
        )


def owner_column_matches(column, user_id: Any):
    """SQL filter that matches ``column`` against ``user_id`` for uuid or text columns.

    ``CAST(owner_id AS VARCHAR)`` is valid for both ``uuid`` and ``text``
    columns and avoids ``operator does not exist: text = uuid``.
    """
    canonical = normalize_owner_id(user_id)
    return func.lower(cast(column, String)) == canonical


def owner_fingerprint(value: Any) -> str:
    """Short, non-reversible fingerprint used in diagnostics logs.

    Lets an operator compare "the id I expected" with "the id in the row"
    without dumping raw user ids into logs.
    """
    import hashlib

    canonical = normalize_owner_id(value)
    if not canonical:
        return ""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
