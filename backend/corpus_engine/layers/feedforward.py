"""CORPUS ULTIMATE — Feed-forward network layer."""

import math
import random
from typing import List


class FeedForward:
    """Position-wise feed-forward network.

    Parameters:
        W1: [d_model, d_ff], b1: [d_ff]
        W2: [d_ff, d_model], b2: [d_model]
    """

    def __init__(self, d_model: int, d_ff: int, seed: int = 42):
        self.d_model = d_model
        self.d_ff = d_ff
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self.W1 = [[random.gauss(0, scale) for _ in range(d_ff)] for _ in range(d_model)]
        self.b1 = [0.0] * d_ff
        self.W2 = [[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_ff)]
        self.b2 = [0.0] * d_model
        self.W1_grad = [[0.0] * d_ff for _ in range(d_model)]
        self.b1_grad = [0.0] * d_ff
        self.W2_grad = [[0.0] * d_model for _ in range(d_ff)]
        self.b2_grad = [0.0] * d_model

    def _relu(self, x: list) -> list:
        return [max(0.0, v) for v in x]

    def forward(self, x: list) -> list:
        """Input: [batch, seq, d_model]. Output: same shape."""
        batch = len(x)
        seq = len(x[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                # x[t] @ W1 + b1
                hidden = [sum(x[b][t][i] * self.W1[i][j] for i in range(self.d_model)) + self.b1[j]
                          for j in range(self.d_ff)]
                hidden = self._relu(hidden)
                # hidden @ W2 + b2
                row.append([sum(hidden[j] * self.W2[j][i] for j in range(self.d_ff)) + self.b2[i]
                            for i in range(self.d_model)])
            out.append(row)
        return out

    def backward(self, x: list, grad_output: list):
        self.W1_grad = [[0.0] * self.d_ff for _ in range(self.d_model)]
        self.b1_grad = [0.0] * self.d_ff
        self.W2_grad = [[0.0] * self.d_model for _ in range(self.d_ff)]
        self.b2_grad = [0.0] * self.d_model

    def parameters(self):
        return [self.W1, self.b1, self.W2, self.b2]

    def parameter_grads(self):
        return [self.W1_grad, self.b1_grad, self.W2_grad, self.b2_grad]