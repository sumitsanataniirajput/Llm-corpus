"""Convert approved distillation records into training formats and splits.

Everything here is pure: it takes rows the caller already read and returns plain
dicts. No database access, no provider access, so the same code is used by the
export endpoint, the training-dataset writer and the tests.

Rules that matter:

* Only records with ``status == "accepted"`` are ever converted (``format_records``
  filters defensively, so a bug upstream cannot leak a rejected answer into a
  training file).
* A record without a usable answer (no target/chosen, or empty after trimming) is
  skipped and counted, never silently turned into an empty example.
* Preference pairs need a rejected answer; without one the record is skipped.
* Splits are deterministic from the record id, so re-exporting the same records
  with the same ratios produces the same split.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

SUPPORTED_FORMATS: Tuple[str, ...] = (
    "chat_jsonl",       # conversational JSONL: {"messages": [...]}
    "alpaca",           # instruction/input/output
    "qa",               # question/answer
    "classification",   # text/label
    "preference_pairs", # prompt/chosen/rejected
)

FORMAT_LABELS: Dict[str, str] = {
    "chat_jsonl": "Conversational JSONL (messages)",
    "alpaca": "Instruction — Alpaca JSONL",
    "qa": "Question / answer JSONL",
    "classification": "Classification JSONL",
    "preference_pairs": "Preference pairs JSONL (DPO)",
}

_SPLIT_NAMES = ("train", "validation", "test")


def _answer_of(record: Dict[str, Any]) -> str:
    value = record.get("target") or record.get("chosen") or ""
    return str(value).strip()


def _prompt_of(record: Dict[str, Any]) -> str:
    instruction = str(record.get("instruction") or "").strip()
    input_value = str(record.get("input") or "").strip()
    if instruction and input_value:
        return f"{instruction}\n\n{input_value}"
    return instruction or input_value


def record_to_example(record: Dict[str, Any], output_format: str) -> Optional[Dict[str, Any]]:
    """Convert one accepted record, or return ``None`` when it cannot be trained on."""
    answer = _answer_of(record)
    prompt = _prompt_of(record)
    language = record.get("language") or "en"
    task_type = record.get("task_type") or "instruction"

    if output_format == "preference_pairs":
        rejected = str(record.get("rejected") or "").strip()
        if not prompt or not answer or not rejected:
            return None
        return {
            "prompt": prompt,
            "chosen": answer,
            "rejected": rejected,
            "language": language,
            "task_type": task_type,
            "record_id": record.get("id"),
        }

    if not prompt or not answer:
        return None

    if output_format == "alpaca":
        return {
            "instruction": str(record.get("instruction") or prompt).strip(),
            "input": str(record.get("input") or "").strip(),
            "output": answer,
            "language": language,
            "task_type": task_type,
            "record_id": record.get("id"),
        }

    if output_format == "qa":
        return {
            "question": prompt,
            "answer": answer,
            "language": language,
            "task_type": task_type,
            "record_id": record.get("id"),
        }

    if output_format == "classification":
        text_value = str(record.get("input") or record.get("instruction") or "").strip()
        if not text_value:
            return None
        return {
            "text": text_value,
            "label": answer,
            "language": language,
            "task_type": task_type,
            "record_id": record.get("id"),
        }

    # Default: conversational JSONL, which is what the HF/PEFT SFT path consumes.
    messages: List[Dict[str, str]] = [
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": answer},
    ]
    return {
        "messages": messages,
        "language": language,
        "task_type": task_type,
        "record_id": record.get("id"),
    }


def split_of(record_id: str, ratios: Dict[str, float]) -> str:
    """Deterministic split assignment from the record id."""
    digest = hashlib.sha256(str(record_id).encode("utf-8")).digest()
    point = int.from_bytes(digest[:8], "big") / float(1 << 64)
    train = float(ratios.get("train", 0.8))
    validation = float(ratios.get("validation", ratios.get("val", 0.1)))
    if point < train:
        return "train"
    if point < train + validation:
        return "validation"
    return "test"


def format_records(
    records: Iterable[Dict[str, Any]],
    output_format: str = "chat_jsonl",
    *,
    splits: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Build the export payload plus an honest accounting of what was skipped."""
    if output_format not in SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported output format '{output_format}'. Choose one of: {', '.join(SUPPORTED_FORMATS)}."
        )
    ratios = splits or {"train": 0.8, "validation": 0.1, "test": 0.1}
    buckets: Dict[str, List[Dict[str, Any]]] = {name: [] for name in _SPLIT_NAMES}
    skipped: List[Dict[str, Any]] = []
    seen_ids: set = set()

    for record in records:
        if "status" in record and record.get("status") != "accepted":
            continue
        record_id = str(record.get("id") or "")
        if not record_id or record_id in seen_ids:
            continue
        example = record_to_example(record, output_format)
        if example is None:
            skipped.append({
                "record_id": record_id,
                "reason": ("This record has no rejected answer, so it cannot form a preference pair."
                           if output_format == "preference_pairs"
                           else "This record has no usable prompt or answer after trimming."),
            })
            continue
        seen_ids.add(record_id)
        buckets[split_of(record_id, ratios)].append(example)

    counts = {name: len(items) for name, items in buckets.items()}
    return {
        "format": output_format,
        "format_label": FORMAT_LABELS.get(output_format, output_format),
        "splits": ratios,
        "counts": {**counts, "total": sum(counts.values()), "skipped": len(skipped)},
        "examples": buckets,
        "skipped": skipped,
    }


def to_jsonl_lines(rows: Sequence[Dict[str, Any]]) -> str:
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def conversion_report(records: Sequence[Dict[str, Any]], output_format: str,
                      splits: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Stats-only view used by the review screen before anything is written."""
    payload = format_records(records, output_format, splits=splits)
    payload.pop("examples", None)
    return payload
