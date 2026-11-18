"""Knowledge distillation: teacher generation, validation and dataset conversion.

Design rules encoded here (they are contract, not documentation):

* **Provenance is mandatory.** Every stored example carries the provider, the
  model, the request id, the generation parameters and the validation result.
* **Nothing is auto-accepted as correct.** Each candidate is scored by explicit
  checks; the record's status is derived from those checks and a configurable
  threshold, and a human can override it.
* **Budgets are hard stops.** Requests, tokens and spend are counted per run and
  per day; when a cap is reached generation stops and the job says why.
* **No hidden reasoning is requested or stored.** Prompts ask for a final answer
  only; the validator rejects responses that look like leaked reasoning dumps.
* **Failures are recorded, never hidden.** A failed teacher call becomes a
  request row plus, when it produces a candidate, a rejected record with the
  reason.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import select, text

from app.core.models import (
    AiProviderConnection,
    AiTeacherModel,
    DistillationEvaluation,
    DistillationJob,
    DistillationRecord,
)
from app.services.providers import ChatMessage, ProviderError, ProviderRateLimitError, build_adapter
from app.services.providers.base import ProviderAdapter

# ---------------------------------------------------------------------------
# Task catalogue
# ---------------------------------------------------------------------------

TASK_TYPES: Dict[str, Dict[str, str]] = {
    "instruction": {
        "label": "Instruction following",
        "description": "Explain a concept or complete a task in a clear, educational way.",
    },
    "qa": {
        "label": "Question & answer",
        "description": "Answer a factual question precisely and correctly.",
    },
    "coding": {
        "label": "Coding",
        "description": "Write a correct, runnable code answer with a short explanation.",
    },
    "multilingual": {
        "label": "Multilingual",
        "description": "Produce the answer in the requested language.",
    },
    "summarization": {
        "label": "Summarization",
        "description": "Summarize the provided source text without adding facts.",
    },
    "classification": {
        "label": "Classification",
        "description": "Return a strict JSON object with the label and a short justification.",
    },
    "preference": {
        "label": "Preference pair",
        "description": "Return a better and a worse answer as strict JSON for preference training.",
    },
}

LANGUAGES = {
    "en": "English", "hi": "Hindi", "es": "Spanish", "fr": "French", "de": "German",
    "pt": "Portuguese", "ar": "Arabic", "zh": "Chinese", "ja": "Japanese", "ru": "Russian",
    "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "mr": "Marathi", "ur": "Urdu",
}

SUBJECTS = ["mathematics", "coding", "reasoning", "language", "science", "general knowledge"]

DIFFICULTIES = ["beginner", "intermediate", "advanced"]

# Teacher-selection modes (A-E). The description is what the UI shows; the key is
# what the runner switches on.
MODES: Dict[str, Dict[str, str]] = {
    "single": {
        "label": "A — Single teacher",
        "description": "One teacher model answers every prompt.",
    },
    "multi": {
        "label": "B — Multiple independent answers",
        "description": "Two or more teachers answer the same prompt independently; every answer is kept.",
    },
    "evaluator": {
        "label": "C — Teacher + evaluator",
        "description": "A teacher answers and a separate evaluator scores accuracy, relevance, completeness and instruction-following.",
    },
    "competition": {
        "label": "D — Competition",
        "description": "Several teachers compete; an evaluator picks the winner and rejects the others using your criteria.",
    },
    "specialized": {
        "label": "E — Specialised by domain",
        "description": "Each subject is routed to the teacher you assign to it (maths, coding, reasoning, language, science, general).",
    },
}

# The single source of truth for output formats lives in distillation_export; it
# is imported here so the job options and the exporter can never drift apart.
from app.services.distillation_export import FORMAT_LABELS, SUPPORTED_FORMATS  # noqa: E402

OUTPUT_FORMATS: Dict[str, str] = dict(FORMAT_LABELS)

# Refusal / apology patterns that mean "the teacher did not answer".
_REFUSAL_PATTERNS = re.compile(
    r"\b(i'?m sorry|i am sorry|i can'?t (help|assist|comply)|as an ai|i cannot (help|assist)|"
    r"i'?m unable to|i won'?t (help|answer)|cannot provide that)\b",
    re.IGNORECASE,
)
# Phrases that indicate the model dumped hidden reasoning instead of an answer.
_REASONING_LEAK = re.compile(
    r"(^\s*(let me|let's|first,? i|step 1:|chain[- ]of[- ]thought|internal reasoning|"
    r"my reasoning|analysis:|thinking:))",
    re.IGNORECASE | re.MULTILINE,
)

_SCRIPT_RANGES = {
    "latin": [(0x0041, 0x024F), (0x1E00, 0x1EFF)],
    "devanagari": [(0x0900, 0x097F)],
    "arabic": [(0x0600, 0x06FF), (0x0750, 0x077F)],
    "cyrillic": [(0x0400, 0x04FF)],
    "han": [(0x4E00, 0x9FFF), (0x3400, 0x4DBF)],
    "kana": [(0x3040, 0x30FF)],
    "bengali": [(0x0980, 0x09FF)],
    "tamil": [(0x0B80, 0x0BFF)],
    "telugu": [(0x0C00, 0x0C7F)],
}


def _script_of(char: str) -> Optional[str]:
    code = ord(char)
    for name, ranges in _SCRIPT_RANGES.items():
        for low, high in ranges:
            if low <= code <= high:
                return name
    return None


def detect_script(text_value: str) -> Optional[str]:
    """Dominant writing system of a text, or None when it has no letters."""
    counts: Dict[str, int] = {}
    for char in text_value or "":
        script = _script_of(char)
        if script:
            counts[script] = counts.get(script, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda item: item[1])[0]


SCRIPT_BY_LANGUAGE = {
    "en": "latin", "es": "latin", "fr": "latin", "de": "latin", "pt": "latin",
    "hi": "devanagari", "mr": "devanagari", "ar": "arabic", "ur": "arabic",
    "ru": "cyrillic", "zh": "han", "ja": "kana", "bn": "bengali",
    "ta": "tamil", "te": "telugu",
}


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are an expert teacher producing training data for a smaller student model. "
    "Answer with the final, self-contained explanation only. Do not include hidden "
    "reasoning, deliberation, or notes about your process. Be accurate: if you are "
    "not certain about a fact, say so explicitly instead of inventing details."
)


def build_prompt(task_type: str, *, source_text: str, subject: str, difficulty: str,
                 language: str, output_format: str, index: int) -> str:
    language_name = LANGUAGES.get(language, language)
    excerpt = (source_text or "").strip()
    if len(excerpt) > 4000:
        excerpt = excerpt[:4000]

    if task_type == "qa":
        return (
            f"Write one factual question about {subject} at {difficulty} level and answer it.\n"
            f"Use {language_name}. Base the question on this source material:\n\n{excerpt}\n\n"
            "Format exactly:\nQuestion: <question>\nAnswer: <answer>"
        )
    if task_type == "coding":
        return (
            f"Create one {difficulty} {subject} coding exercise with a correct solution.\n"
            f"Use {language_name} for the explanation. Source material:\n\n{excerpt}\n\n"
            "Format exactly:\nTask: <task statement>\nSolution:\n```<language>\n<code>\n```\nExplanation: <short explanation>"
        )
    if task_type == "summarization":
        return (
            f"Summarize the following source text in {language_name}, at {difficulty} level, "
            "in 3 to 5 sentences. Do not add facts that are not in the source.\n\n"
            f"{excerpt}\n\nFormat exactly:\nSummary: <summary>"
        )
    if task_type == "classification":
        return (
            f"Classify the following text into exactly one of these labels: "
            f"{(subject or 'general knowledge')}, mathematics, coding, science, language.\n"
            "Answer with strict JSON only, no code fences: "
            '{"label": "<label>", "confidence": <0-1>, "reason": "<one sentence>"}\n\n'
            f"Text:\n{excerpt}"
        )
    if task_type == "preference":
        return (
            f"Write one {difficulty} question about {subject} and two answers: a clearly better "
            f"answer and a clearly weaker answer (for example missing a step). Use {language_name}.\n"
            "Answer with strict JSON only, no code fences: "
            '{"prompt": "<question>", "chosen": "<better answer>", "rejected": "<weaker answer>"}'
        )
    if task_type == "multilingual":
        return (
            f"Explain one {difficulty} {subject} concept in {language_name} for a learner, "
            f"in 4 to 8 sentences. Base it on this source material where possible:\n\n{excerpt}"
        )
    # default: instruction following
    return (
        f"Write one {difficulty} instruction-response pair about {subject}, in {language_name}.\n"
        f"Source material (use it if relevant):\n\n{excerpt}\n\n"
        "Format exactly:\nInstruction: <the instruction>\nResponse: <the answer>"
    )


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

def normalise_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def content_hash(record: Dict[str, str]) -> str:
    payload = "||".join([
        normalise_text(record.get("instruction") or ""),
        normalise_text(record.get("input") or ""),
        normalise_text(record.get("target") or record.get("chosen") or ""),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def simhash64(value: str) -> int:
    """64-bit simhash of word shingles, for near-duplicate detection."""
    words = re.findall(r"\w+", normalise_text(value))
    if not words:
        return 0
    shingles = [" ".join(words[i:i + 3]) for i in range(max(1, len(words) - 2))]
    weights = [0] * 64
    for shingle in shingles:
        digest = hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest()
        value_int = int.from_bytes(digest, "big")
        for bit in range(64):
            weights[bit] += 1 if (value_int >> bit) & 1 else -1
    result = 0
    for bit in range(64):
        if weights[bit] > 0:
            result |= 1 << bit
    return result


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def to_signed_bigint(value: int) -> int:
    """PostgreSQL bigint is signed; keep the bit pattern stable."""
    return value - (1 << 64) if value >= (1 << 63) else value


def from_signed_bigint(value: Optional[int]) -> int:
    if value is None:
        return 0
    return value + (1 << 64) if value < 0 else value


def jaccard(a: str, b: str) -> float:
    def tokens(value: str) -> set:
        return set(re.findall(r"\w+", normalise_text(value)))
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

@dataclass
class Candidate:
    instruction: str = ""
    input: str = ""
    target: str = ""
    chosen: str = ""
    rejected: str = ""
    parse_error: Optional[str] = None

    def as_dict(self) -> Dict[str, str]:
        return {
            "instruction": self.instruction,
            "input": self.input,
            "target": self.target,
            "chosen": self.chosen,
            "rejected": self.rejected,
        }


def _strip_code_fences(value: str) -> str:
    text_value = (value or "").strip()
    if text_value.startswith("```"):
        text_value = re.sub(r"^```[a-zA-Z0-9_+-]*\s*", "", text_value)
        text_value = re.sub(r"```\s*$", "", text_value)
    return text_value.strip()


def parse_response(task_type: str, response_text: str) -> Candidate:
    body = (response_text or "").strip()
    if task_type == "preference":
        payload = _loads_json_object(body)
        if payload is None:
            return Candidate(parse_error="Expected a strict JSON object with prompt/chosen/rejected.")
        prompt = str(payload.get("prompt") or "").strip()
        chosen = str(payload.get("chosen") or "").strip()
        rejected = str(payload.get("rejected") or "").strip()
        if not (prompt and chosen and rejected):
            return Candidate(parse_error="Preference JSON is missing prompt, chosen or rejected.")
        return Candidate(instruction=prompt, chosen=chosen, rejected=rejected)
    if task_type == "classification":
        payload = _loads_json_object(body)
        if payload is None:
            return Candidate(parse_error="Expected a strict JSON object with label/confidence/reason.")
        label = str(payload.get("label") or "").strip()
        if not label:
            return Candidate(parse_error="Classification JSON has no label.")
        return Candidate(
            instruction="Classify the following text into one label.",
            input="",
            target=json.dumps({
                "label": label,
                "confidence": payload.get("confidence"),
                "reason": str(payload.get("reason") or "").strip(),
            }, ensure_ascii=False),
        )
    # line-oriented formats
    if task_type == "qa":
        question = _first_group(body, r"Question\s*:\s*(.+)")
        answer = _first_group(body, r"Answer\s*:\s*([\s\S]+)")
        if not question or not answer:
            return Candidate(parse_error="Expected 'Question:' and 'Answer:' sections.")
        return Candidate(instruction=question, target=answer)
    if task_type == "coding":
        task_text = _first_group(body, r"Task\s*:\s*(.+)")
        solution = _first_group(body, r"Solution\s*:\s*([\s\S]*?)(?:Explanation\s*:|$)")
        explanation = _first_group(body, r"Explanation\s*:\s*([\s\S]+)")
        code = _strip_code_fences(solution or "")
        if not task_text or not code:
            return Candidate(parse_error="Expected 'Task:' and a 'Solution:' code block.")
        target = code if not explanation else code + "\n\n" + explanation.strip()
        return Candidate(instruction=task_text, target=target)
    if task_type == "summarization":
        summary = _first_group(body, r"Summary\s*:\s*([\s\S]+)")
        if not summary:
            return Candidate(parse_error="Expected a 'Summary:' section.")
        return Candidate(instruction="Summarize the following text.", target=summary)
    instruction = _first_group(body, r"Instruction\s*:\s*(.+)")
    response = _first_group(body, r"Response\s*:\s*([\s\S]+)")
    if instruction and response:
        return Candidate(instruction=instruction, target=response)
    # Tolerate a plain answer: the prompt itself becomes the instruction.
    if len(body) >= 40 and not _REFUSAL_PATTERNS.search(body[:200]):
        return Candidate(instruction="", target=body)
    return Candidate(parse_error="The response did not contain an instruction/answer pair.")


def _first_group(value: str, pattern: str) -> str:
    match = re.search(pattern, value, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _loads_json_object(value: str) -> Optional[dict]:
    body = _strip_code_fences(value)
    try:
        payload = json.loads(body)
        return payload if isinstance(payload, dict) else None
    except Exception:
        pass
    start, end = body.find("{"), body.rfind("}")
    if start != -1 and end > start:
        try:
            payload = json.loads(body[start:end + 1])
            return payload if isinstance(payload, dict) else None
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

DEFAULT_QUALITY = {
    "min_quality_score": 0.6,
    "min_chars": 40,
    "max_chars": 12000,
    "near_duplicate_hamming": 3,
    "require_language_match": True,
    "detect_contradictions": True,
}


@dataclass
class ValidationResult:
    status: str                     # accepted | rejected | duplicate
    score: float
    checks: Dict[str, Any] = field(default_factory=dict)
    reasons: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "score": round(self.score, 4),
            "checks": self.checks,
            "reasons": self.reasons,
        }


def validate_candidate(candidate: Candidate, *, task_type: str, language: str,
                       config: Dict[str, Any], seen_hashes: Dict[str, str],
                       seen_simhashes: Sequence[Tuple[str, int]] = ()) -> ValidationResult:
    """Run the explicit quality checks. Deterministic and explainable."""
    cfg = {**DEFAULT_QUALITY, **(config or {})}
    resolution = candidate.target or candidate.chosen
    checks: Dict[str, Any] = {}
    reasons: List[str] = []

    def fail(reason: str, status: str = "rejected") -> ValidationResult:
        reasons.append(reason)
        return ValidationResult(status=status, score=0.0, checks=checks, reasons=reasons)

    if candidate.parse_error:
        checks["format_parse"] = {"ok": False, "detail": candidate.parse_error}
        return fail(candidate.parse_error)
    checks["format_parse"] = {"ok": True}

    if not (candidate.instruction or "").strip():
        return fail("The record has no instruction/prompt.")
    if not (resolution or "").strip():
        return fail("The record has no teacher answer.")
    if task_type == "preference" and not (candidate.rejected or "").strip():
        return fail("A preference pair needs both a chosen and a rejected answer.")

    text_len = len(resolution)
    checks["length"] = {"ok": cfg["min_chars"] <= text_len <= cfg["max_chars"], "chars": text_len}
    if text_len < cfg["min_chars"]:
        return fail(f"The answer is too short ({text_len} < {cfg['min_chars']} characters).")
    if text_len > cfg["max_chars"]:
        return fail(f"The answer is too long ({text_len} > {cfg['max_chars']} characters).")

    refusal = bool(_REFUSAL_PATTERNS.search(resolution[:400]))
    checks["refusal"] = {"ok": not refusal}
    if refusal:
        return fail("The teacher refused or deflected instead of answering.")

    leak = bool(_REASONING_LEAK.search(resolution))
    checks["no_hidden_reasoning"] = {"ok": not leak}
    if leak:
        return fail("The answer looks like a reasoning dump rather than a final answer.")

    # Repetition / degenerate output
    words = re.findall(r"\w+", resolution.lower())
    if len(words) >= 20:
        ratio = len(set(words)) / len(words)
        checks["lexical_diversity"] = {"ok": ratio >= 0.25, "ratio": round(ratio, 3)}
        if ratio < 0.25:
            return fail("The answer is degenerate (repeats the same words).")

    # Format-specific structural checks
    if task_type == "classification":
        try:
            payload = json.loads(resolution)
            ok = isinstance(payload, dict) and isinstance(payload.get("label"), str) and payload["label"]
        except Exception:
            ok = False
        checks["structured_json"] = {"ok": ok}
        if not ok:
            return fail("The classification answer is not a JSON object with a label.")
    if task_type == "coding":
        has_code = "```" in candidate.target or re.search(
            r"\b(def |class |function |const |let |import |return |print\()", candidate.target or ""
        )
        checks["contains_code"] = {"ok": bool(has_code)}
        if not has_code:
            return fail("The coding answer contains no code.")
    if task_type == "summarization":
        source_words = len(re.findall(r"\w+", candidate.input or ""))
        summary_words = len(words)
        ok = source_words == 0 or summary_words <= max(40, int(source_words * 0.9))
        checks["summary_shorter_than_source"] = {"ok": ok, "summary_words": summary_words}
        if not ok:
            return fail("The 'summary' is not shorter than the source text.")

    # Language validation by dominant script
    expected_script = SCRIPT_BY_LANGUAGE.get(language)
    detected = detect_script(resolution)
    checks["language"] = {
        "expected": language,
        "expected_script": expected_script,
        "detected_script": detected,
        "ok": (not cfg["require_language_match"]) or expected_script is None
              or detected is None or detected == expected_script,
    }
    if not checks["language"]["ok"]:
        return fail(
            "The answer is not written in the requested language "
            f"(expected {expected_script}, detected {detected})."
        )

    # Duplicate detection
    digest = content_hash(candidate.as_dict())
    checks["duplicate"] = {"exact": digest in seen_hashes, "near": False}
    if digest in seen_hashes:
        return fail("An identical record already exists in this run.", status="duplicate")
    candidate_simhash = simhash64(resolution)
    for other_id, other_hash in seen_simhashes:
        if hamming(candidate_simhash, other_hash) <= int(cfg["near_duplicate_hamming"]):
            checks["duplicate"] = {"exact": False, "near": True, "similar_to": other_id}
            return fail("A near-identical record already exists in this run.", status="duplicate")
    checks["duplicate"] = {"exact": False, "near": False}

    # Score: structural correctness dominates, length saturates quickly.
    length_score = min(1.0, text_len / max(1, cfg["min_chars"] * 4))
    diversity = checks.get("lexical_diversity", {}).get("ratio", 0.6)
    structure_bonus = 0.1 if task_type in {"classification", "coding", "preference"} else 0.0
    score = round(min(1.0, 0.55 + 0.25 * length_score + 0.2 * min(1.0, diversity / 0.6) + structure_bonus), 4)
    checks["structure_bonus"] = structure_bonus
    checks["score_components"] = {"length": round(length_score, 3), "diversity": round(diversity, 3)}

    if score < float(cfg["min_quality_score"]):
        reasons.append(
            f"The quality score {score:.2f} is below the configured minimum {float(cfg['min_quality_score']):.2f}."
        )
        return ValidationResult(status="rejected", score=score, checks=checks, reasons=reasons)

    return ValidationResult(status="accepted", score=score, checks=checks, reasons=reasons)


def analyse_disagreement(answers: Sequence[str]) -> Dict[str, Any]:
    """Compare independent teacher answers to the same prompt.

    This is a similarity analysis, not a truth verdict: it tells the operator
    where teachers disagree so those records can be reviewed by a human.
    """
    texts = [value for value in answers if isinstance(value, str) and value.strip()]
    if len(texts) < 2:
        return {"teachers": len(texts), "pairwise_similarity": [], "mean_similarity": None,
                "disagreement": None}
    pairs = []
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            pairs.append(round(jaccard(texts[i], texts[j]), 4))
    mean = sum(pairs) / len(pairs)
    return {
        "teachers": len(texts),
        "pairwise_similarity": pairs,
        "mean_similarity": round(mean, 4),
        "disagreement": round(1.0 - mean, 4),
    }


_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def detect_contradiction(a: str, b: str) -> Optional[str]:
    """Conservative contradiction heuristic between two answers to one prompt.

    Only compares numbers attached to the same word and explicit "not" flips of
    short claims; anything subtle is left to the evaluator teacher / human review.
    """
    numbers_a = set(_NUMBER.findall(a or ""))
    numbers_b = set(_NUMBER.findall(b or ""))
    if numbers_a and numbers_b and numbers_a.isdisjoint(numbers_b):
        return f"The answers state different numbers ({sorted(numbers_a)} vs {sorted(numbers_b)})."
    words_a = set(re.findall(r"\b[a-z]{4,}\b", (a or "").lower()))
    words_b = set(re.findall(r"\b[a-z]{4,}\b", (b or "").lower()))
    shared = words_a & words_b
    if len(shared) >= 6:
        neg_a = re.findall(r"\b(?:not|no|never|cannot)\b\s+(\w+)", (a or "").lower())
        neg_b = re.findall(r"\b(?:not|no|never|cannot)\b\s+(\w+)", (b or "").lower())
        flipped = {w for w in neg_a if w in words_b and w not in {x for x in neg_b}}
        if flipped:
            return f"The answers negate each other around: {', '.join(sorted(flipped)[:5])}."
    return None


# ---------------------------------------------------------------------------
# Prompt seeds from a source dataset
# ---------------------------------------------------------------------------

def build_prompt_seeds(source_text: str, *, count: int, task_types: Sequence[str],
                       subjects: Sequence[str], difficulties: Sequence[str]) -> List[Dict[str, str]]:
    """Deterministic prompt plan: every seed names task, subject and difficulty."""
    tasks = [task for task in task_types if task in TASK_TYPES] or ["instruction"]
    subject_list = [s for s in (subjects or SUBJECTS) if s] or SUBJECTS
    difficulty_list = [d for d in (difficulties or DIFFICULTIES) if d in DIFFICULTIES] or DIFFICULTIES
    seeds: List[Dict[str, str]] = []
    for index in range(max(0, int(count))):
        task = tasks[index % len(tasks)]
        subject = subject_list[(index // max(1, len(tasks))) % len(subject_list)]
        difficulty = difficulty_list[index % len(difficulty_list)]
        # Vary the excerpt so consecutive prompts are not identical.
        offset = (index * 733) % max(1, len(source_text) if source_text else 1)
        excerpt = (source_text or "")[offset:offset + 2500] or (source_text or "")[:2500]
        seeds.append({
            "task_type": task,
            "subject": subject,
            "difficulty": difficulty,
            "excerpt": excerpt.strip(),
        })
    return seeds


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------

DEFAULT_BUDGET = {
    "max_requests": 200,
    "max_tokens": 400_000,
    "max_spend_usd": 5.0,
    "max_concurrency": 4,
    "max_tokens_per_request": 1024,
    "max_requests_per_day": 0,     # 0 = no daily cap
    "max_spend_usd_per_day": 0.0,  # 0 = no daily cap
}


@dataclass
class BudgetState:
    limits: Dict[str, Any]
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    spend_usd: float = 0.0
    stop_reason: Optional[str] = None
    cost_unpriced_requests: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def exhausted(self) -> Optional[str]:
        if self.stop_reason:
            return self.stop_reason
        max_requests = int(self.limits.get("max_requests") or 0)
        if max_requests and self.requests >= max_requests:
            return f"The request budget of {max_requests} was reached."
        max_tokens = int(self.limits.get("max_tokens") or 0)
        if max_tokens and self.total_tokens >= max_tokens:
            return f"The token budget of {max_tokens} was reached."
        max_spend = float(self.limits.get("max_spend_usd") or 0)
        if max_spend and self.spend_usd >= max_spend:
            return f"The spend budget of ${max_spend:.2f} was reached."
        return self.stop_reason

    def as_dict(self) -> Dict[str, Any]:
        return {
            "requests": self.requests,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "spend_usd": round(self.spend_usd, 6),
            "cost_unpriced_requests": self.cost_unpriced_requests,
            "limits": self.limits,
            "stop_reason": self.stop_reason,
        }


def merge_budget(config: Optional[Dict[str, Any]], provider_budget: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged = dict(DEFAULT_BUDGET)
    for source in (provider_budget or {}, config or {}):
        for key, value in source.items():
            if value is None or value == "":
                continue
            merged[key] = value
    return merged


def compute_cost(usage, teacher: Optional[AiTeacherModel]) -> Optional[float]:
    """Cost from prices the owner/provider supplied. Unknown price -> None."""
    if teacher is None:
        return None
    in_price = teacher.input_price_per_million
    out_price = teacher.output_price_per_million
    if in_price is None and out_price is None:
        return None
    cost = 0.0
    if usage.input_tokens and in_price is not None:
        cost += (usage.input_tokens / 1_000_000.0) * float(in_price)
    if usage.output_tokens and out_price is not None:
        cost += (usage.output_tokens / 1_000_000.0) * float(out_price)
    return round(cost, 8)


class TeacherCallError(Exception):
    def __init__(self, message: str, *, code: str = "provider_error", retryable: bool = False,
                 retry_after: Optional[float] = None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.retry_after = retry_after


@dataclass
class TeacherSpec:
    provider_id: str
    provider_type: str
    provider_name: str
    model_id: str
    teacher_model: Optional[AiTeacherModel] = None
    role: str = "teacher"     # teacher | evaluator | verifier
    subject: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "provider_type": self.provider_type,
            "provider_name": self.provider_name,
            "model_id": self.model_id,
            "role": self.role,
            "subject": self.subject,
        }


async def call_teacher(adapter: ProviderAdapter, teacher: TeacherSpec, prompt: str, *,
                       temperature: float, max_tokens: int,
                       retries: int = 2, base_delay: float = 0.7) -> Tuple[Any, Optional[TeacherCallError], int]:
    """Call one teacher with bounded retries. Returns (result, error, attempts)."""
    attempt = 0
    last_error: Optional[TeacherCallError] = None
    while attempt <= retries:
        attempt += 1
        try:
            result = await adapter.chat(
                [ChatMessage(role="system", content=SYSTEM_PROMPT),
                 ChatMessage(role="user", content=prompt)],
                model=teacher.model_id,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            if not (result.text or "").strip():
                raise TeacherCallError("The teacher returned an empty answer.", code="empty_response",
                                       retryable=True)
            return result, None, attempt
        except ProviderRateLimitError as exc:
            last_error = TeacherCallError(str(exc), code="rate_limited", retryable=True,
                                          retry_after=exc.retry_after_seconds)
            delay = exc.retry_after_seconds or (base_delay * attempt)
            if attempt > retries:
                break
            await asyncio.sleep(min(30.0, max(0.1, delay)))
        except ProviderError as exc:
            last_error = TeacherCallError(str(exc), code=exc.code, retryable=exc.retryable,
                                          retry_after=exc.retry_after_seconds)
            if not exc.retryable or attempt > retries:
                break
            await asyncio.sleep(base_delay * attempt)
        except Exception as exc:  # unexpected -> report, do not retry blindly
            return None, TeacherCallError(str(exc)[:400], code="unexpected_error"), attempt
    return None, last_error or TeacherCallError("The teacher call failed.", code="unknown"), attempt


# ---------------------------------------------------------------------------
# Run orchestration
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


class DistillationRunner:
    """Executes one distillation job against the real provider adapters."""

    def __init__(self, *, session_factory, job: DistillationJob,
                 providers: Dict[str, AiProviderConnection],
                 teacher_models: Dict[Tuple[str, str], AiTeacherModel],
                 api_keys: Optional[Dict[str, str]] = None,
                 stop_event: Optional[asyncio.Event] = None,
                 transport=None, sleep=asyncio.sleep, now=_now_iso):
        self.session_factory = session_factory
        self.job = job
        self.providers = providers
        self.teacher_models = teacher_models
        self.transport = transport
        self.api_keys: Dict[str, str] = dict(api_keys or {})
        # Set by the API when the owner cancels; checked between seeds so a
        # cancellation never interleaves with an in-flight provider call.
        self.stop_event = stop_event or asyncio.Event()
        self.progress_errors: List[str] = []
        self._sleep = sleep
        self._now = now
        self.budget = BudgetState(limits=merge_budget(job.budget))
        self.stats = {
            "requested": 0, "generated": 0, "accepted": 0, "rejected": 0,
            "duplicates": 0, "failed_calls": 0, "rate_limited": 0,
            "evaluated": 0, "evaluator_rejected": 0,
        }
        self.seen_hashes: Dict[str, str] = {}
        self.seen_simhashes: List[Tuple[str, int]] = []
        self.request_log: List[Dict[str, Any]] = []
        # Filled by run() with decrypted keys for the providers this job uses.

    # -- helpers ---------------------------------------------------------
    def teacher_specs(self) -> Tuple[List[TeacherSpec], Optional[TeacherSpec], List[TeacherSpec], Dict[str, str]]:
        cfg = self.job.teacher_config or {}
        def build(entry: Dict[str, Any]) -> Optional[TeacherSpec]:
            provider_id = entry.get("provider_id")
            provider = self.providers.get(provider_id)
            if not provider:
                return None
            model_id = entry.get("model_id") or provider.default_teacher_model
            if not model_id:
                return None
            return TeacherSpec(
                provider_id=provider.id,
                provider_type=provider.provider_type,
                provider_name=provider.name,
                model_id=model_id,
                teacher_model=self.teacher_models.get((provider.id, model_id)),
                role=entry.get("role") or "teacher",
                subject=entry.get("subject"),
            )
        teachers = [spec for spec in (build(entry) for entry in cfg.get("teachers", []) or []) if spec]
        primary = build(cfg.get("primary") or {}) if cfg.get("primary") else (teachers[0] if teachers else None)
        evaluators = [spec for spec in (build(entry) for entry in cfg.get("evaluators", []) or []) if spec]
        subject_map: Dict[str, str] = {}
        for entry in cfg.get("subject_map", []) or []:
            if entry.get("subject") and entry.get("provider_id"):
                subject_map[str(entry["subject"]).lower()] = str(entry.get("provider_id"))
        return teachers, primary, evaluators, subject_map

    def _adapter(self, provider: AiProviderConnection, api_key: str) -> ProviderAdapter:
        return build_adapter(provider.provider_type, api_key, provider.base_url,
                             timeout=90.0, transport=self.transport)

    async def _daily_usage(self) -> Dict[str, float]:
        async with self.session_factory() as db:
            row = (await db.execute(text("""
                SELECT COUNT(*) AS requests,
                       COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS tokens,
                       COALESCE(SUM(estimated_cost), 0) AS spend
                FROM public.ai_provider_requests
                WHERE owner_id = :owner_id AND created_at >= now() - interval '1 day'
            """), {"owner_id": self.job.owner_id})).mappings().first()
        return {"requests": float(row["requests"] or 0), "tokens": float(row["tokens"] or 0),
                "spend": float(row["spend"] or 0)}

    async def _log_request(self, provider_id: str, model_id: str, status: str, *,
                           http_status: Optional[int] = None, input_tokens: Optional[int] = None,
                           output_tokens: Optional[int] = None, cached_tokens: Optional[int] = None,
                           cost: Optional[float] = None, latency_ms: Optional[int] = None,
                           error_code: Optional[str] = None) -> None:
        entry = {
            "provider_id": provider_id, "model_id": model_id, "status": status,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "cached_tokens": cached_tokens, "cost": cost, "latency_ms": latency_ms,
            "error_code": error_code,
        }
        self.request_log.append(entry)
        async with self.session_factory() as db:
            await db.execute(text("""
                INSERT INTO public.ai_provider_requests
                (owner_id, provider_id, job_id, model_id, status, http_status,
                 input_tokens, output_tokens, cached_tokens, estimated_cost, latency_ms, error_code)
                VALUES (:owner_id, :provider_id, :job_id, :model_id, :status, :http_status,
                        :input_tokens, :output_tokens, :cached_tokens, :estimated_cost,
                        :latency_ms, :error_code)
            """), {
                "owner_id": self.job.owner_id, "provider_id": provider_id, "job_id": self.job.id,
                "model_id": model_id, "status": status, "http_status": http_status,
                "input_tokens": input_tokens, "output_tokens": output_tokens,
                "cached_tokens": cached_tokens, "estimated_cost": cost,
                "latency_ms": latency_ms, "error_code": error_code,
            })
            await db.commit()

    async def _persist_progress(self, *, stage: Optional[str] = None) -> None:
        progress = {
            **self.stats,
            "budget": self.budget.as_dict(),
            "updated_at": self._now(),
        }
        async with self.session_factory() as db:
            await db.execute(text("""
                UPDATE public.distillation_jobs
                SET progress = CAST(:progress AS jsonb), status = COALESCE(:status, status),
                    updated_at = now()
                WHERE id = :job_id AND owner_id = :owner_id
            """), {
                "progress": json.dumps(progress), "status": stage,
                "job_id": self.job.id, "owner_id": self.job.owner_id,
            })
            await db.commit()

    async def _load_existing(self) -> None:
        async with self.session_factory() as db:
            rows = (await db.execute(text("""
                SELECT id, content_hash, simhash FROM public.distillation_records WHERE job_id = :job_id
            """), {"job_id": self.job.id})).mappings().all()
        for row in rows:
            if row["content_hash"]:
                self.seen_hashes[row["content_hash"]] = row["id"]
            if row["simhash"] is not None:
                self.seen_simhashes.append((row["id"], from_signed_bigint(int(row["simhash"]))))

    async def _store_record(self, *, candidate: Candidate, seed: Dict[str, str], teacher: TeacherSpec,
                            result: Any, validation: ValidationResult,
                            extra_checks: Optional[Dict[str, Any]] = None,
                            status_override: Optional[str] = None) -> str:
        record_id = "rec_" + uuid.uuid4().hex[:12]
        digest = content_hash(candidate.as_dict())
        resolution = candidate.target or candidate.chosen
        checks = dict(validation.checks)
        if extra_checks:
            checks.update(extra_checks)
        provenance = {
            "provider_id": teacher.provider_id,
            "provider_type": teacher.provider_type,
            "provider_name": teacher.provider_name,
            "model_id": result.model_id if result is not None else teacher.model_id,
            "request_id": getattr(result, "request_id", None),
            "created_at": self._now(),
            "usage": result.usage.as_dict() if result is not None else {},
            "finish_reason": getattr(result, "finish_reason", None),
            "generation": {
                "task_type": seed.get("task_type"),
                "subject": seed.get("subject"),
                "difficulty": seed.get("difficulty"),
                "language": seed.get("language"),
                "mode": self.job.mode,
                "system_prompt_sha256": hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:16],
            },
            "source_dataset_id": self.job.dataset_id,
            "source_excerpt_sha256": hashlib.sha256(
                (seed.get("excerpt") or "").encode("utf-8")).hexdigest()[:16],
            "teacher_role": teacher.role,
        }
        status = status_override or validation.status
        async with self.session_factory() as db:
            await db.execute(text("""
                INSERT INTO public.distillation_records
                (id, owner_id, job_id, instruction, input, target, chosen, rejected,
                 task_type, difficulty, language, subject, output_format,
                 provenance, validation, quality_score, content_hash, simhash, status,
                 reviewed_by_human)
                VALUES (:id, :owner_id, :job_id, :instruction, :input, :target, :chosen, :rejected,
                        :task_type, :difficulty, :language, :subject, :output_format,
                        CAST(:provenance AS jsonb), CAST(:validation AS jsonb), :quality_score,
                        :content_hash, :simhash, :status, false)
            """), {
                "id": record_id, "owner_id": self.job.owner_id, "job_id": self.job.id,
                "instruction": candidate.instruction or None,
                "input": candidate.input or None,
                "target": candidate.target or None,
                "chosen": candidate.chosen or None,
                "rejected": candidate.rejected or None,
                "task_type": seed.get("task_type"),
                "difficulty": seed.get("difficulty"),
                "language": seed.get("language"),
                "subject": seed.get("subject"),
                "output_format": seed.get("output_format"),
                "provenance": json.dumps(provenance),
                "validation": json.dumps(validation.as_dict()),
                "quality_score": validation.score,
                "content_hash": digest,
                "simhash": to_signed_bigint(simhash64(resolution)),
                "status": status,
            })
            await db.commit()
        self.seen_hashes[digest] = record_id
        self.seen_simhashes.append((record_id, simhash64(resolution)))
        return record_id

    async def _evaluate(self, *, evaluator: TeacherSpec, api_key: str, seed: Dict[str, str],
                        candidate: Candidate, record_id: str) -> Optional[Dict[str, Any]]:
        prompt = (
            "You are a strict reviewer of training data. Score the answer on four criteria from 0 to 1.\n"
            'Return strict JSON only: {"accuracy": <0-1>, "relevance": <0-1>, "completeness": <0-1>, '
            '"instruction_following": <0-1>, "verdict": "accept"|"reject", "rationale": "<one sentence>"}\n\n'
            f"INSTRUCTION:\n{candidate.instruction}\n\nANSWER:\n{(candidate.target or candidate.chosen)[:6000]}"
        )
        adapter = self._adapter(self.providers[evaluator.provider_id], api_key)
        result, error, _attempts = await call_teacher(
            adapter, evaluator, prompt, temperature=0.0,
            max_tokens=int(self.budget.limits.get("max_tokens_per_request") or 512),
        )
        if error or result is None:
            await self._log_request(evaluator.provider_id, evaluator.model_id, "error",
                                    error_code=error.code if error else "unknown")
            return None
        cost = compute_cost(result.usage, evaluator.teacher_model)
        await self._log_request(
            evaluator.provider_id, evaluator.model_id, "success",
            input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens,
            cached_tokens=result.usage.cached_tokens, cost=cost, latency_ms=result.latency_ms,
        )
        self.budget.requests += 1
        self.budget.input_tokens += int(result.usage.input_tokens or 0)
        self.budget.output_tokens += int(result.usage.output_tokens or 0)
        if cost is None:
            self.budget.cost_unpriced_requests += 1
        else:
            self.budget.spend_usd += cost

        payload = _loads_json_object(result.text)
        scores: Dict[str, Any] = {}
        verdict = None
        rationale = None
        if payload:
            for key in ("accuracy", "relevance", "completeness", "instruction_following"):
                value = payload.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    scores[key] = max(0.0, min(1.0, float(value)))
            verdict = str(payload.get("verdict") or "").lower() or None
            rationale = str(payload.get("rationale") or "").strip() or None
        else:
            rationale = "The evaluator did not return the requested JSON; its verdict was not used."
        mean = round(sum(scores.values()) / len(scores), 4) if scores else None
        async with self.session_factory() as db:
            await db.execute(text("""
                INSERT INTO public.distillation_evaluations
                (id, owner_id, job_id, record_id, evaluator_provider_id, evaluator_model_id,
                 scores, verdict, rationale, usage)
                VALUES (:id, :owner_id, :job_id, :record_id, :provider_id, :model_id,
                        CAST(:scores AS jsonb), :verdict, :rationale, CAST(:usage AS jsonb))
            """), {
                "id": "eval_" + uuid.uuid4().hex[:10], "owner_id": self.job.owner_id,
                "job_id": self.job.id, "record_id": record_id,
                "provider_id": evaluator.provider_id, "model_id": result.model_id,
                "scores": json.dumps({**scores, "mean": mean}), "verdict": verdict,
                "rationale": rationale, "usage": json.dumps(result.usage.as_dict()),
            })
            await db.commit()
        self.stats["evaluated"] += 1
        return {"scores": scores, "mean": mean, "verdict": verdict, "rationale": rationale,
                "evaluator": evaluator.as_dict()}

    async def _generate_for_seed(self, seed: Dict[str, str], teachers: List[TeacherSpec],
                                 primary: Optional[TeacherSpec], evaluators: List[TeacherSpec],
                                 subject_map: Dict[str, str]) -> None:
        stop = self.budget.exhausted()
        if stop:
            self.budget.stop_reason = stop
            return

        # Which teachers answer this seed?
        if self.job.mode == "single":
            chosen = [primary] if primary else teachers[:1]
        elif self.job.mode == "specialized":
            subject_key = (seed.get("subject") or "").lower()
            provider_id = subject_map.get(subject_key)
            specific = [t for t in teachers if provider_id and t.provider_id == provider_id]
            chosen = specific or ([primary] if primary else teachers[:1])
        else:
            chosen = list(teachers) or ([primary] if primary else [])

        if not chosen:
            self.stats["failed_calls"] += 1
            return

        language = seed.get("language") or "en"
        prompt = build_prompt(
            seed.get("task_type", "instruction"),
            source_text=seed.get("excerpt", ""),
            subject=seed.get("subject", "general knowledge"),
            difficulty=seed.get("difficulty", "beginner"),
            language=language,
            output_format=seed.get("output_format", "chat_jsonl"),
            index=0,
        )
        self.stats["requested"] += 1

        answers: List[Tuple[TeacherSpec, Any, Candidate, ValidationResult, str]] = []
        max_request_tokens = int(self.budget.limits.get("max_tokens_per_request") or 1024)
        for teacher in chosen:
            if self.budget.exhausted():
                self.budget.stop_reason = self.budget.exhausted()
                break
            provider = self.providers.get(teacher.provider_id)
            if provider is None:
                continue
            api_key = self.api_keys.get(provider.id)
            if not api_key:
                self.stats["failed_calls"] += 1
                continue
            adapter = self._adapter(provider, api_key)
            result, error, attempts = await call_teacher(
                adapter, teacher, prompt, temperature=float(
                    (self.job.generation_config or {}).get("temperature", 0.7)),
                max_tokens=max_request_tokens,
                retries=int((self.job.generation_config or {}).get("max_retries", 2)),
            )
            if error is not None or result is None:
                self.stats["failed_calls"] += 1
                if error and error.code == "rate_limited":
                    self.stats["rate_limited"] += 1
                await self._log_request(teacher.provider_id, teacher.model_id, "error",
                                        error_code=error.code if error else "unknown")
                continue
            cost = compute_cost(result.usage, teacher.teacher_model)
            await self._log_request(
                teacher.provider_id, teacher.model_id, "success",
                input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens,
                cached_tokens=result.usage.cached_tokens, cost=cost, latency_ms=result.latency_ms,
            )
            self.budget.requests += 1
            self.budget.input_tokens += int(result.usage.input_tokens or 0)
            self.budget.output_tokens += int(result.usage.output_tokens or 0)
            if cost is None:
                self.budget.cost_unpriced_requests += 1
            else:
                self.budget.spend_usd += cost

            candidate = parse_response(seed.get("task_type", "instruction"), result.text)
            validation = validate_candidate(
                candidate, task_type=seed.get("task_type", "instruction"), language=language,
                config=self.job.quality_config or {}, seen_hashes=self.seen_hashes,
                seen_simhashes=self.seen_simhashes,
            )
            self.stats["generated"] += 1
            answers.append((teacher, result, candidate, validation, language))

        if not answers:
            return

        # Disagreement analysis across independent teacher answers
        disagreement = analyse_disagreement([entry[2].target or entry[2].chosen for entry in answers])
        contradiction = None
        if len(answers) >= 2 and (self.job.quality_config or {}).get("detect_contradictions", True):
            contradiction = detect_contradiction(
                answers[0][2].target or answers[0][2].chosen,
                answers[1][2].target or answers[1][2].chosen,
            )

        evaluator = evaluators[0] if evaluators else None
        winner_index: Optional[int] = None
        evaluator_verdicts: List[Dict[str, Any]] = []

        # Mode C/D: one evaluator (or more) judges the answers.
        if evaluator and self.job.mode in {"evaluator", "competition"}:
            api_key = self.api_keys.get(evaluator.provider_id)
            primary_entry = answers[0]
            record_for_eval_id = None
            if api_key:
                # Evaluate the best valid answer (competition) or the first (evaluator mode).
                candidates = [i for i, entry in enumerate(answers) if entry[3].status == "accepted"] or [0]
                if self.job.mode == "competition":
                    scored = []
                    for index in candidates:
                        teacher, result, cand, _validation, _lang = answers[index]
                        # Persist first so the evaluation has a record to point at.
                        pre_status = "pending"
                        record_id = await self._store_record(
                            candidate=cand, seed=seed, teacher=teacher, result=result,
                            validation=_validation, status_override=pre_status,
                            extra_checks={"disagreement": disagreement, "contradiction": contradiction,
                                          "mode": self.job.mode},
                        )
                        verdict = await self._evaluate(evaluator=evaluator, api_key=api_key, seed=seed,
                                                       candidate=cand, record_id=record_id)
                        evaluator_verdicts.append({"record_id": record_id, **(verdict or {})})
                        if verdict and verdict.get("mean") is not None:
                            scored.append((float(verdict["mean"]), index, record_id))
                    chosen_index = None
                    if scored:
                        scored.sort(reverse=True)
                        best_score, chosen_index, best_record = scored[0]
                        winner_index = chosen_index
                        for _score, index, record_id in scored:
                            final = "accepted" if index == chosen_index and best_score >= float(
                                (self.job.quality_config or {}).get("min_evaluator_score", 0.6)
                            ) else "rejected"
                            await self._set_record_status(record_id, final,
                                                          note="competition winner" if final == "accepted"
                                                          else "competition: lower evaluator score")
                            if final == "accepted":
                                self.stats["accepted"] += 1
                            else:
                                self.stats["rejected"] += 1
                                self.stats["evaluator_rejected"] += 1
                    # No usable verdicts: the records stay pending for human review
                    # rather than being accepted on an evaluator that failed.
                    return
                # evaluator mode: single primary answer judged by the evaluator
                record_id = await self._store_record(
                    candidate=primary_entry[2], seed=seed, teacher=primary_entry[0],
                    result=primary_entry[1], validation=primary_entry[3],
                    extra_checks={"disagreement": disagreement, "contradiction": contradiction},
                )
                verdict = await self._evaluate(evaluator=evaluator, api_key=api_key, seed=seed,
                                               candidate=primary_entry[2], record_id=record_id)
                if verdict and verdict.get("mean") is not None:
                    threshold = float((self.job.quality_config or {}).get("min_evaluator_score", 0.6))
                    if verdict.get("mean", 0) >= threshold and verdict.get("verdict") != "reject":
                        await self._set_record_status(record_id, "accepted", note="evaluator accepted")
                        self.stats["accepted"] += 1
                    else:
                        await self._set_record_status(
                            record_id, "rejected",
                            note="evaluator score below threshold or verdict=reject")
                        self.stats["rejected"] += 1
                        self.stats["evaluator_rejected"] += 1
                return

        # Modes A/B (and evaluation failures): store every candidate.
        for teacher, result, cand, validation, _lang in answers:
            await self._store_record(
                candidate=cand, seed=seed, teacher=teacher, result=result, validation=validation,
                extra_checks={"disagreement": disagreement, "contradiction": contradiction,
                              "mode": self.job.mode},
            )
            if validation.status == "accepted":
                self.stats["accepted"] += 1
            elif validation.status == "duplicate":
                self.stats["duplicates"] += 1
            else:
                self.stats["rejected"] += 1

    async def _set_record_status(self, record_id: str, status: str, *, note: Optional[str] = None) -> None:
        async with self.session_factory() as db:
            await db.execute(text("""
                UPDATE public.distillation_records
                SET status = :status,
                    validation = COALESCE(validation, '{}'::jsonb) || CAST(:patch AS jsonb)
                WHERE id = :record_id AND owner_id = :owner_id
            """), {
                "status": status, "record_id": record_id, "owner_id": self.job.owner_id,
                "patch": json.dumps({"status": status, "note": note}),
            })
            await db.commit()

    # -- entry point -----------------------------------------------------
    async def run(self, api_keys: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        if api_keys is not None:
            self.api_keys = dict(api_keys)
        teachers, primary, evaluators, subject_map = self.teacher_specs()
        if not teachers and not primary:
            raise TeacherCallError(
                "No usable teacher is configured for this job: add a provider, verify it and pick a model.",
                code="no_teacher",
            )

        generation = self.job.generation_config or {}
        count = int(generation.get("count") or 10)
        max_examples = 200
        try:
            from app.config import settings
            max_examples = int(getattr(settings, "DISTILLATION_MAX_EXAMPLES_PER_RUN", 200) or 200)
        except Exception:
            pass
        count = max(1, min(count, max_examples))

        languages = generation.get("languages") or ["en"]
        subjects = generation.get("subjects") or SUBJECTS
        difficulties = generation.get("difficulties") or DIFFICULTIES
        task_types = generation.get("task_types") or ["instruction"]
        output_format = generation.get("output_format") or "chat_jsonl"
        source_text = generation.get("source_text") or ""

        daily = await self._daily_usage()
        provider_budget = {}
        for provider in self.providers.values():
            provider_budget = merge_budget(provider_budget, provider.budget or {})
        self.budget.limits = merge_budget(self.budget.limits, provider_budget)
        max_spend_day = float(self.budget.limits.get("max_spend_usd_per_day") or 0)
        max_requests_day = int(self.budget.limits.get("max_requests_per_day") or 0)
        if max_spend_day and daily["spend"] >= max_spend_day:
            self.budget.stop_reason = (
                f"The daily spend cap of ${max_spend_day:.2f} is already reached "
                f"(${daily['spend']:.2f} used in the last 24 h).")
            await self._persist_progress(stage="review")
            return self.report()
        if max_requests_day and daily["requests"] >= max_requests_day:
            self.budget.stop_reason = (
                f"The daily request cap of {max_requests_day} is already reached "
                f"({int(daily['requests'])} used in the last 24 h).")
            await self._persist_progress(stage="review")
            return self.report()

        seeds = build_prompt_seeds(
            source_text, count=count, task_types=task_types, subjects=subjects,
            difficulties=difficulties,
        )
        for index, seed in enumerate(seeds):
            seed["language"] = languages[index % len(languages)]
            seed["output_format"] = output_format

        await self._load_existing()
        await self._persist_progress(stage="generating")

        concurrency = max(1, min(int(self.budget.limits.get("max_concurrency") or 4), 8))
        semaphore = asyncio.Semaphore(concurrency)
        progress_every = 5
        completed_counter = {"value": 0}

        async def worker(seed: Dict[str, str]) -> None:
            async with semaphore:
                if self.stop_event.is_set():
                    return
                exhausted = self.budget.exhausted()
                if exhausted:
                    # Record why no further work happened, so the review screen can
                    # say "stopped by budget" instead of looking incomplete.
                    if not self.budget.stop_reason:
                        self.budget.stop_reason = exhausted
                    return
                try:
                    await self._generate_for_seed(seed, teachers, primary, evaluators, subject_map)
                except Exception as exc:  # a single seed must never kill the run
                    self.stats["failed_calls"] += 1
                    self.progress_errors.append(str(exc)[:200])
                completed_counter["value"] += 1
                if completed_counter["value"] % progress_every == 0:
                    await self._persist_progress()

        await asyncio.gather(*(worker(seed) for seed in seeds))
        if self.stop_event.is_set():
            final_stage = "cancelled"
        elif (self.job.teacher_config or {}).get("auto_complete"):
            final_stage = "completed"
        else:
            final_stage = "review"
        await self._persist_progress(stage=final_stage)
        async with self.session_factory() as db:
            await db.execute(text("""
                UPDATE public.distillation_jobs
                SET completed_at = now(), updated_at = now(),
                    error = CASE WHEN :stage = 'cancelled'
                                 THEN 'Stopped by the owner.' ELSE NULL END
                WHERE id = :job_id AND owner_id = :owner_id
            """), {"job_id": self.job.id, "owner_id": self.job.owner_id,
                    "stage": final_stage})
            await db.commit()
        return self.report()

    def report(self) -> Dict[str, Any]:
        return {
            "job_id": self.job.id,
            "stats": dict(self.stats),
            "budget": self.budget.as_dict(),
            "requests": len(self.request_log),
            "errors": list(self.progress_errors),
        }


async def run_distillation_job(job_id: str, owner_id: str, *, session_factory=None,
                               transport=None,
                               stop_event: Optional[asyncio.Event] = None) -> Dict[str, Any]:
    """Load a job, decrypt its provider keys in-process and run the pipeline."""
    from app.core.database import get_session_factory
    from app.services.crypto import CredentialError, decrypt_secret

    factory = session_factory or get_session_factory()
    async with factory() as db:
        job = (await db.execute(select(DistillationJob).where(
            DistillationJob.id == job_id))).scalar_one_or_none()
        if job is None or str(job.owner_id) != str(owner_id):
            raise TeacherCallError("Distillation job not found for this account.", code="not_found")
        provider_ids = set()
        cfg = job.teacher_config or {}
        for entry in (cfg.get("teachers") or []) + (cfg.get("evaluators") or []) + (
                [cfg.get("primary")] if cfg.get("primary") else []):
            if isinstance(entry, dict) and entry.get("provider_id"):
                provider_ids.add(entry["provider_id"])
        providers = {}
        if provider_ids:
            rows = (await db.execute(select(AiProviderConnection).where(
                AiProviderConnection.id.in_(provider_ids),
                AiProviderConnection.owner_id == job.owner_id,
            ))).scalars().all()
            providers = {row.id: row for row in rows}
        teacher_models = {}
        if providers:
            model_rows = (await db.execute(select(AiTeacherModel).where(
                AiTeacherModel.provider_id.in_(list(providers)))
            )).scalars().all()
            teacher_models = {(row.provider_id, row.model_id): row for row in model_rows}
        job.status = "generating"
        from datetime import datetime, timezone
        job.started_at = job.started_at or datetime.now(timezone.utc)
        await db.commit()

    api_keys: Dict[str, str] = {}
    for provider_id, provider in providers.items():
        if not provider.enabled:
            continue
        try:
            api_keys[provider_id] = decrypt_secret(provider.credential_ciphertext)
        except CredentialError as exc:
            raise TeacherCallError(
                f"The stored credential for '{provider.name}' could not be used: {exc}",
                code="credential_unavailable",
            ) from exc

    runner = DistillationRunner(
        session_factory=factory, job=job, providers=providers,
        teacher_models=teacher_models, api_keys=api_keys,
        stop_event=stop_event, transport=transport,
    )
    try:
        report = await runner.run()
    except TeacherCallError as exc:
        async with factory() as db:
            await db.execute(text("""
                UPDATE public.distillation_jobs
                SET status = 'failed', error = :error, updated_at = now()
                WHERE id = :job_id AND owner_id = :owner_id
            """), {"error": str(exc)[:500], "job_id": job_id, "owner_id": owner_id})
            await db.commit()
        raise
    except Exception as exc:
        async with factory() as db:
            await db.execute(text("""
                UPDATE public.distillation_jobs
                SET status = 'failed', error = :error, updated_at = now()
                WHERE id = :job_id AND owner_id = :owner_id
            """), {"error": ("Unexpected failure: " + str(exc))[:500],
                    "job_id": job_id, "owner_id": owner_id})
            await db.commit()
        raise
    return report
