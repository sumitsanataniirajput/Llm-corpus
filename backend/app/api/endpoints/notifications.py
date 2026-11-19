"""CORPUS ULTIMATE — general authenticated application WebSocket.

Mounted at ``/api/v1/ws``. The browser cannot attach an Authorization header to
a WebSocket and must not put the Supabase access token in the URL, so the first
frame is the shared auth frame (see :mod:`app.core.websocket_auth`).

The socket currently acknowledges authentication and answers application-level
pings. Training/inference events use their own dedicated, equally authenticated
sockets; no unauthenticated event bus is exposed here. Keeping a real endpoint
also stops ``connectWS()`` from silently reconnecting forever against a 404.
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.websocket_auth import authenticate_socket

router = APIRouter()


@router.websocket("")
async def application_ws(websocket: WebSocket):
    identity = await authenticate_socket(websocket)
    if not identity:
        return
    await websocket.send_json({"type": "ready", "event": "ready", "authenticated": True})
    try:
        while True:
            raw = await websocket.receive_text()
            if raw.strip() == "ping":
                await websocket.send_json({"type": "pong", "event": "pong"})
    except WebSocketDisconnect:
        pass


__all__ = ["router"]
