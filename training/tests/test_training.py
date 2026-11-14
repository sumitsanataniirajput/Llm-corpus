#!/usr/bin/env python3
"""
Tests for the Aria fine-tuning pipeline.

Run from the repo root:
    python -m pytest training/tests -q
    # or without pytest:
    python training/tests/test_training.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARIA = HERE.parent / "aria"
sys.path.insert(0, str(ARIA))

import evaluate  # noqa: E402
import generate_dataset as gd  # noqa: E402
from prompt import system_prompt  # noqa: E402
from schema import (  # noqa: E402
    DIRECT_INTENTS,
    EFFECTS,
    EMOTIONS,
    TOOLS,
    is_sensitive,
    validate_response,
)


# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------


def test_known_emotions_match_app():
    # Mirrors AriaEmotion in AriaModels.kt -- if the app gains an emotion,
    # this list must change too or training data will lag the parser.
    assert EMOTIONS == [
        "happy", "excited", "shy", "sad", "angry", "annoyed",
        "surprised", "scared", "curious", "sleepy", "proud", "neutral",
    ]
    assert len(EMOTIONS) == 12


def test_effects_match_app():
    assert set(EFFECTS) == {"laugh", "sigh", "pause_short", "pause_long", "none"}


def test_tool_names_match_app():
    assert set(TOOLS) == {
        "tap", "swipe", "type_text", "press_back",
        "press_home", "open_app", "direct_intent", "finish",
    }


def test_direct_intents_match_app():
    assert set(DIRECT_INTENTS) == {
        "call", "sms", "whatsapp", "alarm", "timer",
        "calendar", "navigation", "music", "flashlight", "wifi_panel", "settings",
    }


def test_valid_payload_passes():
    ok = {
        "sentences": [
            {"text": "Hi!", "emotion": "happy", "intensity": 2,
             "effect": "none", "style_prompt": "say this warmly"}
        ]
    }
    assert validate_response(ok) == []


def test_missing_sentences_fails():
    assert any("sentences" in e for e in validate_response({}))


def test_empty_sentences_fails():
    assert any("must not be empty" in e for e in validate_response({"sentences": []}))


def test_bad_emotion_fails():
    bad = {"sentences": [{"text": "x", "emotion": "furious", "intensity": 2}]}
    assert any("not in" in e for e in validate_response(bad))


def test_intensity_out_of_range_fails():
    for bad_intensity in (0, 4, -1):
        bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": bad_intensity}]}
        assert validate_response(bad), f"intensity {bad_intensity} should fail"


def test_bad_effect_fails():
    bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": 2, "effect": "scream"}]}
    assert any("effect" in e for e in validate_response(bad))


def test_unknown_tool_fails():
    bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": 2}],
           "tool_calls": [{"name": "fly_to_moon", "arguments": {}}]}
    assert any("not a known tool" in e for e in validate_response(bad))


def test_no_arg_tool_rejects_args():
    bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": 2}],
           "tool_calls": [{"name": "press_home", "arguments": {"x": 1}}]}
    assert any("takes no arguments" in e for e in validate_response(bad))


def test_tap_requires_target():
    bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": 2}],
           "tool_calls": [{"name": "tap", "arguments": {}}]}
    assert any("needs either" in e for e in validate_response(bad))


def test_swipe_direction_validated():
    bad = {"sentences": [{"text": "x", "emotion": "happy", "intensity": 2}],
           "tool_calls": [{"name": "swipe", "arguments": {"direction": "sideways"}}]}
    assert any("direction" in e for e in validate_response(bad))


def test_sensitive_intent_detection():
    call = {"name": "direct_intent", "arguments": {"action": "call"}}
    sms = {"name": "direct_intent", "arguments": {"action": "sms"}}
    alarm = {"name": "direct_intent", "arguments": {"action": "alarm"}}
    assert is_sensitive(call)
    assert is_sensitive(sms)
    assert not is_sensitive(alarm)
    assert not is_sensitive({"name": "open_app", "arguments": {"name": "YouTube"}})


# --------------------------------------------------------------------------
# Prompt
# --------------------------------------------------------------------------


def test_prompt_has_output_contract():
    p = system_prompt()
    for token in ("sentences", "emotion", "intensity", "effect", "style_prompt"):
        assert token in p
    for emotion in EMOTIONS:
        assert emotion in p, f"prompt omits emotion {emotion}"


def test_prompt_injects_memories():
    p = system_prompt(memories=["you love mango ice cream"])
    assert "mango ice cream" in p


def test_prompt_without_memories_has_no_section():
    assert "Things you know" not in system_prompt()


def test_assistant_name_substituted():
    assert "You are Nova," in system_prompt(assistant_name="Nova")


# --------------------------------------------------------------------------
# Dataset generation
# --------------------------------------------------------------------------


def test_generated_samples_validate():
    """Every generated sample must satisfy the app's schema."""
    import random

    rng = random.Random(123)
    for name, (fn, _w) in gd.CATEGORIES.items():
        for _ in range(40):
            user, screen, assistant = fn(rng)
            errors = validate_response(assistant)
            assert not errors, f"[{name}] {user!r}: {errors}"


def test_all_emotions_exercised():
    """All twelve emotions must appear in the dataset.

    gen_emotion deliberately covers only the eight under-represented
    emotions (happy/excited arrive from small talk), so coverage is asserted
    at the dataset level -- which is what the model actually sees.
    """
    train, val = gd.build(500, seed=5, val_ratio=0.05)
    seen: set[str] = set()
    for row in train + val:
        for sent in json.loads(row["messages"][2]["content"])["sentences"]:
            seen.add(sent["emotion"])
    missing = set(EMOTIONS) - seen
    assert not missing, f"dataset never produces: {sorted(missing)}"


def test_emotion_generator_covers_rare_emotions():
    """The eight emotions small talk under-represents must be generated."""
    import random

    rng = random.Random(5)
    seen = set()
    for _ in range(200):
        _u, _s, a = gd.gen_emotion(rng)
        for sent in a["sentences"]:
            seen.add(sent["emotion"])
    rare = {"sad", "angry", "scared", "surprised", "shy", "sleepy", "annoyed", "proud"}
    assert rare <= seen, f"emotion generator missing: {sorted(rare - seen)}"


def test_screen_context_truncated():
    user, _screen, _a = gd.gen_screen_task(__import__("random").Random(1))
    long_screen = "X" * 5000
    out = gd.render_user("do it", long_screen)
    assert len(out) < gd.SCREEN_LIMIT + 100
    assert "[Foreground Screen UI]" in out


def test_no_screen_means_plain_prompt():
    assert gd.render_user("hello", None) == "hello"


def test_build_is_deterministic():
    a_tr, a_val = gd.build(120, seed=42, val_ratio=0.1)
    b_tr, b_val = gd.build(120, seed=42, val_ratio=0.1)
    assert [r["messages"][1]["content"] for r in a_tr] == [r["messages"][1]["content"] for r in b_tr]


def test_build_has_no_duplicates():
    train, val = gd.build(150, seed=3, val_ratio=0.1)
    users = [r["messages"][1]["content"] + r["messages"][2]["content"]
             for r in train + val]
    assert len(users) == len(set(users))


def test_dataset_shape():
    train, val = gd.build(100, seed=11, val_ratio=0.1)
    assert train and val
    row = train[0]
    assert [m["role"] for m in row["messages"]] == ["system", "user", "assistant"]
    assert row["messages"][0]["content"] == system_prompt()
    json.loads(row["messages"][2]["content"])  # assistant turn must be JSON


# --------------------------------------------------------------------------
# Evaluation harness
# --------------------------------------------------------------------------


def test_extract_json_bare():
    assert evaluate.extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert evaluate.extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_with_prose():
    assert evaluate.extract_json('Sure! ```json\n{"a": 1}\n``` hope that helps') == {"a": 1}


def test_extract_json_finds_embedded_object():
    assert evaluate.extract_json('here you go: {"a": 1} done') == {"a": 1}


def test_extract_json_rejects_prose():
    assert evaluate.extract_json("I cannot help with that.") is None


def test_extract_json_handles_none():
    assert evaluate.extract_json(None) is None


def _rows(n=40):
    train, val = gd.build(n * 2, seed=99, val_ratio=0.5)
    return val[:n]


def test_oracle_scores_perfect():
    result = evaluate.score_rows(_rows(), evaluate.OracleBackend())
    assert result["score"] == 100.0, result


def test_harness_penalises_garbage():
    class Garbage:
        def __call__(self, _m):
            return "no json here"

    result = evaluate.score_rows(_rows(), Garbage())
    assert result["json_rate"] == 0.0
    assert result["score"] == 0.0


def test_harness_penalises_missing_tools():
    class NoTools:
        def __call__(self, m):
            o = json.loads(m[-1]["content"])
            o.pop("tool_calls", None)
            return json.dumps(o)

    result = evaluate.score_rows(_rows(), NoTools())
    assert result["schema_rate"] == 100.0
    assert result["tool_em"] == 0.0
    assert result["score"] < 100.0


def test_harness_penalises_wrong_emotion():
    class WrongEmotion:
        def __call__(self, m):
            o = json.loads(m[-1]["content"])
            for s in o["sentences"]:
                s["emotion"] = "happy"
            return json.dumps(o)

    result = evaluate.score_rows(_rows(), WrongEmotion())
    assert result["emotion_acc"] < 100.0


def test_harness_tolerates_exceptions():
    class Boom:
        def __call__(self, _m):
            raise RuntimeError("network down")

    result = evaluate.score_rows(_rows(4), Boom())
    assert result["rows"] == 4
    assert result["score"] == 0.0


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
