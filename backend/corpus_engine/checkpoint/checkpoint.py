"""CORPUS ULTIMATE — Checkpoint save/load.

Serializes model parameters and training state to JSON.
"""
import json
import os
from datetime import datetime, timezone


def save(model, optimizer, config: dict, path: str, extra: dict = None):
    """Save model parameters, optimizer state, and config to a JSON file."""
    data = {
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "config": config,
        "parameters": _collect_parameters(model),
        "optimizer": {
            "lr": optimizer.lr if optimizer else None,
            "weight_decay": optimizer.weight_decay if optimizer else None,
            "t": optimizer.t if optimizer else 0,
        },
    }
    if extra:
        data["extra"] = extra
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return data


def load(model, optimizer, path: str) -> dict:
    """Load parameters and optimizer state from a checkpoint file."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    _set_parameters(model, data["parameters"])
    if "optimizer" in data and optimizer:
        optimizer.lr = data["optimizer"].get("lr", optimizer.lr)
        optimizer.t = data["optimizer"].get("t", 0)
    return data


def _collect_parameters(model):
    params = []
    for p in model.parameters():
        if hasattr(p, 'data'):
            params.append(p.data)
        else:
            params.append(p)
    return params


def _set_parameters(model, saved):
    idx = 0
    for p in model.parameters():
        if hasattr(p, 'data'):
            # Tensor-based parameter (numerical engine)
            data = p.data
            if isinstance(data[0], list):
                for r in range(len(data)):
                    for c in range(len(data[0])):
                        data[r][c] = saved[idx][r][c]
            else:
                for j in range(len(data)):
                    data[j] = saved[idx][j]
            idx += 1
        elif isinstance(p, list):
            # Plain list parameter (custom transformer)
            if len(p) > 0 and isinstance(p[0], list):
                for r in range(len(p)):
                    for c in range(len(p[0])):
                        p[r][c] = saved[idx][r][c]
            else:
                for j in range(len(p)):
                    p[j] = saved[idx][j]
            idx += 1