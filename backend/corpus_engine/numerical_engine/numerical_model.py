"""CORPUS ULTIMATE — Custom numerical engine model.

A pure-Python re-implementation of the decoder-only transformer using
the custom Tensor autodiff engine. Mirrors CorpusTransformer architecture.
"""
import math
import random
from .tensor import Tensor
from corpus_engine.config.model_config import ModelConfig


class NumericalEmbedding:
    def __init__(self, vocab_size: int, d_model: int, seed: int = 42):
        self.vocab_size = vocab_size
        self.d_model = d_model
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self.weight = Tensor(
            [[random.gauss(0, scale) for _ in range(d_model)] for _ in range(vocab_size)],
            requires_grad=True,
        )

    def forward(self, token_ids: list) -> list:
        batch = len(token_ids)
        seq = len(token_ids[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                tid = token_ids[b][t]
                if 0 <= tid < self.vocab_size:
                    row.append(self.weight.data[tid])
                else:
                    row.append([0.0] * self.d_model)
            out.append(row)
        return out

    def parameters(self):
        return [self.weight]


class NumericalPositionalEncoding:
    def __init__(self, d_model: int, context_length: int):
        self.d_model = d_model
        self.context_length = context_length
        self.table = [[math.sin(p / (10000 ** (i / d_model))) if i % 2 == 0
                       else math.cos(p / (10000 ** ((i - 1) / d_model)))
                       for i in range(d_model)] for p in range(context_length)]

    def forward(self, embeddings: list) -> list:
        batch = len(embeddings)
        seq = len(embeddings[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                pos = min(t, self.context_length - 1)
                row.append([embeddings[b][t][i] + self.table[pos][i] for i in range(self.d_model)])
            out.append(row)
        return out

    def parameters(self):
        return []


class NumericalAttention:
    def __init__(self, d_model: int, n_heads: int, seed: int = 42):
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self.W_q = Tensor([[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_model)], requires_grad=True)
        self.W_k = Tensor([[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_model)], requires_grad=True)
        self.W_v = Tensor([[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_model)], requires_grad=True)
        self.W_o = Tensor([[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_model)], requires_grad=True)

    def forward(self, x: list) -> list:
        batch = len(x)
        seq = len(x[0])
        d = self.d_model
        h = self.n_heads
        hd = self.head_dim

        def project(tensor, W):
            return [[[sum(x[b][t][i] * W.data[i][j] for i in range(d)) for j in range(d)]
                     for t in range(seq)] for b in range(batch)]

        Q = project(x, self.W_q)
        K = project(x, self.W_k)
        V = project(x, self.W_v)

        mask = [[1 if j <= i else 0 for j in range(seq)] for i in range(seq)]
        outputs = []
        for b in range(batch):
            head_outs = []
            for head in range(h):
                start = head * hd
                end = start + hd
                Qh = [[row[start:end] for row in Q[b][t]] for t in range(seq)]
                Kh = [[row[start:end] for row in K[b][t]] for t in range(seq)]
                Vh = [[row[start:end] for row in V[b][t]] for t in range(seq)]
                scores = [[sum(Qh[t][i] * Kh[s][i] for i in range(hd)) / math.sqrt(hd)
                           for s in range(seq)] for t in range(seq)]
                scores = [[scores[t][s] if mask[t][s] else -1e9 for s in range(seq)] for t in range(seq)]
                attn = _softmax_rows(scores)
                head_out = [[sum(attn[t][s] * Vh[s][i] for s in range(seq)) for i in range(hd)] for t in range(seq)]
                head_outs.append(head_out)
            concat = []
            for t in range(seq):
                row = []
                for head in range(h):
                    row.extend(head_outs[head][t])
                concat.append(row)
            outputs.append(concat)

        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                row.append([sum(outputs[b][t][i] * self.W_o.data[i][j] for i in range(d)) for j in range(d)])
            out.append(row)
        return out

    def parameters(self):
        return [self.W_q, self.W_k, self.W_v, self.W_o]


def _softmax_rows(matrix):
    out = []
    for row in matrix:
        m = max(row)
        exps = [math.exp(v - m) for v in row]
        s = sum(exps)
        out.append([v / s for v in exps])
    return out


class NumericalFFN:
    def __init__(self, d_model: int, d_ff: int, seed: int = 42):
        self.d_model = d_model
        self.d_ff = d_ff
        random.seed(seed)
        scale = 1.0 / math.sqrt(d_model)
        self.W1 = Tensor([[random.gauss(0, scale) for _ in range(d_ff)] for _ in range(d_model)], requires_grad=True)
        self.b1 = Tensor([0.0] * d_ff, requires_grad=True)
        self.W2 = Tensor([[random.gauss(0, scale) for _ in range(d_model)] for _ in range(d_ff)], requires_grad=True)
        self.b2 = Tensor([0.0] * d_model, requires_grad=True)

    def forward(self, x: list) -> list:
        batch = len(x)
        seq = len(x[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                hidden = [max(0.0, sum(x[b][t][i] * self.W1.data[i][j] for i in range(self.d_model)) + self.b1.data[j])
                          for j in range(self.d_ff)]
                row.append([sum(hidden[j] * self.W2.data[j][i] for j in range(self.d_ff)) + self.b2.data[i]
                            for i in range(self.d_model)])
            out.append(row)
        return out

    def parameters(self):
        return [self.W1, self.b1, self.W2, self.b2]


class NumericalLayerNorm:
    def __init__(self, d_model: int, eps: float = 1e-5):
        self.d_model = d_model
        self.eps = eps
        self.weight = Tensor([1.0] * d_model, requires_grad=True)
        self.bias = Tensor([0.0] * d_model, requires_grad=True)

    def forward(self, x: list) -> list:
        batch = len(x)
        seq = len(x[0])
        out = []
        for b in range(batch):
            row = []
            for t in range(seq):
                vec = x[b][t]
                mean = sum(vec) / self.d_model
                var = sum((v - mean) ** 2 for v in vec) / self.d_model
                inv = 1.0 / math.sqrt(var + self.eps)
                row.append([(v - mean) * inv * self.weight.data[i] + self.bias.data[i] for i, v in enumerate(vec)])
            out.append(row)
        return out

    def parameters(self):
        return [self.weight, self.bias]


class NumericalTransformerBlock:
    def __init__(self, d_model: int, n_heads: int, d_ff: int, seed: int = 42):
        self.attention = NumericalAttention(d_model, n_heads, seed)
        self.ffn = NumericalFFN(d_model, d_ff, seed + 1)
        self.ln1 = NumericalLayerNorm(d_model)
        self.ln2 = NumericalLayerNorm(d_model)

    def forward(self, x: list) -> list:
        normed = self.ln1.forward(x)
        attn = self.attention.forward(normed)
        x = [[[normed[b][t][i] + attn[b][t][i] for i in range(len(normed[0][0]))] for t in range(len(normed[0]))] for b in range(len(normed))]
        normed2 = self.ln2.forward(x)
        ffn = self.ffn.forward(normed2)
        out = [[[x[b][t][i] + ffn[b][t][i] for i in range(len(x[0][0]))] for t in range(len(x[0]))] for b in range(len(x))]
        return out

    def parameters(self):
        params = []
        params.extend(self.attention.parameters())
        params.extend(self.ffn.parameters())
        params.extend(self.ln1.parameters())
        params.extend(self.ln2.parameters())
        return params


class NumericalTransformer:
    """Pure-Python numerical engine transformer mirroring CorpusTransformer."""

    def __init__(self, config: dict):
        self.vocab_size = config["vocab_size"]
        self.context_length = config["context_length"]
        self.d_model = config["d_model"]
        self.n_layers = config["n_layers"]
        self.n_heads = config["n_heads"]
        self.d_ff = config["d_ff"]
        self.seed = config.get("seed", 42)

        self.token_embedding = NumericalEmbedding(self.vocab_size, self.d_model, self.seed)
        self.pos_embedding = NumericalPositionalEncoding(self.d_model, self.context_length)
        self.blocks = [NumericalTransformerBlock(self.d_model, self.n_heads, self.d_ff, self.seed + 10 + i)
                       for i in range(self.n_layers)]
        self.final_ln = NumericalLayerNorm(self.d_model)
        random.seed(self.seed)
        scale = 1.0 / math.sqrt(self.d_model)
        self.W_out = Tensor([[random.gauss(0, scale) for _ in range(self.vocab_size)] for _ in range(self.d_model)], requires_grad=True)
        self.b_out = Tensor([0.0] * self.vocab_size, requires_grad=True)

    def forward(self, token_ids: list) -> list:
        x = self.token_embedding.forward(token_ids)
        x = self.pos_embedding.forward(x)
        for block in self.blocks:
            x = block.forward(x)
        x = self.final_ln.forward(x)
        batch = len(x)
        seq = len(x[0])
        d = self.d_model
        logits = []
        for b in range(batch):
            row = []
            for t in range(seq):
                row.append([sum(x[b][t][i] * self.W_out.data[i][j] for i in range(d)) + self.b_out.data[j]
                            for j in range(self.vocab_size)])
            logits.append(row)
        return logits

    def parameters(self):
        params = []
        params.extend(self.token_embedding.parameters())
        params.extend(self.pos_embedding.parameters())
        for block in self.blocks:
            params.extend(block.parameters())
        params.extend(self.final_ln.parameters())
        params.append(self.W_out)
        params.append(self.b_out)
        return params

    def parameter_count(self) -> int:
        count = 0
        for p in self.parameters():
            if hasattr(p, 'data'):
                if isinstance(p.data[0], list):
                    count += sum(len(r) for r in p.data)
                else:
                    count += len(p.data)
        return count

    def zero_grads(self):
        for p in self.parameters():
            p.grad = None