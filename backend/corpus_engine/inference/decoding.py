"""CORPUS ULTIMATE — Autoregressive decoding strategies.

Temperature sampling, top-k, top-p (nucleus), greedy decoding.
"""
import math
import random
from typing import List, Tuple


def softmax(logits: List[float], temperature: float = 1.0) -> List[float]:
    if temperature <= 0:
        temperature = 1.0
    scaled = [v / temperature for v in logits]
    m = max(scaled)
    exps = [math.exp(v - m) for v in scaled]
    s = sum(exps)
    return [v / s for v in exps]


def top_k_filter(logits: List[float], k: int) -> List[float]:
    if k <= 0 or k >= len(logits):
        return list(logits)
    indexed = sorted(enumerate(logits), key=lambda x: x[1], reverse=True)
    topk_indices = {idx for idx, _ in indexed[:k]}
    return [logits[i] if i in topk_indices else float("-inf") for i in range(len(logits))]


def top_p_filter(logits: List[float], p: float) -> List[float]:
    if p <= 0 or p >= 1.0:
        return list(logits)
    indexed = sorted(enumerate(logits), key=lambda x: x[1], reverse=True)
    probs = softmax(logits)
    cumulative = 0.0
    keep = set()
    for idx, _ in indexed:
        cumulative += probs[idx]
        keep.add(idx)
        if cumulative >= p:
            break
    return [logits[i] if i in keep else float("-inf") for i in range(len(logits))]


def sample_token(logits: List[float], temperature: float = 1.0, top_k: int = 0, top_p: float = 0.0) -> int:
    """Sample a token ID from logits using temperature + top-k + top-p."""
    filtered = list(logits)
    if top_k > 0:
        filtered = top_k_filter(filtered, top_k)
    if top_p > 0:
        filtered = top_p_filter(filtered, top_p)
    probs = softmax(filtered, temperature)
    # Handle all -inf
    if all(v == 0.0 for v in probs):
        return random.randint(0, len(logits) - 1)
    r = random.random()
    cumulative = 0.0
    for i, prob in enumerate(probs):
        cumulative += prob
        if r <= cumulative:
            return i
    return len(probs) - 1


def greedy(logits: List[float]) -> int:
    return max(range(len(logits)), key=lambda i: logits[i])


def top_k_predictions(logits: List[float], k: int = 5) -> List[Tuple[int, float]]:
    """Return top-k (token_id, probability) pairs."""
    probs = softmax(logits)
    indexed = sorted(enumerate(probs), key=lambda x: x[1], reverse=True)
    return indexed[:k]