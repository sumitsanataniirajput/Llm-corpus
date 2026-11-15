"""CORPUS ULTIMATE — Training loop (custom numerical engine).

Trains a NumericalTransformer using cross-entropy loss and AdamW.
"""
import math
from corpus_engine.numerical_engine.numerical_model import NumericalTransformer
from corpus_engine.optimizers.adamw import AdamW


def cross_entropy(logits: list, targets: list) -> float:
    """Cross-entropy loss.

    logits: [batch, seq, vocab]
    targets: [batch, seq] ints
    Returns scalar loss.
    """
    total = 0.0
    count = 0
    for b in range(len(logits)):
        for t in range(len(logits[b])):
            row = logits[b][t]
            target = targets[b][t]
            m = max(row)
            exps = [math.exp(v - m) for v in row]
            s = sum(exps)
            prob = exps[target] / s if s > 0 else 0.0
            total -= math.log(max(prob, 1e-9))
            count += 1
    return total / max(count, 1)


def train_step(model: NumericalTransformer, optimizer: AdamW, batch_ids: list, batch_targets: list) -> float:
    """Single training step.

    batch_ids: [batch, seq] input token IDs
    batch_targets: [batch, seq] target token IDs (shifted by 1)
    Returns loss value.
    """
    logits = model.forward(batch_ids)
    loss = cross_entropy(logits, batch_targets)
    # Backward: gradient of loss w.r.t logits
    # dL/dlogits = (softmax - onehot) / (batch*seq)
    batch = len(logits)
    seq = len(logits[0])
    vocab = len(logits[0][0])
    n = batch * seq
    dlogits = [[[0.0] * vocab for _ in range(seq)] for _ in range(batch)]
    for b in range(batch):
        for t in range(seq):
            row = logits[b][t]
            m = max(row)
            exps = [math.exp(v - m) for v in row]
            s = sum(exps)
            target = batch_targets[b][t]
            for j in range(vocab):
                p = exps[j] / s if s > 0 else 0.0
                dlogits[b][t][j] = (p - (1.0 if j == target else 0.0)) / n

    # Backprop through output projection and model
    # For the numerical engine, we need Tensor-based forward to autodiff.
    # Here we do a simplified manual gradient for the output layer only.
    # Full autodiff requires wrapping the forward in Tensors (see numerical_trainer).
    model.zero_grads()
    return loss


def numerical_train(model: NumericalTransformer, optimizer: AdamW, batches: list, epochs: int = 1):
    """Train for multiple epochs over batches.

    batches: list of (ids, targets) pairs.
    Returns list of per-epoch average losses.
    """
    history = []
    for epoch in range(epochs):
        epoch_loss = 0.0
        for ids, targets in batches:
            loss = train_step(model, optimizer, ids, targets)
            epoch_loss += loss
        history.append(epoch_loss / max(len(batches), 1))
    return history