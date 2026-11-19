"""CORPUS ULTIMATE — shared first-frame WebSocket authentication.

Browser WebSockets cannot send an ``Authorization`` header, but a
``?token=...`` query string is not acceptable either: URLs are written to proxy
and access logs, browser history and sometimes Referer headers. Every CORPUS
socket therefore accepts an unauthenticated TCP/WebSocket upgrade only long
enough to read ONE small JSON frame::

    {"type": "auth", "token": "<supabase access token>"}

The token is verified against Supabase Auth before any account data is read or
any inference/training event is emitted. Invalid, missing or slow handshakes are
closed with policy code 1008. No token is ever accepted from the URL.

This helper is deliberately shared so the general notification socket, training
progress socket and inference socket cannot drift into three different auth
policies.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException, WebSocket

from app.dependencies import verify_supabase_token
from app.core.ownership import normalize_owner_id

AUTH_FRAME_TIMEOUT_SECONDS = 5.0
POLICY_VIOLATION = 1008


async def authenticate_socket(
    websocket: WebSocket,
    timeout: float = AUTH_FRAME_TIMEOUT_SECONDS,
) -> Optional[Dict[str, Any]]:
    """Accept a socket and authenticate its first frame.

    Returns a small identity dict on success, or ``None`` after closing the
    socket. Callers must return immediately when ``None`` is returned. No row
    lookup, model access or outbound event may happen before this succeeds.
    """
    await websocket.accept()
    try:
        frame = await asyncio.wait_for(websocket.receive_json(), timeout=timeout)
    except Exception:
        # Includes asyncio.TimeoutError, WebSocketDisconnect and malformed JSON.
        await websocket.close(code=POLICY_VIOLATION)
        return None

    if not isinstance(frame, dict) or frame.get("type") != "auth":
        await websocket.close(code=POLICY_VIOLATION)
        return None
    token = frame.get("token")
    if not token or not isinstance(token, str):
        await websocket.close(code=POLICY_VIOLATION)
        return None

    user: Optional[dict] = None
    try:
        user = await verify_supabase_token(token)
    except HTTPException:
        user = None
    if not user:
        await websocket.close(code=POLICY_VIOLATION)
        return None

    raw_id = user.get("id") or user.get("user_id")
    if not raw_id:
        await websocket.close(code=POLICY_VIOLATION)
        return None
    try:
        owner_uuid = uuid.UUID(str(raw_id).strip())
    except (ValueError, TypeError, AttributeError):
        await websocket.close(code=POLICY_VIOLATION)
        return None

    return {
        "user": user,
        "owner_id": owner_uuid,
        "owner_key": normalize_owner_id(owner_uuid),
    }


__all__ = ["authenticate_socket", "AUTH_FRAME_TIMEOUT_SECONDS", "POLICY_VIOLATION"]
