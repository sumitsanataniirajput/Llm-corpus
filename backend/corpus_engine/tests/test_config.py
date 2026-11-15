"""Unit tests for model configuration."""
import pytest
from corpus_engine.config.model_config import ModelConfig


def test_default_config_valid():
    cfg = ModelConfig()
    result = cfg.validate()
    assert result["valid"] is True
    assert result["errors"] == []


def test_invalid_dimensions():
    cfg = ModelConfig(d_model=256, n_heads=5)  # 256 % 5 != 0
    result = cfg.validate()
    assert result["valid"] is False
    assert any("divisible" in e for e in result["errors"])


def test_small_cpu_config():
    cfg = ModelConfig.small_cpu_config()
    result = cfg.validate()
    assert result["valid"] is True
    assert cfg.parameter_count() > 0


def test_parameter_count():
    cfg = ModelConfig(vocab_size=1000, context_length=128, d_model=128, n_layers=2, n_heads=4, d_ff=512)
    count = cfg.parameter_count()
    assert count > 0
    # Embeddings: token only (positional is fixed)
    expected = 1000 * 128
    per_layer = (4 * 128 * 128) + (128 * 512 + 512 + 512 * 128 + 128) + (4 * 128)
    expected += 2 * per_layer
    expected += 2 * 128  # final LayerNorm
    expected += 128 * 1000 + 1000  # output W + b
    assert count == expected