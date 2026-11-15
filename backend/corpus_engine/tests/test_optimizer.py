"""Unit tests for AdamW optimizer."""
import pytest
from corpus_engine.optimizers.adamw import AdamW
from corpus_engine.numerical_engine.tensor import Tensor


def test_adamw_step_changes_params():
    p1 = Tensor([[1.0, 2.0], [3.0, 4.0]], requires_grad=True)
    p2 = Tensor([0.5, -0.5], requires_grad=True)
    opt = AdamW([p1, p2], lr=0.1)

    # Set gradients manually
    p1.grad = [[0.1, 0.1], [0.1, 0.1]]
    p2.grad = [0.1, -0.1]

    before = [row[:] for row in p1.data]
    opt.step()
    after = p1.data
    changed = any(before[r][c] != after[r][c] for r in range(2) for c in range(2))
    assert changed, "AdamW should change parameters"


def test_adamw_zero_grad():
    p = Tensor([1.0, 2.0], requires_grad=True)
    p.grad = [0.1, 0.1]
    opt = AdamW([p], lr=0.1)
    opt.zero_grad()
    assert p.grad is None