"""Real text extraction for uploaded datasets.

The training worker and the preview endpoint both call :func:`extract_text` so a
dataset that can be *uploaded* is exactly a dataset that can be *trained on*.

Supported formats and how they are handled:

===========  ===============================================================
Format       Extraction
===========  ===============================================================
``txt``      UTF-8 (BOM tolerated) decoded verbatim, validated as text.
``md``       Same as ``txt`` (Markdown is plain text).
``csv``      Parsed with :mod:`csv`; cells joined per row (tab-free text).
``json``     Recursively collected string/number values in document order.
``jsonl``    One JSON document per line, same collection rules.
``pdf``      Page text via ``pypdf``; scanned PDFs without a text layer are
             rejected with a clear error instead of producing binary noise.
===========  ===============================================================

Anything else raises :class:`DatasetTextError` with a message that is safe to
surface to the user.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from typing import Any, Iterable, List

SUPPORTED_FORMATS = ("txt", "text", "md", "markdown", "csv", "json", "jsonl", "pdf")

# Human readable list used in error messages.
SUPPORTED_LABEL = "TXT, CSV, JSON, JSONL or PDF"

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class DatasetTextError(ValueError):
    """Raised when a stored file cannot be turned into training text."""


def _extension(file_name: str) -> str:
    name = (file_name or "").strip().lower()
    return os.path.splitext(name)[1].lstrip(".")


def _looks_like_pdf(raw: bytes) -> bool:
    return raw[:5] == b"%PDF-"


def _decode_text(raw: bytes, *, source: str) -> str:
    """Decode UTF-8 (BOM tolerant) and reject binary-looking payloads."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DatasetTextError(
            f"{source} is not valid UTF-8 text — it may be a binary file. "
            "Re-save it as UTF-8, or upload a PDF/CSV/JSON file instead."
        ) from exc
    if not text.strip():
        raise DatasetTextError(f"{source} contains no readable text.")
    # A decoded UTF-8 file can still be binary (e.g. a renamed image). Reject
    # payloads dominated by control characters instead of training on noise.
    control = len(_CONTROL_CHARS.findall(text))
    if control and control / max(len(text), 1) > 0.02:
        raise DatasetTextError(
            f"{source} looks like a binary file, not text. Upload plain text, CSV, JSON or a PDF."
        )
    return text


def _collect_json_strings(value: Any, sink: List[str]) -> None:
    if isinstance(value, str):
        sink.append(value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        sink.append(str(value))
    elif isinstance(value, dict):
        for key, item in value.items():
            if isinstance(key, str):
                sink.append(key)
            _collect_json_strings(item, sink)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _collect_json_strings(item, sink)


def _join_chunks(chunks: Iterable[str]) -> str:
    parts = [chunk.strip() for chunk in chunks]
    return "\n".join(part for part in parts if part)


def _extract_csv(text: str, source: str) -> str:
    try:
        rows = list(csv.reader(io.StringIO(text)))
    except csv.Error as exc:
        raise DatasetTextError(f"{source} could not be parsed as CSV: {exc}") from exc
    lines = [" ".join(cell.strip() for cell in row if cell and cell.strip()) for row in rows]
    result = _join_chunks(lines)
    if not result:
        raise DatasetTextError(f"{source} contains no readable CSV cells.")
    return result


def _extract_json(text: str, source: str) -> str:
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DatasetTextError(
            f"{source} is not valid JSON (line {exc.lineno}, column {exc.colno}): {exc.msg}."
        ) from exc
    chunks: List[str] = []
    _collect_json_strings(document, chunks)
    result = _join_chunks(chunks)
    if not result:
        raise DatasetTextError(f"{source} contains no text or number values to train on.")
    return result


def _extract_jsonl(text: str, source: str) -> str:
    chunks: List[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            document = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise DatasetTextError(
                f"{source} line {number} is not valid JSON: {exc.msg}."
            ) from exc
        _collect_json_strings(document, chunks)
    result = _join_chunks(chunks)
    if not result:
        raise DatasetTextError(f"{source} contains no text or number values to train on.")
    return result


def _extract_pdf(raw: bytes, source: str) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise DatasetTextError(
            "PDF extraction is unavailable on this server (pypdf is not installed). "
            "Upload a TXT, CSV or JSON file instead."
        ) from exc

    try:
        reader = PdfReader(io.BytesIO(raw))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001 - pypdf raises several types
                raise DatasetTextError(
                    f"{source} is password protected, so its text cannot be extracted."
                ) from exc
        pages = [(page.extract_text() or "") for page in reader.pages]
    except DatasetTextError:
        raise
    except Exception as exc:  # noqa: BLE001 - pypdf raises several types
        raise DatasetTextError(
            f"{source} could not be read as a PDF: {str(exc)[:200]}"
        ) from exc

    text = _join_chunks(pages)
    if not text.strip():
        raise DatasetTextError(
            f"{source} has no extractable text layer (it may be a scanned document). "
            "OCR is not supported — upload a text-based PDF or a TXT file."
        )
    return text


def extract_text(raw: bytes, file_name: str = "") -> str:
    """Return training text for ``raw`` bytes.

    Raises:
        DatasetTextError: when the format is unsupported or the content cannot
            be converted into genuine text.
    """
    if not raw:
        raise DatasetTextError("The stored dataset file is empty or could not be downloaded.")

    ext = _extension(file_name)
    source = os.path.basename(file_name) if file_name else "the uploaded file"

    if not ext:
        # No extension: sniff the payload rather than guessing.
        if _looks_like_pdf(raw):
            return _extract_pdf(raw, source)
        text = _decode_text(raw, source=source)
        stripped = text.lstrip()
        if stripped[:1] in "{[":
            try:
                return _extract_json(text, source)
            except DatasetTextError:
                return text
        return text

    if ext == "pdf":
        if not _looks_like_pdf(raw):
            raise DatasetTextError(
                f"{source} does not look like a PDF file (missing the %PDF header). Re-export it and upload again."
            )
        return _extract_pdf(raw, source)
    if ext in {"txt", "text", "md", "markdown"}:
        return _decode_text(raw, source=source)
    if ext == "csv":
        return _extract_csv(_decode_text(raw, source=source), source)
    if ext == "json":
        return _extract_json(_decode_text(raw, source=source), source)
    if ext in {"jsonl", "ndjson"}:
        return _extract_jsonl(_decode_text(raw, source=source), source)

    raise DatasetTextError(
        f"Unsupported dataset format '.{ext}'. Supported formats: {SUPPORTED_LABEL}."
    )


def is_supported_format(file_name: str) -> bool:
    return _extension(file_name) in SUPPORTED_FORMATS
