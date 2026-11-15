"""CORPUS ULTIMATE — Tokenizer implementation.

A simple byte-pair-style word/subword tokenizer built from scratch.
Supports training on a corpus, encoding/decoding, and vocabulary management.
"""
import re
import json
from collections import Counter
from typing import List, Dict, Optional


class CorpusTokenizer:
    """Character-level + subword tokenizer.

    Builds a vocabulary from a training corpus and encodes text as token IDs.
    """

    def __init__(self, vocab_size: int = 5000, special_tokens: Optional[Dict[str, int]] = None):
        self.vocab_size = vocab_size
        self.special_tokens = special_tokens or {
            "<pad>": 0,
            "<unk>": 1,
            "<bos>": 2,
            "<eos>": 3,
        }
        self.id_to_token: Dict[int, str] = {v: k for k, v in self.special_tokens.items()}
        self.token_to_id: Dict[str, int] = dict(self.special_tokens)
        self._trained = False

    def train(self, texts: List[str]):
        """Train the tokenizer on a list of texts.

        Builds a vocabulary of the most common characters/subwords.
        """
        counter = Counter()
        for text in texts:
            # Split into characters and common 2-char subwords
            for ch in text:
                counter[ch] += 1
            for i in range(len(text) - 1):
                counter[text[i:i + 2]] += 1

        # Reserve special token IDs
        next_id = len(self.special_tokens)
        for token, _ in counter.most_common(self.vocab_size - len(self.special_tokens)):
            if token not in self.token_to_id:
                self.token_to_id[token] = next_id
                self.id_to_token[next_id] = token
                next_id += 1

        self._trained = True

    def encode(self, text: str, add_special: bool = True) -> List[int]:
        """Encode text into token IDs."""
        ids = []
        if add_special:
            ids.append(self.special_tokens["<bos>"])
        i = 0
        while i < len(text):
            # Try longest match first (2 chars, then 1)
            matched = False
            for length in (2, 1):
                if i + length <= len(text):
                    sub = text[i:i + length]
                    if sub in self.token_to_id:
                        ids.append(self.token_to_id[sub])
                        i += length
                        matched = True
                        break
            if not matched:
                ids.append(self.special_tokens["<unk>"])
                i += 1
        if add_special:
            ids.append(self.special_tokens["<eos>"])
        return ids

    def decode(self, ids: List[int], skip_special: bool = True) -> str:
        """Decode token IDs back to text."""
        tokens = []
        for id_ in ids:
            if skip_special and id_ in self.special_tokens.values():
                continue
            tokens.append(self.id_to_token.get(id_, "<unk>"))
        return "".join(tokens)

    def vocab(self) -> Dict[str, int]:
        return dict(self.token_to_id)

    def save(self, path: str):
        data = {
            "vocab_size": self.vocab_size,
            "special_tokens": self.special_tokens,
            "token_to_id": self.token_to_id,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "CorpusTokenizer":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tok = cls(vocab_size=data["vocab_size"], special_tokens=data["special_tokens"])
        tok.token_to_id = data["token_to_id"]
        tok.id_to_token = {int(v): k for k, v in data["token_to_id"].items()}
        tok._trained = True
        return tok

    def get_vocab_size(self) -> int:
        return len(self.token_to_id)