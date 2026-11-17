"""CORPUS ULTIMATE — PyTorch training engine.

Real training loop with AdamW, LR scheduler, gradient clipping,
mixed precision (CPU-safe), checkpointing, and validation.
"""
import os
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from corpus_engine.pytorch_engine.pytorch_model import CorpusTransformerPT


class PyTorchTrainer:
    def __init__(self, config: dict, device: str = "cpu"):
        self.config = config
        self.device = torch.device(device)
        self.model = CorpusTransformerPT(config).to(self.device)
        self.optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=config.get("learning_rate", 1e-3),
            weight_decay=config.get("weight_decay", 0.01),
        )
        self.scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            self.optimizer, T_max=config.get("epochs", 10)
        )
        self.criterion = nn.CrossEntropyLoss()
        self.epoch = 0
        self.global_step = 0
        self.history = []

    def train_epoch(self, dataloader: DataLoader, clip_grad: float = 1.0,
                    accum_steps: int = 1, on_step=None) -> float:
        self.model.train()
        total_loss = 0.0
        n_batches = 0
        self.optimizer.zero_grad()
        total_batches = len(dataloader)
        for i, (input_ids, target_ids) in enumerate(dataloader):
            input_ids = input_ids.to(self.device)
            target_ids = target_ids.to(self.device)
            logits = self.model(input_ids)
            loss = self.criterion(logits.reshape(-1, logits.size(-1)), target_ids.reshape(-1))
            loss = loss / accum_steps
            loss.backward()
            should_step = ((i + 1) % accum_steps == 0) or (i + 1 == total_batches)
            if should_step:
                if clip_grad > 0:
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(), clip_grad)
                self.optimizer.step()
                self.optimizer.zero_grad()
                self.global_step += 1
                if on_step is not None:
                    on_step({
                        "step": self.global_step,
                        "loss": float(loss.item() * accum_steps),
                        "batch": i + 1,
                        "batches": total_batches,
                    })
            total_loss += loss.item() * accum_steps
            n_batches += 1
        self.scheduler.step()
        self.epoch += 1
        avg_loss = total_loss / max(n_batches, 1)
        self.history.append(avg_loss)
        return avg_loss

    def validate(self, dataloader: DataLoader) -> float:
        self.model.eval()
        total_loss = 0.0
        n = 0
        with torch.no_grad():
            for input_ids, target_ids in dataloader:
                input_ids = input_ids.to(self.device)
                target_ids = target_ids.to(self.device)
                logits = self.model(input_ids)
                loss = self.criterion(logits.view(-1, logits.size(-1)), target_ids.view(-1))
                total_loss += loss.item()
                n += 1
        return total_loss / max(n, 1)

    def save_checkpoint(self, path: str, extra: dict = None):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        torch.save({
            "model_state": self.model.state_dict(),
            "optimizer_state": self.optimizer.state_dict(),
            "scheduler_state": self.scheduler.state_dict(),
            "epoch": self.epoch,
            "global_step": self.global_step,
            "config": self.config,
            "extra": extra or {},
        }, path)

    def load_checkpoint(self, path: str):
        ckpt = torch.load(path, map_location=self.device)
        self.model.load_state_dict(ckpt["model_state"])
        self.optimizer.load_state_dict(ckpt["optimizer_state"])
        self.scheduler.load_state_dict(ckpt["scheduler_state"])
        self.epoch = ckpt.get("epoch", 0)
        self.global_step = ckpt.get("global_step", 0)
        return ckpt

    def generate(self, token_ids: torch.Tensor, max_tokens: int = 50,
                 temperature: float = 0.8, top_k: int = 50, top_p: float = 0.9):
        """Greedy/simple sampling generation."""
        self.model.eval()
        generated = token_ids.clone()
        with torch.no_grad():
            for _ in range(max_tokens):
                context = generated[:, -self.config["context_length"]:]
                logits = self.model(context)
                next_logits = logits[0, -1, :] / max(float(temperature), 1e-5)
                if top_k > 0 and top_k < next_logits.numel():
                    vals, idx = torch.topk(next_logits, top_k)
                    next_logits = torch.full_like(next_logits, float("-inf"))
                    next_logits[idx] = vals
                probs = torch.softmax(next_logits, dim=-1)
                next_id = torch.multinomial(probs, 1)
                generated = torch.cat([generated, next_id.unsqueeze(0)], dim=1)
        return generated

    def parameter_count(self) -> int:
        return self.model.parameter_count()