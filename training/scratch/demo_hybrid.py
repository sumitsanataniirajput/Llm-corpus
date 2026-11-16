#!/usr/bin/env python3
"""
End-to-end demo of the hybrid path: model writes the words, rules fix the slots.

    python demo_hybrid.py
    python demo_hybrid.py "set an alarm for 4:35"

Shows, for each prompt, what the raw model produced versus the final reply
after slot repair -- so the contribution of each half is visible.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import torch

from format import ASSIST_TAG, SCREEN_TAG, USER_TAG, parse_reply
from model import TinyGPT
from slots import classify_action, respond
from tokenizer import BPETokenizer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from aria.schema import validate_response  # noqa: E402

DEFAULT_PROMPTS = [
    "set an alarm for 4:35",
    "set a timer for 82 minutes",
    "call Farida",
    "navigate to the aquarium",
    "open gmail",
    "my dog passed away",
    "scroll up",
]


def load():
    ck = torch.load(HERE / "checkpoints" / "aria_gpt.pt", map_location="cpu",
                    weights_only=False)
    model = TinyGPT(**ck["config"])
    model.load_state_dict(ck["model"])
    model.eval()
    return model, BPETokenizer.load(HERE / "tokenizer.json"), ck


def run(model, tok, user, screen=None):
    prompt = (SCREEN_TAG + screen + "\n" if screen else "") + USER_TAG + user + "\n" + ASSIST_TAG
    ids = torch.tensor([tok.encode(prompt)])
    out = model.generate(ids, max_new_tokens=220, temperature=0.0)
    reply = tok.decode(out[0][ids.shape[1]:].tolist()).split("<|end|>")[0]
    return parse_reply(reply)[0]


def summarise(obj):
    if not obj:
        return "(unparseable)"
    says = " / ".join(s.get("text", "") for s in obj.get("sentences", []))
    tools = [
        f"{c['name']}({json.dumps(c.get('arguments', {}), ensure_ascii=False)})"
        for c in obj.get("tool_calls", [])
    ]
    return says + ("  ||  " + "; ".join(tools) if tools else "")


def main() -> None:
    prompts = sys.argv[1:] or DEFAULT_PROMPTS
    model, tok, ck = load()
    print(f"model: 2.47M params, val loss {ck.get('val_loss', float('nan')):.3f}\n")

    for user in prompts:
        raw = run(model, tok, user)
        final = respond(raw, user)

        print("=" * 78)
        print("USER  :", user)
        print("MODEL :", summarise(raw))

        if final is None:
            print("FINAL : (no action implied; surface the model reply as-is)")
            continue

        print("FINAL :", summarise(final))
        errs = validate_response(final)
        print("SCHEMA:", "valid" if not errs else f"INVALID {errs}")
        action = classify_action(user)
        if action:
            print("SLOT  : rules supplied the", action, "arguments")


if __name__ == "__main__":
    main()
