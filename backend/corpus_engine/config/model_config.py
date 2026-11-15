"""CORPUS ULTIMATE — Model configuration.

Defines the decoder-only transformer architecture hyperparameters.
"""
from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class ModelConfig:
    """Configuration for a Corpus decoder-only transformer.

    All dimensions must be valid: d_model % n_heads == 0.
    """
    vocab_size: int = 5000
    context_length: int = 256
    d_model: int = 256
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 1024
    dropout: float = 0.1
    seed: int = 42

    def validate(self) -> dict:
        errors = []
        if self.vocab_size < 100:
            errors.append("vocab_size must be >= 100")
        if self.context_length < 16:
            errors.append("context_length must be >= 16")
        if self.d_model < 16:
            errors.append("d_model must be >= 16")
        if self.n_layers < 1:
            errors.append("n_layers must be >= 1")
        if self.n_heads < 1:
            errors.append("n_heads must be >= 1")
        if self.d_model % self.n_heads != 0:
            errors.append("d_model must be divisible by n_heads")
        if self.d_ff < 32:
            errors.append("d_ff must be >= 32")
        return {"valid": len(errors) == 0, "errors": errors}

    def parameter_count(self) -> int:
        """Calculate actual total parameters from this configuration.

        Matches the instantiated CorpusTransformer:
        - Embeddings: token [v,d] only (positional encoding is fixed sinusoidal, no params)
        - Per layer: attention [4*d*d] + FFN [W1 d*f + b1 f + W2 f*d + b2 d] + 2 LayerNorms [2*2*d]
        - Final LayerNorm: [2*d]
        - Output: W_out [d*v] + b_out [v]
        """
        v, c, d, L, h, f = (
            self.vocab_size, self.context_length, self.d_model,
            self.n_layers, self.n_heads, self.d_ff,
        )
        embeddings = v * d  # token only; positional is fixed
        per_layer = (4 * d * d) + (d * f + f + f * d + d) + (4 * d)
        final_ln = 2 * d
        output = d * v + v
        return embeddings + L * per_layer + final_ln + output

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ModelConfig":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    def small_cpu_config() -> "ModelConfig":
        """A small configuration suitable for CPU experimentation."""
        return ModelConfig(
            vocab_size=2000,
            context_length=128,
            d_model=128,
            n_layers=2,
            n_heads=4,
            d_ff=512,
        )