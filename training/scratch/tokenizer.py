"""
Byte-level BPE tokenizer, implemented from scratch.

No HuggingFace, no downloads -- we train our own merges on the Aria corpus.
Starting from raw bytes guarantees the tokenizer can encode *any* text
(including the JSON braces, quotes and emoji Aria might emit), which matters
more than vocabulary efficiency at this scale.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

BASE = 256  # all single bytes are valid tokens


class BPETokenizer:
    def __init__(self, merges: list[tuple[int, int]] | None = None):
        self.merges: list[tuple[int, int]] = merges or []
        # rank maps a pair -> merge priority (lower = earlier)
        self.rank = {pair: i for i, pair in enumerate(self.merges)}
        self.vocab_size = BASE + len(self.merges)

        # Build token -> bytes table for decoding (id 0..255 are raw bytes).
        table: dict[int, bytes] = {i: bytes([i]) for i in range(BASE)}
        for i, (a, b) in enumerate(self.merges):
            table[BASE + i] = table[a] + table[b]
        self.table = table

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    @classmethod
    def train(cls, text: str, vocab_size: int = 1024, verbose: bool = False) -> "BPETokenizer":
        n_merges = vocab_size - BASE
        data = list(text.encode("utf-8"))

        merges: list[tuple[int, int]] = []
        rank: dict[tuple[int, int], int] = {}

        for step in range(n_merges):
            pairs = Counter(zip(data, data[1:]))
            if not pairs:
                break
            pair, count = pairs.most_common(1)[0]
            if count < 2:
                break

            a, b = pair
            new_id = BASE + len(merges)
            rank[pair] = len(merges)
            merges.append(pair)

            # Rebuild the sequence, splicing in the merged token.
            out: list[int] = []
            i = 0
            n = len(data)
            while i < n:
                if i < n - 1 and data[i] == a and data[i + 1] == b:
                    out.append(new_id)
                    i += 2
                else:
                    out.append(data[i])
                    i += 1
            data = out

            if verbose and (step + 1) % 100 == 0:
                print(f"  merge {step + 1}/{n_merges}: {pair} -> {new_id} "
                      f"(count {count}, len {len(data)})")

        tok = cls(merges)
        if verbose:
            print(f"  vocab {tok.vocab_size}, compression "
                  f"{len(text.encode('utf-8')) / max(1, len(tok.encode(text))):.2f}x")
        return tok

    # ------------------------------------------------------------------
    # Encode / decode
    # ------------------------------------------------------------------

    def _merge_chunk(self, ids: list[int]) -> list[int]:
        """Apply learned merges to one chunk of byte ids, greedily by rank."""
        while len(ids) > 1:
            pairs = set(zip(ids, ids[1:]))
            # pick the pair with the best (lowest) rank
            best = None
            best_rank = None
            for p in pairs:
                r = self.rank.get(p)
                if r is not None and (best_rank is None or r < best_rank):
                    best, best_rank = p, r
            if best is None:
                break
            a, b = best
            new_id = BASE + best_rank
            out: list[int] = []
            i = 0
            n = len(ids)
            while i < n:
                if i < n - 1 and ids[i] == a and ids[i + 1] == b:
                    out.append(new_id)
                    i += 2
                else:
                    out.append(ids[i])
                    i += 1
            ids = out
        return ids

    def encode(self, text: str) -> list[int]:
        if not text:
            return []
        ids = list(text.encode("utf-8"))
        # Merging across the whole sequence is O(n^2); splitting on whitespace
        # boundaries keeps it fast and costs nothing here because most merges
        # are within words anyway.
        out: list[int] = []
        buf: list[int] = []
        for byte in ids:
            buf.append(byte)
            if byte == 0x20:  # space: flush (keep the space in the buffer)
                out.extend(self._merge_chunk(buf))
                buf = []
        if buf:
            out.extend(self._merge_chunk(buf))
        return out

    def decode(self, ids: list[int]) -> str:
        return b"".join(self.table[i] for i in ids).decode("utf-8", errors="replace")

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        path.write_text(json.dumps({"merges": self.merges, "vocab_size": self.vocab_size}))

    @classmethod
    def load(cls, path: Path) -> "BPETokenizer":
        d = json.loads(Path(path).read_text())
        return cls([tuple(p) for p in d["merges"]])


if __name__ == "__main__":
    import sys

    corpus_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/train.jsonl")
    rows = [json.loads(l) for l in corpus_path.open(encoding="utf-8")]
    text = "\n".join(
        m["content"] for r in rows for m in r["messages"]
    )
    print(f"corpus: {len(text):,} chars")
    tok = BPETokenizer.train(text, vocab_size=1024, verbose=True)
    tok.save(Path("tokenizer.json"))

    sample = '{"sentences": [{"text": "Yay!", "emotion": "excited", "intensity": 2}]}'
    enc = tok.encode(sample)
    print(f"\nroundtrip ok: {tok.decode(enc) == sample}")
    print(f"{len(sample)} chars -> {len(enc)} tokens")
