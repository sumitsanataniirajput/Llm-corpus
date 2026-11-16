#!/usr/bin/env python3
"""
Train a GPT from scratch on Aria's corpus -- runs on CPU, no pretrained weights.

No HuggingFace, no downloads, no GPU. Everything is implemented in this
directory: the BPE tokenizer, the transformer, and this training loop.

    python train_scratch.py --steps 2500

Writes ``checkpoints/aria_gpt.pt`` plus a training curve for inspection.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch

from model import TinyGPT
from tokenizer import BPETokenizer

HERE = Path(__file__).resolve().parent


def get_batch(data: np.ndarray, block_size: int, batch_size: int, device: str):
    """Sample random contiguous windows, with targets shifted by one token."""
    ix = np.random.randint(0, len(data) - block_size - 1, size=batch_size)
    x = np.stack([data[i : i + block_size] for i in ix]).astype(np.int64)
    y = np.stack([data[i + 1 : i + 1 + block_size] for i in ix]).astype(np.int64)
    return torch.from_numpy(x).to(device), torch.from_numpy(y).to(device)


def evaluate(model, data: np.ndarray, block_size: int, batch_size: int, device: str,
             iters: int = 20) -> float:
    model.eval()
    losses = []
    with torch.no_grad():
        for _ in range(iters):
            x, y = get_batch(data, block_size, batch_size, device)
            _, loss = model(x, y)
            losses.append(loss.item())
    model.train()
    return float(np.mean(losses))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tokens", type=Path, default=HERE / "tokens.npy")
    ap.add_argument("--out", type=Path, default=HERE / "checkpoints" / "aria_gpt.pt")
    ap.add_argument("--steps", type=int, default=2500)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--block-size", type=int, default=320)
    ap.add_argument("--n-layer", type=int, default=6)
    ap.add_argument("--n-head", type=int, default=6)
    ap.add_argument("--n-embd", type=int, default=192)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--warmup", type=int, default=150)
    ap.add_argument("--min-lr-ratio", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--eval-batches", type=int, default=20)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = "cpu"

    if not args.tokens.exists():
        raise SystemExit(f"{args.tokens} missing -- run prepare_corpus.py first")

    data = np.load(args.tokens)
    # Hold out the final 5% as a validation split (contiguous, like nanoGPT).
    n_val = max(2000, len(data) // 20)
    train_data, val_data = data[:-n_val], data[-n_val:]
    print(f"tokens: {len(data):,} (train {len(train_data):,} / val {len(val_data):,})")

    tok = BPETokenizer.load(HERE / "tokenizer.json")

    model = TinyGPT(
        vocab_size=tok.vocab_size,
        block_size=args.block_size,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
        dropout=args.dropout,
    ).to(device)
    print(f"model: {model.num_params():,} params ({model.num_params()/1e6:.2f}M)")

    # AdamW: weight decay on matrices only, not on norms/biases/embeddings.
    decay, no_decay = [], []
    for n, p in model.named_parameters():
        if not p.requires_grad:
            continue
        (decay if p.dim() >= 2 else no_decay).append(p)
    optimizer = torch.optim.AdamW(
        [{"params": decay, "weight_decay": 0.1},
         {"params": no_decay, "weight_decay": 0.0}],
        lr=args.lr,
        betas=(0.9, 0.95),
    )

    start_step = 0
    history: list[dict] = []
    if args.resume and args.out.exists():
        ckpt = torch.load(args.out, map_location=device, weights_only=False)
        model.load_state_dict(ckpt["model"])
        optimizer.load_state_dict(ckpt["optimizer"])
        start_step = ckpt.get("step", 0)
        history = ckpt.get("history", [])
        print(f"resumed from step {start_step}")

    def lr_at(step: int) -> float:
        """Linear warmup, then cosine decay to min_lr."""
        if step < args.warmup:
            return args.lr * (step + 1) / args.warmup
        progress = (step - args.warmup) / max(1, args.steps - args.warmup)
        progress = min(1.0, progress)
        min_lr = args.lr * args.min_lr_ratio
        return min_lr + 0.5 * (args.lr - min_lr) * (1 + math.cos(math.pi * progress))

    model.train()
    t_start = time.time()
    best_val = float("inf")

    for step in range(start_step, args.steps):
        lr = lr_at(step)
        for g in optimizer.param_groups:
            g["lr"] = lr

        x, y = get_batch(train_data, args.block_size, args.batch_size, device)
        _, loss = model(x, y)

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        # Gradient clipping -- small models are prone to rare exploding steps.
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

        if step % 50 == 0:
            elapsed = time.time() - t_start
            done = step - start_step + 1
            per_step = elapsed / max(1, done)
            eta = per_step * (args.steps - step - 1)
            print(f"step {step:5d}/{args.steps} | loss {loss.item():.3f} "
                  f"| lr {lr:.2e} | {per_step*1000:.0f} ms/step | eta {eta/60:.1f} min")

        if (step + 1) % args.eval_every == 0 or step == args.steps - 1:
            val_loss = evaluate(model, val_data, args.block_size,
                                args.batch_size, device, args.eval_batches)
            train_loss = evaluate(model, train_data, args.block_size,
                                  args.batch_size, device, args.eval_batches)
            ppl = math.exp(min(20, val_loss))
            print(f"  >> eval @ {step+1}: train {train_loss:.3f} | "
                  f"val {val_loss:.3f} | perplexity {ppl:.1f}")
            history.append({"step": step + 1, "train": train_loss,
                            "val": val_loss, "perplexity": ppl, "lr": lr})

            if val_loss < best_val:
                best_val = val_loss
                args.out.parent.mkdir(parents=True, exist_ok=True)
                torch.save({
                    "model": model.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "step": step + 1,
                    "val_loss": val_loss,
                    "best_val": best_val,
                    "config": {
                        "vocab_size": tok.vocab_size,
                        "block_size": args.block_size,
                        "n_layer": args.n_layer,
                        "n_head": args.n_head,
                        "n_embd": args.n_embd,
                        "dropout": args.dropout,
                    },
                    "history": history,
                }, args.out)

    total = time.time() - t_start
    print(f"\ndone in {total/60:.1f} min | best val loss {best_val:.3f} "
          f"| perplexity {math.exp(min(20, best_val)):.1f}")
    print(f"checkpoint: {args.out}")

    (HERE / "training_curve.json").write_text(json.dumps(history, indent=2))


if __name__ == "__main__":
    main()
