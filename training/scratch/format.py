"""
Compact training format for the from-scratch model.

The real app sends a ~1,000-character system prompt on every call. A 2.9M
CPU-trained model can't afford that context, so we train on a compact
canonical form that encodes exactly the same contract:

    [SCREEN] YouTube. Bottom tabs: Home, Shorts...      (optional)
    U: open youtube
    A: {"sentences":[{"text":"Okay! Opening YouTube.","emotion":"happy",...

Notes
-----
* Assistant JSON is emitted compactly (no spaces). This is still 100%
  schema-valid -- ``schema.validate_response`` accepts it.
* The model learns the *task*, not the preamble. At serving time the compact
  reply is expanded back into the full object the app expects.
* Keeping sequences short (~100-200 tokens) is what makes CPU training viable.
"""

from __future__ import annotations

import json

SCREEN_TAG = "[SCREEN] "
USER_TAG = "U: "
ASSIST_TAG = "A: "
END_TAG = "\n"
EOS = "<|end|>"


def compact(obj: dict) -> str:
    """Serialise an assistant payload in the exact compact form we train on.

    Key order is fixed so the model sees a consistent target:
    text, emotion, intensity, effect, style_prompt -- then tool_calls.
    """
    sents = []
    for s in obj["sentences"]:
        sents.append(
            {
                "text": s["text"],
                "emotion": s["emotion"],
                "intensity": s["intensity"],
                "effect": s.get("effect", "none"),
                "style_prompt": s.get("style_prompt", ""),
            }
        )
    out: dict = {"sentences": sents}
    if obj.get("tool_calls"):
        out["tool_calls"] = [
            {"name": c["name"], "arguments": c.get("arguments", {})}
            for c in obj["tool_calls"]
        ]
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def render_example(user_text: str, screen: str | None, assistant: dict) -> str:
    """One training example as a flat string."""
    parts: list[str] = []
    if screen:
        parts.append(SCREEN_TAG + screen.replace("\n", " "))
    parts.append(USER_TAG + user_text.replace("\n", " "))
    parts.append(ASSIST_TAG + compact(assistant))
    return "\n".join(parts)


def from_row(row: dict) -> str:
    """Convert a full-format dataset row (system/user/assistant) to compact."""
    user_content = row["messages"][1]["content"]
    assistant = json.loads(row["messages"][2]["content"])

    screen = None
    user_text = user_content
    marker = "[Foreground Screen UI]:"
    if marker in user_content:
        user_text, _, screen = user_content.partition(marker)
        user_text = user_text.strip()
        screen = screen.strip()

    return render_example(user_text, screen or None, assistant)


def build_corpus(path, limit: int | None = None) -> str:
    """Read a JSONL dataset and join all examples with EOS separators."""
    from pathlib import Path

    examples: list[str] = []
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            examples.append(from_row(json.loads(line)))
            if limit and len(examples) >= limit:
                break
    return EOS.join(examples) + EOS


def parse_reply(text: str) -> tuple[dict | None, str]:
    """Extract the JSON object from a generated reply.

    Returns (parsed_or_None, raw_json_substring). Tolerates trailing junk
    because a small model will occasionally run past the closing brace.
    """
    text = text.strip()
    start = text.find("{")
    if start == -1:
        return None, ""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                raw = text[start : i + 1]
                try:
                    return json.loads(raw), raw
                except json.JSONDecodeError:
                    return None, raw
    return None, text[start:]
