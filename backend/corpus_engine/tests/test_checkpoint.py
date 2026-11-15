"""Unit tests for checkpoint save/load."""
import pytest
import os
import tempfile
from corpus_engine.model.transformer import CorpusTransformer
from corpus_engine.config.model_config import ModelConfig
from corpus_engine.checkpoint.checkpoint import save, load
from corpus_engine.optimizers.adamw import AdamW
from corpus_engine.numerical_engine.tensor import Tensor


def test_checkpoint_save_load(tmp_path):
    cfg = ModelConfig(vocab_size=50, context_length=8, d_model=16, n_layers=1, n_heads=4, d_ff=32)
    model = CorpusTransformer(cfg.to_dict())

    path = tmp_path / "ckpt.json"
    save(model, None, cfg.to_dict(), str(path))
    assert os.path.exists(path)

    # Capture params before
    before = []
    for p in model.parameters():
        if isinstance(p[0], list):
            before.append([row[:] for row in p])
        else:
            before.append(p[:])

    # Modify params
    model.parameters()[0][0][0] = 999.0

    # Load checkpoint
    load(model, None, str(path))

    # Verify restored
    after = model.parameters()[0]
    assert after[0][0] == before[0][0][0], "Checkpoint should restore parameters"