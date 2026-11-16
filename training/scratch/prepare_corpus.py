#!/usr/bin/env python3
"""
Build the from-scratch corpus: compact text + trained tokenizer + token ids.

    python prepare_corpus.py

Steps:
  1. read the full-format dataset from ../aria/data/train.jsonl
  2. convert each row to the compact format (format.py)
  3. train a byte-level BPE tokenizer on it (tokenizer.py)
  4. encode the whole corpus to a uint16 array for fast windowing

uint16 caps the vocab at 65,536 -- we use 1,024, so it's safe and halves the
memory versus int64.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

from format import build_corpus
from tokenizer import BPETokenizer

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent / "aria" / "data" / "train.jsonl"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--vocab-size", type=int, default=1024)
    ap.add_argument("--out-dir", type=Path, default=HERE)
    args = ap.parse_args()

    if not args.data.exists():
        raise SystemExit(
            f"{args.data} not found.\n"
            "run: python training/aria/generate_dataset.py --total 6000"
        )

    t0 = time.time()
    corpus = build_corpus(args.data)
    print(f"corpus: {len(corpus):,} chars ({time.time() - t0:.1f}s)")

    (args.out_dir / "corpus.txt").write_text(corpus, encoding="utf-8")

    t0 = time.time()
    tok = BPETokenizer.train(corpus, vocab_size=args.vocab_size)
    print(f"tokenizer: vocab {tok.vocab_size} ({time.time() - t0:.1f}s)")
    tok.save(args.out_dir / "tokenizer.json")

    t0 = time.time()
    ids = np.array(tok.encode(corpus), dtype=np.uint16)
    np.save(args.out_dir / "tokens.npy", ids)
    print(f"encoded: {len(ids):,} tokens, "
          f"{len(corpus) / len(ids):.2f} chars/token ({time.time() - t0:.1f}s)")

    if tok.vocab_size > 65536:
        raise SystemExit("vocab exceeds uint16 range")

    print(f"\nartifacts in {args.out_dir}:")
    for name in ("corpus.txt", "tokenizer.json", "tokens.npy"):
        p = args.out_dir / name
        print(f"  {name:16s} {p.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
