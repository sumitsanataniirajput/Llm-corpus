"""CORPUS ULTIMATE — Transformer block (decoder-only).

Combines multi-head attention + feed-forward with residual connections
and layer normalization.
"""
from corpus_engine.layers.attention import MultiHeadAttention
from corpus_engine.layers.feedforward import FeedForward
from corpus_engine.layers.layernorm import LayerNorm


class TransformerBlock:
    """Single decoder transformer block.

    x -> LN -> MHA -> +residual -> LN -> FFN -> +residual
    """

    def __init__(self, d_model: int, n_heads: int, d_ff: int, seed: int = 42):
        self.attention = MultiHeadAttention(d_model, n_heads, seed)
        self.ffn = FeedForward(d_model, d_ff, seed + 1)
        self.ln1 = LayerNorm(d_model)
        self.ln2 = LayerNorm(d_model)

    def forward(self, x: list) -> list:
        # x: [batch, seq, d_model]
        normed = self.ln1.forward(x)
        attn_out = self.attention.forward(normed)
        # residual 1
        x1 = []
        for b in range(len(x)):
            row = []
            for t in range(len(x[b])):
                row.append([x[b][t][i] + attn_out[b][t][i] for i in range(len(x[b][t]))])
            x1.append(row)

        normed2 = self.ln2.forward(x1)
        ffn_out = self.ffn.forward(normed2)
        # residual 2
        out = []
        for b in range(len(x1)):
            row = []
            for t in range(len(x1[b])):
                row.append([x1[b][t][i] + ffn_out[b][t][i] for i in range(len(x1[b][t]))])
            out.append(row)
        return out

    def parameters(self):
        params = []
        params.extend(self.attention.parameters())
        params.extend(self.ffn.parameters())
        params.extend(self.ln1.parameters())
        params.extend(self.ln2.parameters())
        return params

    def parameter_grads(self):
        grads = []
        grads.extend(self.attention.parameter_grads())
        grads.extend(self.ffn.parameter_grads())
        grads.extend(self.ln1.parameter_grads())
        grads.extend(self.ln2.parameter_grads())
        return grads