"""CORPUS ULTIMATE — AdamW optimizer for the custom numerical engine."""

import math


class AdamW:
    """AdamW optimizer for Tensor parameters.

    Implements decoupled weight decay.
    """

    def __init__(self, params, lr: float = 1e-3, betas=(0.9, 0.999), eps: float = 1e-8, weight_decay: float = 0.01):
        self.params = [p for p in params if p.requires_grad]
        self.lr = lr
        self.betas = betas
        self.eps = eps
        self.weight_decay = weight_decay
        self.t = 0
        self.m = [self._zeros_like(p.data) for p in self.params]
        self.v = [self._zeros_like(p.data) for p in self.params]

    def _zeros_like(self, x):
        if isinstance(x[0], list):
            return [[0.0 for _ in row] for row in x]
        return [0.0 for _ in x]

    def step(self):
        self.t += 1
        for i, p in enumerate(self.params):
            if p.grad is None:
                continue
            grad = p.grad
            # Update biased moments
            self.m[i] = [[self.betas[0] * self.m[i][r][c] + (1 - self.betas[0]) * grad[r][c]
                          for c in range(len(grad[0]))] for r in range(len(grad))] if isinstance(grad[0], list) else \
                [self.betas[0] * self.m[i][j] + (1 - self.betas[0]) * grad[j] for j in range(len(grad))]
            self.v[i] = [[self.betas[1] * self.v[i][r][c] + (1 - self.betas[1]) * grad[r][c] ** 2
                          for c in range(len(grad[0]))] for r in range(len(grad))] if isinstance(grad[0], list) else \
                [self.betas[1] * self.v[i][j] + (1 - self.betas[1]) * grad[j] ** 2 for j in range(len(grad))]
            # Bias correction
            m_hat = [[self.m[i][r][c] / (1 - self.betas[0] ** self.t) for c in range(len(self.m[i][0]))] for r in range(len(self.m[i]))] if isinstance(self.m[i][0], list) else \
                [self.m[i][j] / (1 - self.betas[0] ** self.t) for j in range(len(self.m[i]))]
            v_hat = [[self.v[i][r][c] / (1 - self.betas[1] ** self.t) for c in range(len(self.v[i][0]))] for r in range(len(self.v[i]))] if isinstance(self.v[i][0], list) else \
                [self.v[i][j] / (1 - self.betas[1] ** self.t) for j in range(len(self.v[i]))]
            # Update
            if isinstance(p.data[0], list):
                for r in range(len(p.data)):
                    for c in range(len(p.data[0])):
                        p.data[r][c] -= self.lr * (m_hat[r][c] / (math.sqrt(v_hat[r][c]) + self.eps) + self.weight_decay * p.data[r][c])
            else:
                for j in range(len(p.data)):
                    p.data[j] -= self.lr * (m_hat[j] / (math.sqrt(v_hat[j]) + self.eps) + self.weight_decay * p.data[j])

    def zero_grad(self):
        for p in self.params:
            p.grad = None