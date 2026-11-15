"""CORPUS ULTIMATE — Token and positional embedding layers."""

import math
from typing import Tuple


class Embedding:
    """Token embedding lookup table.

    Parameters:
        weight: [vocab_size, d_model]
    """

    def __init__(self, vocab_size: int, d_model: int, seed: int = 42):
        self.vocab_size = vocab_size
        self.d_model = d_model
        import random
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self.weight = [
            [random.gauss(0, scale) for _ in range(d_model)]
            for _ in range(vocab_size)
        ]
        self.weight_grad = [[0.0] * d_model for _ in range(vocab_size)]

    def forward(self, token_ids: list) -> list:
        """Lookup embeddings for token IDs.

        Input: [batch, seq_len] of ints
        Output: [batch, seq_len, d_model]
        """
        batch = len(token_ids)
        seq = len(token_ids[0]) if batch else 0
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                tid = token_ids[b][t]
                if 0 <= tid < self.vocab_size:
                    row.append(list(self.weight[tid]))
                else:
                    row.append([0.0] * self.d_model)
            out.append(row)
        return out

    def backward(self, token_ids: list, grad_output: list):
        """Accumulate gradients into weight_grad."""
        self.weight_grad = [[0.0] * self.d_model for _ in range(self.vocab_size)]
        for b in range(len(token_ids)):
            for t in range(len(token_ids[b])):
                tid = token_ids[b][t]
                if 0 <= tid < self.vocab_size:
                    for d in range(self.d_model):
                        self.weight_grad[tid][d] += grad_output[b][t][d]

    def parameters(self):
        return [self.weight]

    def parameter_grads(self):
        return [self.weight_grad]


class PositionalEncoding:
    """Sinusoidal positional encoding (fixed, no parameters).

    Output added to token embeddings.
    """

    def __init__(self, d_model: int, context_length: int):
        self.d_model = d_model
        self.context_length = context_length
        self.table = self._build_table()

    def _build_table(self) -> list:
        table = []
        for pos in range(self.context_length):
            row = []
            for i in range(self.d_model):
                if i % 2 == 0:
                    val = math.sin(pos / (10000 ** (i / self.d_model)))
                else:
                    val = math.cos(pos / (10000 ** ((i - 1) / self.d_model)))
                row.append(val)
            table.append(row)
        return table

    def forward(self, embeddings: list) -> list:
        """Add positional encodings to embeddings.

        Input: [batch, seq_len, d_model]
        Output: [batch, seq_len, d_model]
        """
        batch = len(embeddings)
        seq = len(embeddings[0]) if batch else 0
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                pos = min(t, self.context_length - 1)
                row.append([
                    embeddings[b][t][i] + self.table[pos][i]
                    for i in range(self.d_model)
                ])
            out.append(row)
        return out

    def backward(self, grad_output: list) -> list:
        """Positional encoding has no parameters; pass gradient through."""
        return grad_output

    def parameters(self):
        return []

    def parameter_grads(self):
        return []


import math