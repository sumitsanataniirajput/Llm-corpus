"""CORPUS ULTIMATE — Causal multi-head self-attention."""

import math
from typing import List, Tuple


def softmax(x: list, dim: int = -1) -> list:
    """Softmax along the last dimension."""
    out = []
    for row in x:
        m = max(row)
        exps = [math.exp(v - m) for v in row]
        s = sum(exps)
        out.append([v / s for v in exps])
    return out


def causal_mask(seq_len: int) -> list:
    """Lower-triangular causal mask (1 = allowed, 0 = masked)."""
    return [[1 if j <= i else 0 for j in range(seq_len)] for i in range(seq_len)]


class MultiHeadAttention:
    """Multi-head causal self-attention.

    Parameters:
        W_q, W_k, W_v, W_o: [d_model, d_model]
    """

    def __init__(self, d_model: int, n_heads: int, seed: int = 42):
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        import random
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self._init_matrix = lambda rows, cols: [
            [random.gauss(0, scale) for _ in range(cols)] for _ in range(rows)
        ]
        self.W_q = self._init_matrix(d_model, d_model)
        self.W_k = self._init_matrix(d_model, d_model)
        self.W_v = self._init_matrix(d_model, d_model)
        self.W_o = self._init_matrix(d_model, d_model)
        # Gradients
        self.W_q_grad = [[0.0] * d_model for _ in range(d_model)]
        self.W_k_grad = [[0.0] * d_model for _ in range(d_model)]
        self.W_v_grad = [[0.0] * d_model for _ in range(d_model)]
        self.W_o_grad = [[0.0] * d_model for _ in range(d_model)]

    def _matmul(self, A: list, B: list) -> list:
        rows_a, cols_a = len(A), len(A[0])
        rows_b, cols_b = len(B), len(B[0])
        assert cols_a == rows_b
        out = [[0.0] * cols_b for _ in range(rows_a)]
        for i in range(rows_a):
            for k in range(cols_a):
                aik = A[i][k]
                if aik == 0:
                    continue
                for j in range(cols_b):
                    out[i][j] += aik * B[k][j]
        return out

    def forward(self, x: list) -> list:
        """Input: [batch, seq_len, d_model]. Output: same shape."""
        batch = len(x)
        seq = len(x[0])
        d = self.d_model
        h = self.n_heads
        hd = self.head_dim

        # Project to Q, K, V
        Q = [[self._matmul([x[b][t]], self.W_q)[0] for t in range(seq)] for b in range(batch)]
        K = [[self._matmul([x[b][t]], self.W_k)[0] for t in range(seq)] for b in range(batch)]
        V = [[self._matmul([x[b][t]], self.W_v)[0] for t in range(seq)] for b in range(batch)]

        # Reshape to heads: [batch, heads, seq, head_dim]
        def split_heads(tensor):
            out = []
            for b in range(batch):
                heads = []
                for head in range(h):
                    start = head * hd
                    end = start + hd
                    heads.append([[tensor[b][t][i] for i in range(start, end)] for t in range(seq)])
                out.append(heads)
            return out

        Qh, Kh, Vh = split_heads(Q), split_heads(K), split_heads(V)

        # Attention scores per head
        mask = causal_mask(seq)
        outputs = []
        for b in range(batch):
            head_outs = []
            for head in range(h):
                # scores: [seq, head_dim] x [head_dim, seq] = [seq, seq]
                scores = self._matmul(Qh[b][head], [[Kh[b][head][t][i] for t in range(seq)] for i in range(hd)])
                # scale
                scores = [[v / math.sqrt(hd) for v in row] for row in scores]
                # causal mask
                scores = [[scores[i][j] if mask[i][j] else -1e9 for j in range(seq)] for i in range(seq)]
                # softmax
                attn = softmax(scores)
                # weighted sum: [seq, seq] x [seq, head_dim] = [seq, head_dim]
                head_out = self._matmul(attn, Vh[b][head])
                head_outs.append(head_out)
            # Concatenate heads: [seq, d_model]
            concat = []
            for t in range(seq):
                row = []
                for head in range(h):
                    row.extend(head_outs[head][t])
                concat.append(row)
            outputs.append(concat)

        # Output projection
        out = []
        for b in range(batch):
            out.append([self._matmul([outputs[b][t]], self.W_o)[0] for t in range(seq)])
        return out

    def backward(self, x: list, grad_output: list):
        """Placeholder backprop — stores zero gradients for compatibility."""
        self.W_q_grad = [[0.0] * self.d_model for _ in range(self.d_model)]
        self.W_k_grad = [[0.0] * self.d_model for _ in range(self.d_model)]
        self.W_v_grad = [[0.0] * self.d_model for _ in range(self.d_model)]
        self.W_o_grad = [[0.0] * self.d_model for _ in range(self.d_model)]

    def parameters(self):
        return [self.W_q, self.W_k, self.W_v, self.W_o]

    def parameter_grads(self):
        return [self.W_q_grad, self.W_k_grad, self.W_v_grad, self.W_o_grad]