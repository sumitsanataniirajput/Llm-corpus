"""Student Model Studio — real compatibility inspection and method gating.

Design rules that this module enforces:

* Nothing is assumed about a base model. A CORPUS model is instantiated with
  ``CorpusTransformerPT`` and asked for its own parameter count. A Hugging Face
  model is inspected through ``AutoConfig`` (and optionally loaded) — if that is
  not possible the caller gets a reason, never a guessed number.
* A custom CORPUS architecture is **not** loadable from arbitrary HF weights, and
  HF weights are not loadable into the CORPUS engine. The two families are kept
  apart, and each method reports why it is or is not available.
* LoRA/QLoRA are offered only when ``peft`` (and for QLoRA ``bitsandbytes`` plus a
  CUDA device) are actually importable in this process.
* DPO is offered only for a real preference-pair dataset and an HF causal model,
  because the CORPUS engine has no preference objective.
"""
from __future__ import annotations

import importlib
import importlib.metadata as metadata
import os
import platform
from typing import Any, Dict, List, Optional

METHODS: Dict[str, Dict[str, str]] = {
    "sft": {"label": "Supervised fine-tuning", "description": "Train all weights on your dataset."},
    "lora": {"label": "LoRA", "description": "Freeze the base model and train small low-rank adapters."},
    "qlora": {"label": "QLoRA", "description": "4-bit quantized base plus LoRA adapters (needs bitsandbytes + CUDA)."},
    "dpo": {"label": "DPO", "description": "Preference optimisation over chosen/rejected pairs."},
    "continued": {"label": "Continued pre-training", "description": "Keep training an existing checkpoint on more text."},
}


class InspectError(RuntimeError):
    """The model could not be inspected; the message says why."""


def _version(dist: str) -> Optional[str]:
    try:
        return metadata.version(dist)
    except Exception:
        return None


def _module(name: str):
    try:
        return importlib.import_module(name)
    except Exception:
        return None


def library_report() -> Dict[str, Any]:
    """What is actually installed in this process, with versions."""
    torch = _module("torch")
    cuda_available = bool(torch is not None and getattr(torch.cuda, "is_available", lambda: False)())
    gpu_names: List[str] = []
    if cuda_available:
        try:
            gpu_names = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
        except Exception:
            gpu_names = []
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "torch": _version("torch"),
        "transformers": _version("transformers"),
        "peft": _version("peft"),
        "accelerate": _version("accelerate"),
        "bitsandbytes": _version("bitsandbytes"),
        "datasets": _version("datasets"),
        "trt": None,
        "cuda_available": cuda_available,
        "cuda_devices": gpu_names,
        "device_count": len(gpu_names),
        "cpu_count": os.cpu_count(),
        "hf_offline": os.environ.get("HF_HUB_OFFLINE") == "1",
    }


def method_availability(base_source: str, method: str, libraries: Optional[Dict[str, Any]] = None,
                        *, has_preference_pairs: bool = True) -> Dict[str, Any]:
    """Return ``{available, reasons[]}`` for one method on one model family."""
    libs = libraries or library_report()
    reasons: List[str] = []
    available = True

    if base_source == "corpus":
        if method in {"sft", "continued"}:
            return {"available": True, "reasons": []}
        if method in {"lora", "qlora"}:
            available = False
            reasons.append(
                "The CORPUS PyTorch architecture is a custom transformer, not a Hugging Face module tree, "
                "so PEFT adapters are not applied to it. Use the CORPUS engine with full SFT instead."
            )
        elif method == "dpo":
            available = False
            reasons.append(
                "The CORPUS engine has no preference objective (no reference-model log-prob comparison). "
                "DPO requires a Hugging Face causal LM."
            )
        else:
            available = False
            reasons.append(f"Unknown method '{method}'.")
        return {"available": available, "reasons": reasons}

    # Hugging Face / local HF checkpoint
    if libs.get("transformers") is None:
        available = False
        reasons.append("transformers is not installed in the backend environment.")
    if method in {"sft", "continued"}:
        pass
    elif method == "lora":
        if libs.get("peft") is None:
            available = False
            reasons.append("peft is not installed, so LoRA adapters cannot be trained or saved.")
    elif method == "qlora":
        if libs.get("peft") is None:
            available = False
            reasons.append("peft is not installed, so QLoRA adapters cannot be trained.")
        if libs.get("bitsandbytes") is None:
            available = False
            reasons.append("bitsandbytes is not installed, so 4-bit quantisation is unavailable.")
        if not libs.get("cuda_available"):
            available = False
            reasons.append("No CUDA device is visible to this process; 4-bit quantisation would not fit or run.")
    elif method == "dpo":
        if libs.get("transformers") is None:
            available = False
        if not has_preference_pairs:
            available = False
            reasons.append(
                "DPO needs a preference dataset (prompt/chosen/rejected). "
                "No approved preference pairs exist for this selection yet."
            )
    else:
        available = False
        reasons.append(f"Unknown method '{method}'.")
    return {"available": available, "reasons": reasons}


def _corpus_config(model_config: Dict[str, Any]) -> Dict[str, Any]:
    config = dict(model_config or {})
    return {
        "vocab_size": max(int(config.get("vocab_size", 512) or 512), 8),
        "context_length": max(int(config.get("context_length", 128) or 128), 8),
        "d_model": max(int(config.get("d_model", 128) or 128), 8),
        "n_layers": max(int(config.get("n_layers", 2) or 2), 1),
        "n_heads": max(int(config.get("n_heads", 4) or 4), 1),
        "d_ff": max(int(config.get("d_ff", 256) or 256), 8),
        "dropout": float(config.get("dropout", 0.1) or 0.1),
    }


def inspect_corpus_model(model_row: Any) -> Dict[str, Any]:
    """Instantiate the CORPUS transformer and report what it actually is."""
    config = _corpus_config(getattr(model_row, "config", None) or {})
    if config["d_model"] % config["n_heads"]:
        raise InspectError(
            f"Invalid architecture: d_model {config['d_model']} is not divisible by n_heads {config['n_heads']}."
        )
    try:
        from corpus_engine.pytorch_engine.pytorch_model import CorpusTransformerPT
        import torch  # noqa: F401
    except Exception as exc:  # pragma: no cover - torch is a hard dependency in prod
        raise InspectError(f"The CORPUS PyTorch engine is not importable: {exc}") from exc

    model = CorpusTransformerPT(config)
    summary = model.summary()
    total = int(summary["total_parameters"])
    parameter_breakdown = {}
    for name, param in model.named_parameters():
        parameter_breakdown[name] = int(param.numel())
    return {
        "name": getattr(model_row, "name", None),
        "model_id": getattr(model_row, "id", None),
        "base_source": "corpus",
        "base_ref": None,
        "architecture": {
            "architecture": "CorpusTransformerPT",
            "architecture_version": "corpus-pytorch-1",
            "engine": "pytorch",
            "total_parameters": total,
            "trainable_parameters": total,
            "frozen_parameters": 0,
            "trainable_percent": 100.0,
            "embedding_dim": config["d_model"],
            "hidden_dim": config["d_model"],
            "intermediate_dim": config["d_ff"],
            "layers": config["n_layers"],
            "attention_heads": config["n_heads"],
            "kv_heads": config["n_heads"],
            "vocab_size": config["vocab_size"],
            "context_window": config["context_length"],
            "dropout": config["dropout"],
            "tokenizer": "CorpusTokenizer (trained per dataset)",
            "tokenizer_version": getattr(model_row, "tokenizer_ref", None),
            "precision": "float32",
            "quantization": None,
            "weight_size_bytes": total * 4,
            "parameter_breakdown": parameter_breakdown,
            "source": "instantiated from the stored model config",
        },
        "methods": {
            method: method_availability("corpus", method)
            for method in METHODS
        },
        "compatibility": {
            "hf_weights_loadable": False,
            "reason": ("CORPUS checkpoints store a custom state dict and a corpus tokenizer. "
                       "Hugging Face weights are not compatible with this architecture."),
        },
    }


def inspect_hf_model(repo_id: str, *, load_weights: bool = False,
                     token: Optional[str] = None) -> Dict[str, Any]:
    """Inspect a Hugging Face model through ``AutoConfig`` (real metadata only)."""
    transformers = _module("transformers")
    if transformers is None:
        raise InspectError(
            "transformers is not installed in the backend environment, so a Hugging Face model cannot be inspected."
        )
    try:
        config = transformers.AutoConfig.from_pretrained(repo_id, token=token)
    except Exception as exc:  # noqa: BLE001 - network/auth/404 all land here
        raise InspectError(
            f"Hugging Face could not load a config for '{repo_id}': {str(exc)[:300]}"
        ) from exc

    get = lambda key, default=None: getattr(config, key, default)  # noqa: E731
    layers = get("num_hidden_layers") or get("n_layer") or get("num_layers")
    hidden = get("hidden_size") or get("n_embd") or get("d_model")
    heads = get("num_attention_heads") or get("n_head")
    kv_heads = get("num_key_value_heads") or heads
    intermediate = get("intermediate_size") or get("n_inner")
    vocab = get("vocab_size")
    context = (get("max_position_embeddings") or get("n_positions")
               or get("max_sequence_length") or get("seq_length"))
    dtype = str(get("torch_dtype") or "") or None

    parameter_count = None
    parameter_source = None
    weight_bytes = None
    load_error = None
    if load_weights:
        torch = _module("torch")
        try:
            model = transformers.AutoModelForCausalLM.from_pretrained(
                repo_id,
                token=token,
                low_cpu_mem_usage=True,
                torch_dtype=torch.float32 if torch is not None else None,
            )
            parameter_count = int(sum(p.numel() for p in model.parameters()))
            weight_bytes = int(sum(p.numel() * p.element_size() for p in model.parameters()))
            parameter_source = "loaded weights (AutoModelForCausalLM)"
            del model
        except Exception as exc:  # noqa: BLE001
            load_error = f"The weights could not be loaded here: {str(exc)[:300]}"

    tokenizer_name = None
    tokenizer_version = None
    try:
        tokenizer = transformers.AutoTokenizer.from_pretrained(repo_id, token=token)
        tokenizer_name = type(tokenizer).__name__
        tokenizer_version = getattr(tokenizer, "name_or_path", None)
    except Exception:
        tokenizer_name = None
        tokenizer_version = None

    architecture = {
        "architecture": get("architectures")[0] if get("architectures") else get("model_type"),
        "architecture_version": get("transformers_version"),
        "engine": "transformers",
        "total_parameters": parameter_count,
        "parameter_source": parameter_source or "not measured — enable 'load weights' to count them",
        "trainable_parameters": None,
        "frozen_parameters": None,
        "trainable_percent": None,
        "embedding_dim": hidden,
        "hidden_dim": hidden,
        "intermediate_dim": intermediate,
        "layers": layers,
        "attention_heads": heads,
        "kv_heads": kv_heads,
        "vocab_size": vocab,
        "context_window": context,
        "precision": dtype,
        "quantization": None,
        "weight_size_bytes": weight_bytes,
        "tokenizer": tokenizer_name,
        "tokenizer_version": tokenizer_version,
        "source": "Hugging Face config" + (" + loaded weights" if parameter_count else ""),
        "load_error": load_error,
    }
    return {
        "name": repo_id.split("/")[-1],
        "model_id": None,
        "base_source": "huggingface",
        "base_ref": repo_id,
        "architecture": architecture,
        "methods": {method: method_availability("huggingface", method) for method in METHODS},
        "compatibility": {
            "hf_weights_loadable": True,
            "reason": "Standard Hugging Face causal LM; transformers/PEFT paths apply.",
        },
    }


def lora_plan(architecture: Dict[str, Any], method_config: Dict[str, Any]) -> Dict[str, Any]:
    """Estimate adapter parameter count from the real architecture numbers.

    The estimate is reported together with the formula so the UI can label it as an
    estimate; the actual adapter size is measured after training and stored then.
    """
    rank = int(method_config.get("lora_r") or 8)
    targets = method_config.get("target_modules") or []
    hidden = architecture.get("hidden_dim")
    intermediate = architecture.get("intermediate_dim")
    layers = architecture.get("layers")
    kv_heads = architecture.get("kv_heads")
    heads = architecture.get("attention_heads")
    if not all(isinstance(value, int) and value > 0 for value in (layers,)):
        return {"estimated_adapter_parameters": None, "formula": None,
                "note": "Layer count is unknown, so adapter size cannot be estimated."}

    head_dim = None
    if isinstance(hidden, int) and isinstance(heads, int) and heads:
        head_dim = hidden // heads
    kv_dim = head_dim * kv_heads if (head_dim and isinstance(kv_heads, int)) else hidden

    per_module: Dict[str, int] = {}
    for name in targets:
        if name in {"q_proj", "k_proj", "v_proj", "o_proj"} and isinstance(hidden, int):
            out_dim = kv_dim if name in {"k_proj", "v_proj"} else hidden
            per_module[name] = rank * (hidden + out_dim)
        elif name in {"gate_proj", "up_proj", "down_proj"} and isinstance(hidden, int) and isinstance(intermediate, int):
            per_module[name] = rank * (hidden + intermediate)
        else:
            per_module[name] = 0
    per_layer = sum(per_module.values())
    total = per_layer * layers if per_layer else None
    return {
        "estimated_adapter_parameters": total,
        "per_module": per_module,
        "rank": rank,
        "alpha": method_config.get("lora_alpha"),
        "dropout": method_config.get("lora_dropout"),
        "formula": "rank × (in_features + out_features) per targeted module, × number of layers",
        "note": ("Estimate from the inspected architecture. The exact adapter size is measured from the "
                 "saved adapter file after training."),
    }
