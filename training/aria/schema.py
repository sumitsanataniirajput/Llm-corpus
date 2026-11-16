"""
Single source of truth for Aria's output contract.

Everything here is mirrored from the Android app so that a fine-tuned model
produces output the app can parse without changes:

  - emotions / effects  -> app/src/main/java/com/example/model/AriaModels.kt
  - tool names + args   -> UnifiedLLMClient.buildOpenAITools()
  - direct intents      -> AriaAgentLoop.executeDirectIntent()

If you change the app, change this file too (and regenerate the dataset).
"""

from __future__ import annotations

from typing import Any

# --- Output contract -------------------------------------------------------

#: AriaEmotion labels, in the order the app declares them.
EMOTIONS = [
    "happy",
    "excited",
    "shy",
    "sad",
    "angry",
    "annoyed",
    "surprised",
    "scared",
    "curious",
    "sleepy",
    "proud",
    "neutral",
]

#: Allowed `effect` values (optional field, defaults to "none").
EFFECTS = ["laugh", "sigh", "pause_short", "pause_long", "none"]

#: `direct_intent.action` values the app will actually dispatch.
DIRECT_INTENTS = [
    "call",
    "sms",
    "whatsapp",
    "alarm",
    "timer",
    "calendar",
    "navigation",
    "music",
    "flashlight",
    "wifi_panel",
    "settings",
]

#: Intents that the app gates behind a spoken confirmation. The model must
#: never type these out silently as if they already happened.
SENSITIVE_INTENTS = {"call", "sms"}

#: Tool schemas: name -> {arg: type}. "string" | "number".
#: Mirrors buildOpenAITools() exactly.
TOOLS: dict[str, dict[str, str]] = {
    "tap": {"element": "string", "x": "number", "y": "number"},
    "swipe": {"direction": "string"},
    "type_text": {"text": "string"},
    "press_back": {},
    "press_home": {},
    "open_app": {"name": "string"},
    "direct_intent": {"action": "string", "target": "string", "content": "string"},
    "finish": {"summary": "string"},
}

#: Tools that take no arguments and therefore must not receive any.
NO_ARG_TOOLS = {"press_back", "press_home"}


# --- Validation ------------------------------------------------------------


def validate_response(payload: Any) -> list[str]:
    """Validate a parsed Aria response object.

    Accepts the object shape the app expects::

        {"sentences": [...], "tool_calls": [...]}

    ``tool_calls`` is optional. Returns a list of human-readable errors;
    an empty list means the payload is valid.
    """
    errors: list[str] = []

    if not isinstance(payload, dict):
        return [f"top level must be a JSON object, got {type(payload).__name__}"]

    sentences = payload.get("sentences")
    if sentences is None:
        errors.append("missing required key 'sentences'")
    elif not isinstance(sentences, list):
        errors.append("'sentences' must be a list")
    elif len(sentences) == 0:
        errors.append("'sentences' must not be empty")
    else:
        for i, s in enumerate(sentences):
            errors.extend(_validate_sentence(i, s))

    if "tool_calls" in payload:
        calls = payload["tool_calls"]
        if not isinstance(calls, list):
            errors.append("'tool_calls' must be a list")
        else:
            for i, c in enumerate(calls):
                errors.extend(_validate_tool_call(i, c))

    extra = set(payload) - {"sentences", "tool_calls"}
    if extra:
        errors.append(f"unexpected top-level keys: {sorted(extra)}")

    return errors


def _validate_sentence(i: int, s: Any) -> list[str]:
    errs: list[str] = []
    where = f"sentences[{i}]"

    if not isinstance(s, dict):
        return [f"{where} must be an object"]

    text = s.get("text")
    if not isinstance(text, str) or not text.strip():
        errs.append(f"{where}.text must be a non-empty string")

    emotion = s.get("emotion")
    if emotion is None:
        errs.append(f"{where} missing 'emotion'")
    elif emotion not in EMOTIONS:
        errs.append(f"{where}.emotion {emotion!r} not in {EMOTIONS}")

    intensity = s.get("intensity")
    if intensity is None:
        errs.append(f"{where} missing 'intensity'")
    elif not isinstance(intensity, int) or isinstance(intensity, bool):
        errs.append(f"{where}.intensity must be an integer")
    elif not 1 <= intensity <= 3:
        errs.append(f"{where}.intensity must be 1..3, got {intensity}")

    if "effect" in s and s["effect"] not in EFFECTS:
        errs.append(f"{where}.effect {s['effect']!r} not in {EFFECTS}")

    if "style_prompt" in s and not isinstance(s["style_prompt"], str):
        errs.append(f"{where}.style_prompt must be a string")

    extra = set(s) - {"text", "emotion", "intensity", "effect", "style_prompt"}
    if extra:
        errs.append(f"{where} has unexpected keys: {sorted(extra)}")

    return errs


def _validate_tool_call(i: int, c: Any) -> list[str]:
    errs: list[str] = []
    where = f"tool_calls[{i}]"

    if not isinstance(c, dict):
        return [f"{where} must be an object"]

    name = c.get("name")
    if name not in TOOLS:
        return [f"{where}.name {name!r} is not a known tool; expected one of {sorted(TOOLS)}"]

    args = c.get("arguments", {})
    if not isinstance(args, dict):
        return [f"{where}.arguments must be an object"]

    allowed = TOOLS[name]
    unknown = set(args) - set(allowed)
    if unknown:
        errs.append(f"{where} ({name}) got unknown arguments {sorted(unknown)}")

    for arg, kind in allowed.items():
        if arg not in args:
            continue
        val = args[arg]
        if kind == "string" and not isinstance(val, str):
            errs.append(f"{where} ({name}).{arg} must be a string")
        elif kind == "number" and (
            not isinstance(val, (int, float)) or isinstance(val, bool)
        ):
            errs.append(f"{where} ({name}).{arg} must be a number")

    if name in NO_ARG_TOOLS and args:
        errs.append(f"{where} ({name}) takes no arguments, got {sorted(args)}")

    if name == "swipe":
        d = args.get("direction")
        if d is not None and d not in {"up", "down", "left", "right"}:
            errs.append(f"{where} (swipe).direction must be up/down/left/right, got {d!r}")

    if name == "direct_intent":
        action = args.get("action")
        if action is not None and action not in DIRECT_INTENTS:
            errs.append(
                f"{where} (direct_intent).action {action!r} not in {DIRECT_INTENTS}"
            )

    if name == "tap":
        has_element = bool(str(args.get("element", "")).strip())
        has_coords = "x" in args and "y" in args
        if not has_element and not has_coords:
            errs.append(f"{where} (tap) needs either 'element' or both 'x' and 'y'")

    return errs


def is_sensitive(call: dict) -> bool:
    """True if this tool call performs an action Aria must confirm first."""
    if call.get("name") != "direct_intent":
        return False
    return call.get("arguments", {}).get("action") in SENSITIVE_INTENTS
