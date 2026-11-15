"""CORPUS ULTIMATE — Decoder-only transformer model.

Combines embeddings, positional encoding, transformer blocks, and output
projection to produce logits over the vocabulary.
"""
import math
import random
from corpus_engine.layers.embedding import Embedding, PositionalEncoding
from corpus_engine.layers.transformer_block import TransformerBlock
from corpus_engine.layers.layernorm import LayerNorm


class CorpusTransformer:
    """Decoder-only language model.

    Architecture:
        Token Embedding + Positional Encoding
        -> N x TransformerBlock (MHA + FFN + residuals + LayerNorm)
        -> LayerNorm
        -> Output Projection (d_model -> vocab_size)
        -> Logits
    """

    def __init__(self, config: dict):
        self.vocab_size = config["vocab_size"]
        self.context_length = config["context_length"]
        self.d_model = config["d_model"]
        self.n_layers = config["n_layers"]
        self.n_heads = config["n_heads"]
        self.d_ff = config["d_ff"]
        self.seed = config.get("seed", 42)

        self.token_embedding = Embedding(self.vocab_size, self.d_model, self.seed)
        self.pos_embedding = PositionalEncoding(self.d_model, self.context_length)
        self.blocks = [
            TransformerBlock(self.d_model, self.n_heads, self.d_ff, self.seed + 10 + i)
            for i in range(self.n_layers)
        ]
        self.final_ln = LayerNorm(self.d_model)
        # Output projection
        self.W_out = [
            [random.gauss(0, 1.0 / math.sqrt(self.d_model)) for _ in range(self.vocab_size)]
            for _ in range(self.d_model)
        ]
        self.b_out = [0.0] * self.vocab_size
        self.W_out_grad = [[0.0] * self.vocab_size for _ in range(self.d_model)]
        self.b_out_grad = [0.0] * self.vocab_size

    def forward(self, token_ids: list) -> list:
        """Forward pass.

        Input: [batch, seq_len] ints
        Output: [batch, seq_len, vocab_size] logits
        """
        x = self.token_embedding.forward(token_ids)
        x = self.pos_embedding.forward(x)
        for block in self.blocks:
            x = block.forward(x)
        x = self.final_ln.forward(x)
        # Output projection
        batch = len(x)
        seq = len(x[0])
        logits = []
        for b in range(batch):
            row = []
            for t in range(seq):
                row.append([
                    sum(x[b][t][i] * self.W_out[i][j] for i in range(self.d_model)) + self.b_out[j]
                    for j in range(self.vocab_size)
                ])
            logits.append(row)
        return logits

    def parameters(self):
        """Return all parameter tensors (nested lists or flat lists)."""
        params = []
        params.extend(self.token_embedding.parameters())
        params.extend(self.pos_embedding.parameters())
        for block in self.blocks:
            params.extend(block.parameters())
        params.extend(self.final_ln.parameters())
        params.append(self.W_out)
        params.append(self.b_out)
        return params

    def parameter_grads(self):
        grads = []
        grads.extend(self.token_embedding.parameter_grads())
        grads.extend(self.pos_embedding.parameter_grads())
        for block in self.blocks:
            grads.extend(block.parameter_grads())
        grads.extend(self.final_ln.parameter_grads())
        grads.append(self.W_out_grad)
        grads.append(self.b_out_grad)
        return grads

    def parameter_count(self) -> int:
        count = 0
        for p in self.parameters():
            if isinstance(p, list):
                if len(p) > 0 and isinstance(p[0], list):
                    for row in p:
                        count += len(row)
                else:
                    count += len(p)
        return count

    def zero_grads(self):
        for g in self.parameter_grads():
            if isinstance(g, list):
                if len(g) > 0 and isinstance(g[0], list):
                    for row in g:
                        for i in range(len(row)):
                            row[i] = 0.0
                else:
                    for i in range(len(g)):
                        g[i] = 0.0
        self.W_out_grad = [[0.0] * self.vocab_size for _ in range(self.d_model)]
        self.b_out_grad = [0.0] * self.vocab_size

    def summary(self) -> dict:
        return {
            "vocab_size": self.vocab_size,
            "context_length": self.context_length,
            "d_model": self.d_model,
            "n_layers": self.n_layers,
            "n_heads": self.n_heads,
            "d_ff": self.d_ff,
            "total_parameters": self.parameter_count(),
        }