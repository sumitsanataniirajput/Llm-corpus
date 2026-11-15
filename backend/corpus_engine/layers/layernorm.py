"""CORPUS ULTIMATE — Layer normalization."""

import math
from typing import List


class LayerNorm:
    """Layer normalization with learnable gain and bias.

    Parameters:
        weight: [d_model], bias: [d_model]
    """

    def __init__(self, d_model: int, eps: float = 1e-5):
        self.d_model = d_model
        self.eps = eps
        self.weight = [1.0] * d_model
        self.bias = [0.0] * d_model
        self.weight_grad = [0.0] * d_model
        self.bias_grad = [0.0] * d_model

    def forward(self, x: list) -> list:
        """Input: [batch, seq, d_model]. Output: same shape."""
        batch = len(x)
        seq = len(x[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                vec = x[b][t]
                mean = sum(vec) / self.d_model
                var = sum((v - mean) ** 2 for v in vec) / self.d_model
                inv_std = 1.0 / math.sqrt(var + self.eps)
                row.append([(v - mean) * inv_std * self.weight[i] + self.bias[i]
                            for i, v in enumerate(vec)])
            out.append(row)
        return out

    def backward(self, x: list, grad_output: list):
        self.weight_grad = [0.0] * self.d_model
        self.bias_grad = [0.0] * self.d_model

    def parameters(self):
        return [self.weight, self.bias]

    def parameter_grads(self):
        return [self.weight_grad, self.bias_grad]