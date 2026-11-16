#!/usr/bin/env python3
"""
QLoRA fine-tune of a small instruct model on Aria's dataset.

Runs on a single free Colab / Kaggle T4 (16 GB). Nothing here executes on the
repo machine -- there is no GPU -- so this is meant to be run on rented or
free-tier hardware, or via ``notebooks/aria_finetune_colab.ipynb``.

Recommended base models (Aria needs *structured JSON*, so instruct variants
matter far more than raw size):

    Qwen/Qwen2.5-1.5B-Instruct     ~3 GB VRAM   fastest, good baseline
    Qwen/Qwen2.5-3B-Instruct       ~6 GB VRAM   best quality/VRAM balance
    meta-llama/Llama-3.2-1B-Instruct ~3 GB VRAM  needs a HF token + license
    google/gemma-2-2b-it           ~5 GB VRAM   strong at short replies

Usage
-----
    python training/aria/train_qlora.py \\
        --base Qwen/Qwen2.5-3B-Instruct \\
        --out ./aria-qwen-lora \\
        --epochs 2

Then evaluate:
    python training/aria/evaluate.py --backend hf \\
        --model Qwen/Qwen2.5-3B-Instruct --adapter ./aria-qwen-lora
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DATA = Path(__file__).parent / "data"


def require(mod: str, hint: str):
    try:
        return __import__(mod)
    except ImportError:
        sys.exit(f"missing dependency '{mod}'. install with:\n    {hint}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="Qwen/Qwen2.5-1.5B-Instruct")
    ap.add_argument("--out", type=Path, default=Path("./aria-lora"))
    ap.add_argument("--train", type=Path, default=DATA / "train.jsonl")
    ap.add_argument("--val", type=Path, default=DATA / "val.jsonl")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--max-seq-len", type=int, default=1024)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-4bit", action="store_true", help="disable 4-bit (needs more VRAM)")
    args = ap.parse_args()

    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            BitsAndBytesConfig,
        )
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        sys.exit(
            f"missing dependency: {exc.name}\n"
            "install the training stack with:\n"
            "    pip install 'torch' transformers trl peft accelerate bitsandbytes datasets\n"
            "or just run notebooks/aria_finetune_colab.ipynb, which installs them."
        )

    if not torch.cuda.is_available():
        sys.exit(
            "No CUDA GPU detected.\n"
            "This script needs a GPU (free Colab/Kaggle T4 is enough).\n"
            "To check the pipeline without training, run:\n"
            "    python training/aria/evaluate.py --backend oracle"
        )

    for p in (args.train, args.val):
        if not p.exists():
            sys.exit(f"{p} not found -- run training/aria/generate_dataset.py first")

    print(f"base model : {args.base}")
    print(f"gpu        : {torch.cuda.get_device_name(0)} "
          f"({torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB)")

    # --- tokenizer -------------------------------------------------------
    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # --- model -----------------------------------------------------------
    quant_cfg = None
    if not args.no_4bit:
        quant_cfg = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16
            if torch.cuda.is_bf16_supported()
            else torch.float16,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quant_cfg,
        torch_dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False

    if quant_cfg is not None:
        model = prepare_model_for_kbit_training(model)

    # Attention/MLP projections only. Targeting lm_head or embeddings on a
    # tiny dataset tends to overfit and inflates adapter size for no gain.
    lora_cfg = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # --- data ------------------------------------------------------------
    ds = load_dataset(
        "json",
        data_files={"train": str(args.train), "validation": str(args.val)},
    )

    def to_text(example):
        """Render messages with the model's own chat template.

        Training on the exact template the app's provider would send keeps
        train and inference consistent -- a common source of silent quality
        loss in chat fine-tunes.
        """
        return {
            "text": tok.apply_chat_template(
                example["messages"], tokenize=False, add_generation_prompt=False
            )
        }

    ds = ds.map(to_text, remove_columns=ds["train"].column_names)

    # --- train -----------------------------------------------------------
    out = args.out.resolve()
    sft = SFTConfig(
        output_dir=str(out),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        max_length=args.max_seq_len,
        packing=False,  # keep each conversation intact
        seed=args.seed,
        report_to="none",
        dataset_text_field="text",
    )

    trainer = SFTTrainer(
        model=model,
        args=sft,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        processing_class=tok,
    )

    trainer.train()

    out.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(out))
    tok.save_pretrained(str(out))

    # Record what this checkpoint was trained on, so results are reproducible.
    meta = {
        "base_model": args.base,
        "train_rows": len(ds["train"]),
        "val_rows": len(ds["validation"]),
        "epochs": args.epochs,
        "lr": args.lr,
        "lora": {"r": args.lora_r, "alpha": args.lora_alpha,
                 "dropout": args.lora_dropout},
        "seed": args.seed,
        "quantized_4bit": not args.no_4bit,
    }
    (out / "aria_training_meta.json").write_text(json.dumps(meta, indent=2))

    print(f"\nadapter saved to {out}")
    print("next: python training/aria/evaluate.py --backend hf "
          f"--model {args.base} --adapter {out}")


if __name__ == "__main__":
    main()
