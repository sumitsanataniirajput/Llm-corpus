#!/usr/bin/env python3
"""
Tests for the from-scratch Aria GPT (tokenizer, model, format, inference).

Run from the repo root:
    python training/tests/test_scratch.py
    # or: python -m pytest training/tests/test_scratch.py -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = HERE.parent / "scratch"
ARIA = HERE.parent / "aria"
sys.path.insert(0, str(SCRATCH))
sys.path.insert(0, str(HERE.parent))

import torch  # noqa: E402

from model import TinyGPT  # noqa: E402
from tokenizer import BPETokenizer  # noqa: E402
import format as fmt  # noqa: E402
from aria.schema import validate_response  # noqa: E402


# --------------------------------------------------------------------------
# Tokenizer
# --------------------------------------------------------------------------


def _tiny_tok() -> BPETokenizer:
    text = "the quick brown fox jumps over the lazy dog. " * 40
    return BPETokenizer.train(text, vocab_size=300)


def test_tokenizer_roundtrip_ascii():
    tok = _tiny_tok()
    for s in ["hello world", "open youtube", '{"a":1}', "Aria is happy!"]:
        assert tok.decode(tok.encode(s)) == s


def test_tokenizer_roundtrip_unicode():
    tok = _tiny_tok()
    for s in ["café ☕", "31°C", "naïve résumé", "日本語"]:
        assert tok.decode(tok.encode(s)) == s


def test_tokenizer_handles_empty():
    tok = _tiny_tok()
    assert tok.encode("") == []
    assert tok.decode([]) == ""


def test_tokenizer_vocab_size():
    # On a repetitive corpus the tokenizer reaches the requested vocab.
    tok = BPETokenizer.train("abcdefghij" * 200, vocab_size=270)
    assert tok.vocab_size == 270
    assert len(tok.merges) == 270 - 256


def test_tokenizer_stops_when_no_repeats():
    """Merging must stop rather than invent merges for a tiny corpus."""
    tok = BPETokenizer.train("ab", vocab_size=300)
    assert tok.vocab_size < 300          # could not reach the target
    assert tok.vocab_size >= 256         # but all bytes remain valid
    assert tok.decode(tok.encode("ab")) == "ab"


def test_tokenizer_compresses():
    tok = _tiny_tok()
    text = "the quick brown fox " * 20
    assert len(tok.encode(text)) < len(text)


def test_tokenizer_save_load(tmp_path=None):
    import tempfile

    tok = _tiny_tok()
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        p = Path(f.name)
    tok.save(p)
    tok2 = BPETokenizer.load(p)
    assert tok2.merges == tok.merges
    assert tok2.encode("hello") == tok.encode("hello")
    p.unlink()


def test_tokenizer_never_exceeds_vocab():
    tok = _tiny_tok()
    ids = tok.encode("the quick brown fox jumps over the lazy dog")
    assert all(0 <= i < tok.vocab_size for i in ids)


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


def _tiny_model(vocab=300, block=32) -> TinyGPT:
    return TinyGPT(vocab_size=vocab, block_size=block, n_layer=2, n_head=2,
                   n_embd=32, dropout=0.0)


def test_model_forward_shape():
    m = _tiny_model()
    x = torch.randint(0, 300, (2, 16))
    logits, loss = m(x)
    assert logits.shape == (2, 16, 300)
    assert loss is None  # no targets -> no loss


def test_model_loss_is_finite():
    m = _tiny_model()
    x = torch.randint(0, 300, (2, 16))
    y = torch.randint(0, 300, (2, 16))
    _, loss = m(x, y)
    assert torch.isfinite(loss)


def test_model_initial_loss_near_log_vocab():
    """At init a well-formed LM should be ~uniform: loss ≈ ln(vocab_size)."""
    import math

    torch.manual_seed(0)
    m = _tiny_model(vocab=500)
    x = torch.randint(0, 500, (8, 32))
    y = torch.randint(0, 500, (8, 32))
    _, loss = m(x, y)
    assert abs(loss.item() - math.log(500)) < 1.0, loss.item()


def test_causality_not_violated_by_shape():
    """Changing a future token must not change earlier logits."""
    torch.manual_seed(1)
    m = _tiny_model()
    m.eval()
    x = torch.randint(0, 300, (1, 12))
    x2 = x.clone()
    x2[0, -1] = (x2[0, -1] + 7) % 300  # alter the last token only
    with torch.no_grad():
        a, _ = m(x)
        b, _ = m(x2)
    # positions before the changed token must be identical
    assert torch.allclose(a[0, :-1], b[0, :-1], atol=1e-6)


def test_generate_extends_sequence():
    m = _tiny_model(block=16)
    idx = torch.randint(0, 300, (1, 5))
    out = m.generate(idx, max_new_tokens=10, temperature=0.0)
    assert out.shape == (1, 15)


def test_generate_respects_block_size():
    """Generation must crop context rather than crash past block_size."""
    m = _tiny_model(block=16)
    idx = torch.randint(0, 300, (1, 20))  # already longer than block_size
    out = m.generate(idx, max_new_tokens=5, temperature=0.0)
    assert out.shape[1] > 20


def test_generate_is_deterministic_greedy():
    torch.manual_seed(3)
    m = _tiny_model()
    m.eval()
    idx = torch.randint(0, 300, (1, 8))
    a = m.generate(idx.clone(), max_new_tokens=8, temperature=0.0)
    b = m.generate(idx.clone(), max_new_tokens=8, temperature=0.0)
    assert torch.equal(a, b)


def test_weight_tying():
    m = _tiny_model()
    assert m.head.weight is m.tok_emb.weight


def test_param_count_reasonable():
    m = _tiny_model(vocab=1024, block=64)
    assert m.num_params() > 0
    n = m.num_params()
    assert n == sum(p.numel() for p in m.parameters())


# --------------------------------------------------------------------------
# Compact format
# --------------------------------------------------------------------------


def _payload():
    return {
        "sentences": [
            {"text": "Okay! Opening YouTube.", "emotion": "happy", "intensity": 2,
             "effect": "none", "style_prompt": "say this with a warm little smile"}
        ],
        "tool_calls": [{"name": "open_app", "arguments": {"name": "YouTube"}}],
    }


def test_compact_is_valid_json():
    s = fmt.compact(_payload())
    assert json.loads(s)


def test_compact_has_no_spaces():
    s = fmt.compact(_payload())
    assert ", " not in s and ": " not in s
    assert len(s) < len(json.dumps(_payload()))


def test_compact_preserves_contract():
    s = fmt.compact(_payload())
    obj = json.loads(s)
    assert validate_response(obj) == []


def test_render_example_structure():
    out = fmt.render_example("open youtube", None, _payload())
    assert out.startswith("U: open youtube")
    assert "A: {" in out


def test_render_example_with_screen():
    out = fmt.render_example("scroll down", "Instagram. Feed visible.", _payload())
    assert out.startswith("[SCREEN] Instagram. Feed visible.")
    assert "U: scroll down" in out


def test_from_row_strips_screen_marker():
    row = {
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "scroll down\n\n[Foreground Screen UI]:\nInstagram. Feed."},
            {"role": "assistant", "content": json.dumps(_payload())},
        ]
    }
    out = fmt.from_row(row)
    assert "[Foreground Screen UI]" not in out
    assert "SCREEN] Instagram. Feed." in out
    assert "U: scroll down" in out


def test_from_row_without_screen():
    row = {
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": json.dumps(_payload())},
        ]
    }
    out = fmt.from_row(row)
    assert "[SCREEN]" not in out
    assert out.startswith("U: hello")


def test_parse_reply_extracts_json():
    obj, raw = fmt.parse_reply('A: {"sentences":[]} extra junk')
    assert obj == {"sentences": []}
    assert raw == '{"sentences":[]}'


def test_parse_reply_handles_nested_braces():
    text = 'noise {"a":{"b":{"c":1}}} trailing'
    obj, _ = fmt.parse_reply(text)
    assert obj == {"a": {"b": {"c": 1}}}


def test_parse_reply_handles_braces_in_strings():
    """A '}' inside a string value must not terminate the object early."""
    text = '{"text":"she said } loudly","emotion":"happy"}'
    obj, _ = fmt.parse_reply(text)
    assert obj is not None
    assert obj["text"] == "she said } loudly"


def test_parse_reply_handles_escaped_quotes():
    text = '{"text":"she said \\"hi\\"","emotion":"happy"}'
    obj, _ = fmt.parse_reply(text)
    assert obj is not None
    assert obj["text"] == 'she said "hi"'


def test_parse_reply_returns_none_on_garbage():
    obj, _ = fmt.parse_reply("no json at all")
    assert obj is None


def test_parse_reply_returns_none_on_truncated():
    obj, raw = fmt.parse_reply('{"sentences":[{"text":"hi"')
    assert obj is None
    assert raw.startswith("{")




# --------------------------------------------------------------------------
# Slot extraction (hybrid fallback)
# --------------------------------------------------------------------------

from slots import (  # noqa: E402
    build_arguments,
    classify_action,
    extract_duration,
    extract_place,
    extract_target,
    extract_time,
    fallback_response,
    repair_tool_calls,
    respond,
)


def test_extract_time_digital():
    assert extract_time("set an alarm for 6:45") == "06:45"
    assert extract_time("alarm at 18:30") == "18:30"


def test_extract_time_ampm():
    assert extract_time("wake me at 7pm") == "19:00"
    assert extract_time("alarm 7 am") == "07:00"


def test_extract_time_bare_hour():
    assert extract_time("set an alarm for 6") == "06:00"


def test_extract_time_spoken():
    assert extract_time("alarm for six forty-five") == "06:45"
    assert extract_time("alarm at six o'clock") == "06:00"


def test_extract_time_none_when_absent():
    assert extract_time("open youtube") is None


def test_extract_duration_digits():
    assert extract_duration("timer for 25 minutes") == "25"
    assert extract_duration("set a 108 min timer") == "108"


def test_extract_duration_words():
    assert extract_duration("timer for twenty five minutes") == "25"
    assert extract_duration("timer for forty-five minutes") == "45"


def test_extract_duration_specials():
    assert extract_duration("set a timer for half an hour") == "30"
    assert extract_duration("timer for an hour") == "60"


def test_extract_duration_none():
    assert extract_duration("open youtube") is None


def test_extract_target_capitalised():
    assert extract_target("call Farida") == "Farida"


def test_extract_target_with_clause():
    assert extract_target("text Arjun that I reached home") == "Arjun"


def test_extract_target_family():
    t = extract_target("call my mom")
    assert t and "mom" in t.lower()


def test_extract_target_omits_filler():
    # "call the aquarium" must not become a contact
    assert extract_target("call the aquarium") is None


def test_extract_place():
    assert "airport" in (extract_place("navigate to the airport") or "")
    assert "bakery" in (extract_place("take me to a bakery") or "")


def test_classify_action():
    assert classify_action("set an alarm for 7") == "alarm"
    assert classify_action("set a timer for 5 minutes") == "timer"
    assert classify_action("call Neha") == "call"
    assert classify_action("navigate to the park") == "navigation"
    assert classify_action("play some jazz") == "music"
    assert classify_action("tell me a joke") is None


def test_build_arguments_alarm():
    a = build_arguments("alarm", "set an alarm for 6:45")
    assert a["action"] == "alarm" and a["target"] == "06:45"


def test_build_arguments_timer():
    a = build_arguments("timer", "timer for 37 minutes")
    assert a["target"] == "37"


def test_repair_replaces_wrong_slot():
    """The core fix: model guessed 6:00, prompt said 4:35."""
    obj = {
        "sentences": [{"text": "Setting it!", "emotion": "happy",
                       "intensity": 2, "effect": "none", "style_prompt": ""}],
        "tool_calls": [{"name": "direct_intent",
                        "arguments": {"action": "alarm", "target": "06:00",
                                      "content": "Alarm"}}],
    }
    fixed = repair_tool_calls(obj, "set an alarm for 4:35")
    args = fixed["tool_calls"][0]["arguments"]
    assert args["target"] == "04:35", args
    assert fixed["sentences"][0]["text"] == "Setting it!"  # prose untouched


def test_repair_adds_missing_tool():
    """Model said the right words but emitted no tool call."""
    obj = {"sentences": [{"text": "Music time!", "emotion": "excited",
                          "intensity": 2, "effect": "none", "style_prompt": ""}]}
    fixed = repair_tool_calls(obj, "play some jazz")
    di = next(c for c in fixed["tool_calls"] if c["name"] == "direct_intent")
    assert di["arguments"]["target"] == "jazz"  # filler "some" stripped


def test_repair_leaves_plain_chat_alone():
    obj = {"sentences": [{"text": "Hi!", "emotion": "happy",
                          "intensity": 2, "effect": "none", "style_prompt": ""}]}
    assert repair_tool_calls(obj, "hello").get("tool_calls") is None


def test_fallback_response_is_schema_valid():
    fb = fallback_response("set an alarm for 4:35")
    assert fb is not None
    assert validate_response(fb) == []
    assert fb["tool_calls"][0]["arguments"]["target"] == "04:35"


def test_fallback_returns_none_for_chat():
    assert fallback_response("tell me a story") is None


def test_respond_prefers_model_then_fixes():
    obj = {"sentences": [{"text": "Okay.", "emotion": "happy",
                          "intensity": 1, "effect": "none", "style_prompt": ""}],
           "tool_calls": [{"name": "direct_intent",
                           "arguments": {"action": "alarm", "target": "9:00"}}]}
    out = respond(obj, "alarm for 11:25")
    assert out["tool_calls"][0]["arguments"]["target"] == "11:25"
    assert validate_response(out) == []


def test_respond_falls_back_on_broken_model():
    out = respond(None, "set a timer for 82 minutes")
    assert out is not None
    assert out["tool_calls"][0]["arguments"]["target"] == "82"
    assert validate_response(out) == []


# --------------------------------------------------------------------------
# Spoken-text alignment
# --------------------------------------------------------------------------

from slots import (  # noqa: E402
    align_spoken_text,
    extract_open_app,
    extract_swipe,
    extract_system_nav,
    reconcile,
    rule_tool_calls,
)


def _one(text, emotion="happy"):
    return {"sentences": [{"text": text, "emotion": emotion, "intensity": 2,
                           "effect": "none", "style_prompt": ""}]}


def test_rule_scroll_does_not_become_timer():
    """Regression: 'scroll up' once produced a 77-minute timer."""
    calls = rule_tool_calls("scroll up")
    assert calls[0]["name"] == "swipe"
    assert calls[0]["arguments"]["direction"] == "up"
    assert all(c["name"] != "direct_intent" for c in calls)


def test_rule_open_app():
    calls = rule_tool_calls("open gmail")
    assert calls[0]["name"] == "open_app"
    assert calls[0]["arguments"]["name"] == "Gmail"


def test_rule_system_nav():
    assert rule_tool_calls("go back")[0]["name"] == "press_back"
    assert rule_tool_calls("go home")[0]["name"] == "press_home"


def test_rule_chat_returns_none():
    assert rule_tool_calls("my dog passed away") is None


def test_extract_swipe():
    assert extract_swipe("scroll down")["arguments"]["direction"] == "down"
    assert extract_swipe("hello") is None


def test_extract_open_app_unknown():
    assert extract_open_app("open flurbo") is None


def test_align_fixes_wrong_time():
    calls = rule_tool_calls("set an alarm for 4:35")
    out = align_spoken_text(_one("Setting an alarm for four forty!"),
                            "set an alarm for 4:35", calls)
    assert "thirty-five" in out["sentences"][0]["text"]


def test_align_keeps_correct_time():
    calls = rule_tool_calls("set an alarm for 4:35")
    out = align_spoken_text(_one("Setting an alarm for four thirty-five!"),
                            "set an alarm for 4:35", calls)
    assert out["sentences"][0]["text"] == "Setting an alarm for four thirty-five!"


def test_align_fixes_wrong_timer():
    calls = rule_tool_calls("set a timer for 82 minutes")
    out = align_spoken_text(_one("One hundred and forty-four."),
                            "set a timer for 82 minutes", calls)
    assert "82" in out["sentences"][0]["text"]


def test_reconcile_replaces_hallucinated_tools():
    """A timer hallucinated for 'scroll up' must be replaced entirely."""
    obj = _one("Timer!", "happy")
    obj["tool_calls"] = [{"name": "direct_intent",
                          "arguments": {"action": "timer", "target": "77"}}]
    out = reconcile(obj, "scroll up")
    assert out["tool_calls"][0]["name"] == "swipe"


def test_reconcile_strips_action_on_chat():
    obj = _one("Hi!", "happy")
    obj["tool_calls"] = [{"name": "direct_intent",
                          "arguments": {"action": "timer", "target": "5"}}]
    out = reconcile(obj, "hello there")
    assert "tool_calls" not in out


def test_reconcile_keeps_prose():
    obj = _one("That must hurt.", "sad")
    out = reconcile(obj, "my dog passed away")
    assert out["sentences"][0]["text"] == "That must hurt."


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
