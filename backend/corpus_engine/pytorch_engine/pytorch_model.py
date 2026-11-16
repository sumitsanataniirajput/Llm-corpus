"""CORPUS ULTIMATE — PyTorch engine model.

Real torch.nn decoder-only transformer. Mirrors the custom architecture
but uses PyTorch primitives for GPU/CPU training.
"""
import torch
import torch.nn as nn
import math


class CorpusTransformerPT(nn.Module):
    """Decoder-only transformer implemented with torch.nn."""

    def __init__(self, config: dict):
        super().__init__()
        self.vocab_size = config["vocab_size"]
        self.context_length = config["context_length"]
        self.d_model = config["d_model"]
        self.n_layers = config["n_layers"]
        self.n_heads = config["n_heads"]
        self.d_ff = config["d_ff"]

        self.token_embedding = nn.Embedding(self.vocab_size, self.d_model)
        self.pos_embedding = nn.Embedding(self.context_length, self.d_model)
        self.dropout = nn.Dropout(config.get("dropout", 0.1))

        # A causal TransformerEncoder is used as a decoder-only stack.
        # TransformerDecoder with the same tensor as target and memory leaks
        # future tokens through the unmasked memory-attention path.
        decoder_layer = nn.TransformerEncoderLayer(
            d_model=self.d_model,
            nhead=self.n_heads,
            dim_feedforward=self.d_ff,
            dropout=config.get("dropout", 0.1),
            batch_first=True,
            norm_first=True,
        )
        self.decoder = nn.TransformerEncoder(decoder_layer, num_layers=self.n_layers)
        self.final_ln = nn.LayerNorm(self.d_model)
        self.output_projection = nn.Linear(self.d_model, self.vocab_size)

        # Causal mask buffer
        self.register_buffer("causal_mask", self._build_causal_mask(self.context_length))

    @staticmethod
    def _build_causal_mask(size: int):
        mask = torch.triu(torch.ones(size, size) * float("-inf"), diagonal=1)
        return mask

    def forward(self, token_ids: torch.Tensor) -> torch.Tensor:
        """token_ids: [batch, seq_len] -> logits: [batch, seq_len, vocab_size]"""
        batch, seq = token_ids.shape
        positions = torch.arange(seq, device=token_ids.device).unsqueeze(0).expand(batch, seq)
        x = self.token_embedding(token_ids) + self.pos_embedding(positions)
        x = self.dropout(x)
        mask = self.causal_mask[:seq, :seq]
        x = self.decoder(x, mask=mask)
        x = self.final_ln(x)
        logits = self.output_projection(x)
        return logits

    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters() if p.requires_grad)

    def summary(self) -> dict:
        return {
            "vocab_size": self.vocab_size,
            "context_length": self.context_length,
            "d_model": self.d_model,
            "n_layers": self.n_layers,
            "n_heads": self.n_heads,
            "d_ff": self.d_ff,
            "total_parameters": self.parameter_count(),
            "engine": "pytorch",
        }