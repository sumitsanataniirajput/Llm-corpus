"""P2 — WebSocket authentication is a first frame, never a URL query token."""
import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.core import websocket_auth


USER_ID = str(uuid.uuid4())


@pytest.fixture(autouse=True)
def _fake_supabase(monkeypatch):
    async def _verify(token):
        if token != "valid-access-token":
            return None
        return {"id": USER_ID, "email": "socket@example.com"}

    monkeypatch.setattr(websocket_auth, "verify_supabase_token", _verify)


def _client():
    # Deliberately not used as a context manager: no lifespan/DB startup work is
    # needed for the auth handshake.
    return TestClient(app)


def test_general_socket_accepts_first_frame_auth_and_answers_ping():
    client = _client()
    with client.websocket_connect("/api/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": "valid-access-token"})
        assert ws.receive_json() == {
            "type": "ready", "event": "ready", "authenticated": True,
        }
        ws.send_text("ping")
        assert ws.receive_json() == {"type": "pong", "event": "pong"}


def test_general_socket_ignores_query_token_and_closes_without_auth_frame():
    client = _client()
    with client.websocket_connect("/api/v1/ws?token=valid-access-token") as ws:
        ws.send_json({"type": "hello"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_general_socket_rejects_invalid_access_token():
    client = _client()
    with client.websocket_connect("/api/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": "expired-token"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_training_socket_rejects_a_token_only_in_the_query_string():
    client = _client()
    with client.websocket_connect(
        "/api/v1/training/ws/job_x?token=valid-access-token"
    ) as ws:
        ws.send_json({"type": "subscribe"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_inference_socket_authenticates_before_any_model_lookup():
    client = _client()
    with client.websocket_connect("/api/v1/inference/model_x/ws") as ws:
        ws.send_json({"type": "auth", "token": "valid-access-token"})
        # Authentication succeeded, but the account does not own this model.
        # The socket must report the ownership error instead of generating.
        reply = ws.receive_json()
        assert reply["type"] == "inference"
        assert reply["event"] == "error"
        assert "not found" in reply["data"]["message"]


def test_inference_socket_rejects_invalid_token_before_generation():
    client = _client()
    with client.websocket_connect("/api/v1/inference/model_x/ws") as ws:
        ws.send_json({"type": "auth", "token": "wrong-token"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008
