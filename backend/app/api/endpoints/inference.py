"""CORPUS ULTIMATE — checkpoint-backed inference endpoints.

All tokenization, next-token probabilities and generation come from the real
PyTorch checkpoint saved by the training worker. Requests are scoped to the
authenticated model owner; untrained models answer ``status="unavailable"``
with an explicit message instead of a fabricated score or response.
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session_factory
from app.core.models import Model
from app.core.ownership import owner_column_matches, require_user_uuid, same_owner
from app.core.websocket_auth import authenticate_socket
from app.dependencies import get_db_session, require_user
from app.services import inference_service

logger = logging.getLogger("corpus.inference")
router = APIRouter()


class InferRequest(BaseModel):
    text: str = ""
    temperature: float = 0.8
    top_k: int = 50
    top_p: float = 0.9
    max_tokens: int = Field(default=100, ge=1, le=128)
    seed: int | None = None


class TokenizeRequest(BaseModel):
    text: str = ""


class NextTokenRequest(BaseModel):
    text: str = ""
    temperature: float = 1.0
    top_k: int = 10
    top_p: float = 0.9
    max_tokens: int = 1


async def _owned_model(db: AsyncSession, model_id: str, user: dict) -> Model:
    owner_uuid = require_user_uuid(user)
    result = await db.execute(
        select(Model).where(
            Model.id == model_id,
            owner_column_matches(Model.owner_id, owner_uuid),
        )
    )
    model = result.scalar_one_or_none()
    if not model or not same_owner(model.owner_id, owner_uuid):
        # 404, not 403: never reveal that another account's model id exists.
        raise HTTPException(status_code=404, detail="Model not found for this account.")
    return model


async def _owned_model_for_socket(model_id: str, owner_uuid) -> Model:
    factory = get_session_factory()
    async with factory() as db:
        result = await db.execute(
            select(Model).where(
                Model.id == model_id,
                owner_column_matches(Model.owner_id, owner_uuid),
            )
        )
        model = result.scalar_one_or_none()
        if not model or not same_owner(model.owner_id, owner_uuid):
            raise HTTPException(status_code=404, detail="Model not found for this account.")
        # Expire nothing: config is JSONB and is already loaded.
        return model


def _require_trained(model: Model) -> dict:
    if model.status != "trained":
        raise inference_service.InferenceUnavailable(
            "This model is not trained yet. Complete a training job before running inference."
        )
    config = model.config if isinstance(model.config, dict) else {}
    if not config.get("checkpoint_path") or not config.get("tokenizer_path"):
        raise inference_service.InferenceUnavailable(
            "This model has no saved checkpoint/tokenizer. Train it first to generate real responses."
        )
    return config


def _unavailable(model_id: str, exc: inference_service.InferenceUnavailable, **extra):
    return {
        "model_id": model_id,
        "status": "unavailable",
        "response": "",
        "tokens_generated": 0,
        "predictions": [],
        "tokens": [],
        "ids": [],
        "message": str(exc),
        **extra,
    }


@router.post("/{model_id}/stream", tags=["inference"])
async def infer_stream(model_id: str, payload: InferRequest, user=Depends(require_user),
                       db: AsyncSession = Depends(get_db_session)):
    """Report the authenticated socket route; no token is ever put in the URL."""
    await _owned_model(db, model_id, user)
    return {
        "model_id": model_id,
        "stream_url": f"/api/v1/inference/{model_id}/ws",
        "auth": "first-frame: {\"type\":\"auth\",\"token\":\"<supabase access token>\"}",
        "event": "token",
        "done": True,
    }


@router.post("/tokenize/{model_id}", tags=["inference"])
async def tokenize(model_id: str, payload: TokenizeRequest, user=Depends(require_user),
                   db: AsyncSession = Depends(get_db_session)):
    """Tokenize with the trained checkpoint's real vocabulary."""
    model = await _owned_model(db, model_id, user)
    try:
        _require_trained(model)
        bundle = await inference_service.load_bundle(model.config)
        result = await inference_service.tokenize(bundle, payload.text)
    except inference_service.InferenceUnavailable as exc:
        return _unavailable(model_id, exc, vocab_size=None)
    except Exception as exc:
        logger.exception("Tokenization failed for model %s", model_id)
        raise HTTPException(status_code=500, detail=f"Tokenization failed: {str(exc)[:180]}")
    return {"model_id": model_id, "status": "available", **result}


@router.post("/predict/{model_id}", tags=["inference"])
async def next_token(model_id: str, payload: NextTokenRequest, user=Depends(require_user),
                     db: AsyncSession = Depends(get_db_session)):
    """Return a next-token distribution computed from real model logits."""
    model = await _owned_model(db, model_id, user)
    try:
        _require_trained(model)
        bundle = await inference_service.load_bundle(model.config)
        result = await inference_service.next_token_distribution(
            bundle, payload.text, payload.model_dump()
        )
    except inference_service.InferenceUnavailable as exc:
        return _unavailable(model_id, exc)
    except Exception as exc:
        logger.exception("Next-token inference failed for model %s", model_id)
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(exc)[:180]}")
    return {"model_id": model_id, "status": "available", **result}


@router.post("/{model_id}", tags=["inference"])
async def infer(model_id: str, payload: InferRequest, user=Depends(require_user),
                db: AsyncSession = Depends(get_db_session)):
    """Generate text from the trained model (no external API, no canned reply)."""
    model = await _owned_model(db, model_id, user)
    try:
        _require_trained(model)
        bundle = await inference_service.load_bundle(model.config)
        result = await inference_service.generate(bundle, payload.text, payload.model_dump())
    except inference_service.InferenceUnavailable as exc:
        return _unavailable(model_id, exc)
    except Exception as exc:
        logger.exception("Generation failed for model %s", model_id)
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(exc)[:180]}")
    return {"model_id": model_id, "status": "available", **result}


@router.websocket("/{model_id}/ws")
async def inference_ws(websocket: WebSocket, model_id: str):
    """Authenticated streaming generation.

    The shared first auth frame carries the Supabase token; subsequent frames
    are generation requests. Each token is sent as soon as its real forward
    pass completes. Query-string credentials are never accepted.
    """
    identity = await authenticate_socket(websocket)
    if not identity:
        return
    try:
        model = await _owned_model_for_socket(model_id, identity["owner_id"])
        _require_trained(model)
        bundle = await inference_service.load_bundle(model.config)
    except HTTPException as exc:
        await websocket.send_json({
            "type": "inference", "event": "error", "done": True,
            "data": {"message": exc.detail},
        })
        await websocket.close(code=1008)
        return
    except inference_service.InferenceUnavailable as exc:
        await websocket.send_json({
            "type": "inference", "event": "unavailable", "done": True,
            "model_id": model_id, "status": "unavailable", "message": str(exc),
        })
        await websocket.close(code=1008)
        return
    except Exception as exc:
        logger.exception("Inference socket setup failed for model %s", model_id)
        await websocket.send_json({
            "type": "inference", "event": "error", "done": True,
            "data": {"message": f"Could not load checkpoint: {str(exc)[:180]}"},
        })
        await websocket.close(code=1011)
        return

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}
            if not isinstance(payload, dict) or payload.get("type") == "auth":
                continue
            text = str(payload.get("text") or "")
            await websocket.send_json({
                "type": "inference", "event": "start", "model_id": model_id,
                "status": "available", "checkpoint": bundle.meta, "done": False,
            })
            pieces = []
            tokens_generated = 0
            try:
                async for event in inference_service.stream_generation(bundle, text, payload):
                    if event["done"]:
                        break
                    pieces.append(event["text"])
                    tokens_generated += 1
                    await websocket.send_json({
                        "type": "inference", "event": "token", "model_id": model_id,
                        "index": event["index"], "token": event["token"],
                        "token_id": event["token_id"], "text": event["text"],
                        "done": False,
                    })
                await websocket.send_json({
                    "type": "inference", "event": "complete", "model_id": model_id,
                    "status": "available", "response": "".join(pieces),
                    "tokens_generated": tokens_generated, "checkpoint": bundle.meta,
                    "done": True,
                })
            except inference_service.InferenceUnavailable as exc:
                await websocket.send_json({
                    "type": "inference", "event": "unavailable", "model_id": model_id,
                    "status": "unavailable", "message": str(exc), "done": True,
                })
            except Exception as exc:
                logger.exception("Streaming generation failed for model %s", model_id)
                await websocket.send_json({
                    "type": "inference", "event": "error", "model_id": model_id,
                    "data": {"message": f"Generation failed: {str(exc)[:180]}"},
                    "done": True,
                })
    except WebSocketDisconnect:
        pass
