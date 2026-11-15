"""Unit tests for forward pass of custom transformer."""
import pytest
from corpus_engine.model.transformer import CorpusTransformer
from corpus_engine.config.model_config import ModelConfig


def test_forward_pass_shape():
    cfg = ModelConfig(vocab_size=100, context_length=16, d_model=32, n_layers=2, n_heads=4, d_ff=64)
    model = CorpusTransformer(cfg.to_dict())
    token_ids = [[1, 2, 3, 4], [5, 6, 7, 8]]
    logits = model.forward(token_ids)
    assert len(logits) == 2
    assert len(logits[0]) == 4
    assert len(logits[0][0]) == 100


def test_parameter_count_matches_config():
    cfg = ModelConfig(vocab_size=100, context_length=16, d_model=32, n_layers=2, n_heads=4, d_ff=64)
    model = CorpusTransformer(cfg.to_dict())
    assert model.parameter_count() == cfg.parameter_count()


def test_summary():
    cfg = ModelConfig(vocab_size=100, context_length=16, d_model=32, n_layers=2, n_heads=4, d_ff=64)
    model = CorpusTransformer(cfg.to_dict())
    summary = model.summary()
    assert summary["total_parameters"] > 0
    assert summary["n_layers"] == 2