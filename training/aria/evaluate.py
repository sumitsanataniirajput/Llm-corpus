#!/usr/bin/env python3
"""
Evaluate any model against Aria's held-out validation set.

This is the part that tells you whether a fine-tune actually helped. It scores
the things that break a voice assistant in production:

  json_rate     fraction of outputs that parse as JSON at all
  schema_rate   fraction that satisfy schema.validate_response() -- i.e. the
                app's parser will not choke on them
  emotion_acc   on rows with a known lead emotion, did the model pick it
  tool_em       on rows containing tool calls, exact set+args match rate
  score         weighted blend (headline number)

Two backends:

  --backend hf       local model via transformers (a fine-tuned checkpoint)
  --backend openai   any OpenAI-compatible endpoint (baseline frontier model)
  --backend oracle   replays the reference answer (sanity check: score == 1.0)

Usage
-----
    # baseline: a frontier model over the same prompt
    python training/aria/evaluate.py --backend openai \\
        --model gpt-4o-mini --limit 200

    # the fine-tuned checkpoint
    python training/aria/evaluate.py --backend hf \\
        --model ./aria-qwen-lora --limit 200

    # verify the harness itself against ground truth
    python training/aria/evaluate.py --backend oracle
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from schema import validate_response

DATA = Path(__file__).parent / "data"


# --------------------------------------------------------------------------
# Answer extraction
# --------------------------------------------------------------------------

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> dict | None:
    """Pull the JSON object out of a model reply.

    Small models love wrapping JSON in prose or code fences, so we try, in
    order: the whole string, a fenced block, and the outermost {...}.
    """
    if text is None:
        return None

    candidates = [text.strip()]

    fenced = _FENCE.search(text)
    if fenced:
        candidates.append(fenced.group(1).strip())

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    for c in candidates:
        try:
            obj = json.loads(c)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


# --------------------------------------------------------------------------
# Backends
# --------------------------------------------------------------------------


class OracleBackend:
    """Returns the reference answer. Used to validate the harness."""

    name = "oracle"

    def __call__(self, messages: list[dict]) -> str:
        return messages[-1]["content"]


class OpenAICompatBackend:
    def __init__(self, model: str, base_url: str, api_key: str, temperature: float = 0.0):
        try:
            from openai import OpenAI
        except ImportError:  # pragma: no cover
            sys.exit("pip install openai  (required for --backend openai)")

        self.client = OpenAI(base_url=base_url, api_key=api_key)
        self.model = model
        self.temperature = temperature
        self.name = f"openai:{model}"

    def __call__(self, messages: list[dict]) -> str:
        # The app sends the reference answer as the assistant turn; we must
        # remove it so the model generates rather than echoes.
        convo = messages[:-1]
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=convo,
            temperature=self.temperature,
            max_tokens=512,
        )
        return resp.choices[0].message.content or ""


class HFBackend:
    def __init__(self, model: str, adapter: str | None = None, max_new_tokens: int = 512):
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError:  # pragma: no cover
            sys.exit("pip install torch transformers accelerate  (for --backend hf)")

        self.torch = torch
        self.tok = AutoTokenizer.from_pretrained(model)
        self.model_obj = AutoModelForCausalLM.from_pretrained(
            model, torch_dtype="auto", device_map="auto"
        )
        if adapter:
            from peft import PeftModel

            self.model_obj = PeftModel.from_pretrained(self.model_obj, adapter)
        self.model_obj.eval()
        self.max_new_tokens = max_new_tokens
        self.name = f"hf:{model}" + (f"+{adapter}" if adapter else "")

    def __call__(self, messages: list[dict]) -> str:
        convo = messages[:-1]
        prompt = self.tok.apply_chat_template(
            convo, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tok(prompt, return_tensors="pt").to(self.model_obj.device)
        with self.torch.no_grad():
            out = self.model_obj.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,  # greedy: deterministic, comparable across runs
                pad_token_id=self.tok.eos_token_id,
            )
        gen = out[0][inputs["input_ids"].shape[1] :]
        return self.tok.decode(gen, skip_special_tokens=True)


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def normalise_tools(obj: dict) -> list[tuple[str, str]]:
    calls = obj.get("tool_calls") or []
    out = []
    for c in calls:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        args = c.get("arguments") or {}
        out.append((name, json.dumps(args, sort_keys=True)))
    return sorted(out)


def score_rows(rows: list[dict], backend) -> dict:
    n = len(rows)
    parsed = valid = 0
    emotion_hits = emotion_tot = 0
    tool_hits = tool_tot = 0
    failures: list[dict] = []

    for row in rows:
        msgs = row["messages"]
        reference = json.loads(msgs[-1]["content"])

        try:
            reply = backend(msgs)
        except Exception as exc:  # network blips shouldn't kill a long eval
            failures.append({"user": msgs[1]["content"][:120], "error": repr(exc)})
            continue

        pred = extract_json(reply)
        if pred is None:
            failures.append({"user": msgs[1]["content"][:120], "raw": (reply or "")[:200],
                             "why": "unparseable JSON"})
            continue
        parsed += 1

        errs = validate_response(pred)
        if not errs:
            valid += 1

        # Lead-emotion agreement.
        ref_s = reference.get("sentences") or []
        prd_s = pred.get("sentences") or []
        if ref_s and prd_s and isinstance(prd_s, list):
            emotion_tot += 1
            first = prd_s[0] if isinstance(prd_s[0], dict) else {}
            if first.get("emotion") == ref_s[0].get("emotion"):
                emotion_hits += 1

        # Tool-call exact match (name + arguments as a set).
        if reference.get("tool_calls"):
            tool_tot += 1
            if normalise_tools(pred) == normalise_tools(reference):
                tool_hits += 1

        if errs and len(failures) < 25:
            failures.append({"user": msgs[1]["content"][:120], "errors": errs[:4],
                             "why": "schema violation"})

    def pct(a: int, b: int) -> float:
        return round(100.0 * a / b, 2) if b else 0.0

    json_rate = pct(parsed, n)
    schema_rate = pct(valid, n)
    emotion_acc = pct(emotion_hits, emotion_tot)
    tool_em = pct(tool_hits, tool_tot)

    # Schema conformance matters most (a broken parse means the app crashes
    # or speaks nothing), then tool accuracy, then emotional fidelity.
    score = round(
        0.45 * schema_rate + 0.35 * tool_em + 0.20 * emotion_acc, 2
    )

    return {
        "rows": n,
        "json_rate": json_rate,
        "schema_rate": schema_rate,
        "emotion_acc": emotion_acc,
        "tool_em": tool_em,
        "score": score,
        "failures": failures,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=["oracle", "hf", "openai"], default="oracle")
    ap.add_argument("--model", default=None, help="model id or local path")
    ap.add_argument("--adapter", default=None, help="LoRA adapter path (hf backend)")
    ap.add_argument("--base-url", default="https://api.openai.com/v1")
    ap.add_argument("--api-key-env", default="OPENAI_API_KEY")
    ap.add_argument("--data", type=Path, default=DATA / "val.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="0 = all rows")
    ap.add_argument("--json-out", type=Path, default=None)
    args = ap.parse_args()

    if not args.data.exists():
        sys.exit(f"{args.data} not found -- run generate_dataset.py first")

    rows = [json.loads(line) for line in args.data.open(encoding="utf-8")]
    if args.limit:
        rows = rows[: args.limit]

    if args.backend == "oracle":
        backend = OracleBackend()
    elif args.backend == "openai":
        import os

        key = os.environ.get(args.api_key_env)
        if not key:
            sys.exit(f"set ${args.api_key_env} (or pass --api-key-env)")
        backend = OpenAICompatBackend(args.model or "gpt-4o-mini", args.base_url, key)
    else:
        backend = HFBackend(args.model, args.adapter)

    result = score_rows(rows, backend)

    print(f"\nbackend: {getattr(backend, 'name', args.backend)}")
    print(f"rows:    {result['rows']}")
    print(f"  JSON parseable   {result['json_rate']:6.2f}%")
    print(f"  schema valid     {result['schema_rate']:6.2f}%   <- app can parse")
    print(f"  emotion match    {result['emotion_acc']:6.2f}%")
    print(f"  tool exact match {result['tool_em']:6.2f}%")
    print(f"  SCORE            {result['score']:6.2f}")

    if result["failures"]:
        print(f"\nfirst failures ({len(result['failures'])} shown):")
        for f in result["failures"][:10]:
            print("  -", json.dumps(f, ensure_ascii=False)[:220])

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(result, indent=2))
        print(f"\nwrote {args.json_out}")

    # Oracle must be perfect; if not, the harness is wrong, not the model.
    if args.backend == "oracle" and result["score"] < 100.0:
        sys.exit("harness self-check FAILED: oracle should score 100.0")


if __name__ == "__main__":
    main()
