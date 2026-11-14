#!/usr/bin/env python3
"""
Run the from-scratch Aria GPT: generate a reply and expand it to app format.

    python infer_scratch.py "open youtube"
    python infer_scratch.py "my dog passed away" --temperature 0
    python infer_scratch.py "scroll down" --screen "Instagram. Feed visible."

The model was trained on the compact format (see format.py); this script adds
the tags the model never saw and expands the reply back into the full object
the Android app parses.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

from format import ASSIST_TAG, SCREEN_TAG, USER_TAG, parse_reply
from model import TinyGPT
from tokenizer import BPETokenizer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # for aria/schema.py


def load(checkpoint: Path):
    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
    cfg = ckpt["config"]
    model = TinyGPT(**cfg)
    model.load_state_dict(ckpt["model"])
    model.eval()
    tok = BPETokenizer.load(HERE / "tokenizer.json")
    return model, tok, ckpt


def build_prompt(user_text: str, screen: str | None) -> str:
    out = ""
    if screen:
        out += SCREEN_TAG + screen.replace("\n", " ") + "\n"
    out += USER_TAG + user_text.replace("\n", " ") + "\n" + ASSIST_TAG
    return out


def expand(obj: dict) -> dict:
    """Fill in any fields the compact form omitted."""
    sents = []
    for s in obj.get("sentences", []):
        sents.append({
            "text": s.get("text", ""),
            "emotion": s.get("emotion", "neutral"),
            "intensity": s.get("intensity", 2),
            "effect": s.get("effect", "none"),
            "style_prompt": s.get("style_prompt", ""),
        })
    out: dict = {"sentences": sents}
    if obj.get("tool_calls"):
        out["tool_calls"] = obj["tool_calls"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("message", help="what the user says to Aria")
    ap.add_argument("--screen", default=None, help="foreground screen context")
    ap.add_argument("--checkpoint", type=Path, default=HERE / "checkpoints" / "aria_gpt.pt")
    ap.add_argument("--temperature", type=float, default=0.0,
                    help="0 = greedy/deterministic; 0.7 = creative")
    ap.add_argument("--max-tokens", type=int, default=260)
    ap.add_argument("--json-only", action="store_true", help="print just the JSON")
    args = ap.parse_args()

    if not args.checkpoint.exists():
        sys.exit(f"{args.checkpoint} not found -- run train_scratch.py first")

    model, tok, ckpt = load(args.checkpoint)
    prompt = build_prompt(args.message, args.screen)

    ids = torch.tensor([tok.encode(prompt)], dtype=torch.long)
    out = model.generate(
        ids,
        max_new_tokens=args.max_tokens,
        temperature=args.temperature,
        stop_token=None,
    )
    gen_ids = out[0][ids.shape[1]:].tolist()
    reply = tok.decode(gen_ids)
    # The model was trained with <|end|> separators; cut at the first one.
    reply = reply.split("<|end|>")[0]

    parsed, raw = parse_reply(reply)

    if not args.json_only:
        print(f"checkpoint: {args.checkpoint.name} "
              f"(val loss {ckpt.get('val_loss', float('nan')):.3f})")
        print(f"USER:   {args.message}")
        if args.screen:
            print(f"SCREEN: {args.screen}")
        print(f"\nRAW REPLY:\n{reply.strip()[:600]}\n")

    if parsed is None:
        print("!! could not parse valid JSON from the reply")
        sys.exit(1)

    full = expand(parsed)

    # Validate against the app's real schema if available.
    try:
        from aria.schema import validate_response

        errors = validate_response(full)
    except ImportError:
        errors = []

    if args.json_only:
        print(json.dumps(full, indent=2, ensure_ascii=False))
    else:
        print("PARSED (app format):")
        print(json.dumps(full, indent=2, ensure_ascii=False)[:800])

    if errors:
        print(f"\nSCHEMA ERRORS: {errors}")
        sys.exit(1)
    if not args.json_only:
        print("\nSCHEMA: valid -- the app can parse this.")


if __name__ == "__main__":
    main()
