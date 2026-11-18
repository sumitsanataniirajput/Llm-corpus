"""Load the real text a distillation job will use as source material.

Reads the newest uploaded object of a dataset from private Supabase Storage,
extracts text with the same extractor the training pipeline uses, and truncates
to a hard character budget. Nothing is synthesized: if there is no stored file,
the caller is told so.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.endpoints.datasets import _storage_client, latest_file_for_dataset
from app.config import settings
from app.services.text_extraction import DatasetTextError, extract_text


class DatasetSourceUnavailable(RuntimeError):
    """The dataset exists but no usable text could be produced from it."""


async def load_dataset_text(
    db: AsyncSession,
    dataset_id: str,
    owner_id: uuid.UUID,
    *,
    max_chars: Optional[int] = None,
) -> Dict[str, Any]:
    """Return ``{text, file_name, total_characters, returned_characters, truncated}``."""
    budget = int(max_chars or getattr(settings, "DISTILLATION_MAX_SOURCE_CHARS", 60_000) or 60_000)
    file_row = await latest_file_for_dataset(db, dataset_id, owner_id)
    if not file_row:
        raise DatasetSourceUnavailable(
            "This dataset has no stored file yet, so there is no text to distill from. "
            "Upload a file in Dataset Manager first."
        )

    try:
        storage = _storage_client()
        bucket_api = storage.storage.from_(settings.STORAGE_BUCKET)
        raw = await asyncio.to_thread(bucket_api.download, file_row["storage_path"])
    except HTTPException as exc:
        raise DatasetSourceUnavailable(str(exc.detail)) from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller verbatim
        raise DatasetSourceUnavailable(
            f"The stored dataset file could not be read: {str(exc)[:200]}"
        ) from exc

    if isinstance(raw, dict):
        raw = raw.get("data", b"")
    if isinstance(raw, str):
        raw = raw.encode("utf-8", errors="replace")
    if not raw:
        raise DatasetSourceUnavailable("The stored dataset file is empty.")

    try:
        text_value = extract_text(raw, file_row["file_name"])
    except DatasetTextError as exc:
        raise DatasetSourceUnavailable(str(exc)) from exc

    trimmed = text_value[:budget]
    return {
        "dataset_id": dataset_id,
        "file_name": file_row["file_name"],
        "text": trimmed,
        "total_characters": len(text_value),
        "returned_characters": len(trimmed),
        "truncated": len(text_value) > len(trimmed),
        "max_chars": budget,
    }
