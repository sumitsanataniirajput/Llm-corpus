#!/usr/bin/env python3
"""
Evaluate the from-scratch Aria GPT on the held-out validation set.

Scores the same dimensions as ``aria/evaluate.py`` so the numbers are
comparable with a hosted-API baseline:

    json_rate     output parses as JSON
    schema_rate   output satisfies the app's parser (aria/schema.py)
    emotion_acc   lead emotion matches the reference
    tool_em       tool calls match exactly (name + arguments)
    score         0.45*schema + 0.35*tool + 0.20*emotion

Usage
-----
    python evaluate_scratch.py --limit 100
    python evaluate_scratch.py --limit 100 --temperature 0.7
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

from format import ASSIST_TAG, SCREEN_TAG, USER_TAG, from_row, parse_reply
from model import TinyGPT
from tokenizer import BPETokenizer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from aria.schema import validate_response  # noqa: E402

DATA = HERE.parent / "aria" / "data"


def load(checkpoint: Path):
    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = TinyGPT(**ckpt["config"])
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


def split_row(row: dict) -> tuple[str, str | None]:
    content = row["messages"][1]["content"]
    marker = "[Foreground Screen UI]:"
    if marker in content:
        user, _, screen = content.partition(marker)
        return user.strip(), screen.strip() or None
    return content.strip(), None


def normalise_tools(obj: dict) -> list[tuple[str, str]]:
    out = []
    for c in obj.get("tool_calls") or []:
        if isinstance(c, dict):
            out.append((c.get("name"),
                        json.dumps(c.get("arguments") or {}, sort_keys=True)))
    return sorted(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", type=Path,
                    default=HERE / "checkpoints" / "aria_gpt.pt")
    ap.add_argument("--data", type=Path, default=DATA / "val.jsonl")
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--max-tokens", type=int, default=260)
    ap.add_argument("--json-out", type=Path, default=None)
    ap.add_argument("--show", type=int, default=0, help="print N examples")
    args = ap.parse_args()

    if not args.checkpoint.exists():
        sys.exit(f"{args.checkpoint} not found -- run train_scratch.py first")
    if not args.data.exists():
        sys.exit(f"{args.data} not found -- run generate_dataset.py first")

    model, tok, ckpt = load(args.checkpoint)
    rows = [json.loads(l) for l in args.data.open(encoding="utf-8")][: args.limit]

    parsed_n = valid_n = 0
    emo_hit = emo_tot = 0
    tool_hit = tool_tot = 0
    failures = []
    shown = 0

    for row in rows:
        user_text, screen = split_row(row)
        reference = json.loads(row["messages"][2]["content"])

        prompt = build_prompt(user_text, screen)
        ids = torch.tensor([tok.encode(prompt)], dtype=torch.long)
        out = model.generate(ids, max_new_tokens=args.max_tokens,
                             temperature=args.temperature)
        reply = tok.decode(out[0][ids.shape[1]:].tolist()).split("<|end|>")[0]

        pred, raw = parse_reply(reply)
        if pred is None:
            failures.append({"user": user_text[:80], "raw": reply[:160],
                             "why": "unparseable"})
            continue
        parsed_n += 1

        errs = validate_response(pred)
        if not errs:
            valid_n += 1
        elif len(failures) < 20:
            failures.append({"user": user_text[:80], "errors": errs[:3],
                             "why": "schema"})

        ref_s = reference.get("sentences") or []
        prd_s = pred.get("sentences") or []
        if ref_s and isinstance(prd_s, list) and prd_s:
            emo_tot += 1
            first = prd_s[0] if isinstance(prd_s[0], dict) else {}
            if first.get("emotion") == ref_s[0].get("emotion"):
                emo_hit += 1

        if reference.get("tool_calls"):
            tool_tot += 1
            if normalise_tools(pred) == normalise_tools(reference):
                tool_hit += 1

        if shown < args.show:
            shown += 1
            print("=" * 70)
            print("USER:", user_text)
            if screen:
                print("SCREEN:", screen[:80])
            print("REF :", json.dumps(reference.get("sentences", [{}])[0], ensure_ascii=False)[:120])
            print("PRED:", json.dumps(prd_s[0] if prd_s else {}, ensure_ascii=False)[:120])

    def pct(a, b):
        return round(100.0 * a / b, 2) if b else 0.0

    result = {
        "rows": len(rows),
        "json_rate": pct(parsed_n, len(rows)),
        "schema_rate": pct(valid_n, len(rows)),
        "emotion_acc": pct(emo_hit, emo_tot),
        "tool_em": pct(tool_hit, tool_tot),
    }
    result["score"] = round(
        0.45 * result["schema_rate"]
        + 0.35 * result["tool_em"]
        + 0.20 * result["emotion_acc"], 2)

    print(f"\ncheckpoint: {args.checkpoint.name} "
          f"(val loss {ckpt.get('val_loss', float('nan')):.3f}, "
          f"{model.num_params()/1e6:.2f}M params)")
    print(f"rows: {result['rows']}  temperature: {args.temperature}")
    print(f"  JSON parseable   {result['json_rate']:6.2f}%")
    print(f"  schema valid     {result['schema_rate']:6.2f}%   <- app can parse")
    print(f"  emotion match    {result['emotion_acc']:6.2f}%")
    print(f"  tool exact match {result['tool_em']:6.2f}%")
    print(f"  SCORE            {result['score']:6.2f}")

    if failures:
        print(f"\nfailures ({len(failures)}):")
        for f in failures[:8]:
            print("  -", json.dumps(f, ensure_ascii=False)[:200])

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(result, indent=2))
        print(f"\nwrote {args.json_out}")


if __name__ == "__main__":
    main()
