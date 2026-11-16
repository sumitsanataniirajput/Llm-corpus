"""
A small GPT, implemented from scratch in PyTorch.

Deliberately conventional so it can be read and verified:
  - pre-LayerNorm transformer blocks (stable at small scale)
  - causal multi-head self-attention
  - GELU MLP with 4x expansion
  - tied input/output embeddings (saves params at this size)
  - learned absolute position embeddings

~1.6M parameters at the default config -- small enough to train on 2 CPU
cores, large enough that the JSON contract is fully learnable.
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class CausalSelfAttention(nn.Module):
    def __init__(self, n_embd: int, n_head: int, dropout: float):
        super().__init__()
        assert n_embd % n_head == 0, "n_embd must be divisible by n_head"
        self.n_head = n_head
        self.head_dim = n_embd // n_head

        # One fused projection for q, k, v (faster than three separate matmuls).
        self.qkv = nn.Linear(n_embd, 3 * n_embd, bias=False)
        self.proj = nn.Linear(n_embd, n_embd, bias=False)
        self.attn_drop = nn.Dropout(dropout)
        self.resid_drop = nn.Dropout(dropout)

        # Causal mask: position i may only attend to positions <= i.
        self.register_buffer(
            "mask",
            torch.tril(torch.ones(1024, 1024, dtype=torch.bool)).view(1, 1, 1024, 1024),
            persistent=False,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        qkv = self.qkv(x)                                  # (B, T, 3C)
        q, k, v = qkv.split(C, dim=2)
        # -> (B, n_head, T, head_dim)
        q = q.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_head, self.head_dim).transpose(1, 2)

        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)  # (B, h, T, T)
        att = att.masked_fill(~self.mask[:, :, :T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.attn_drop(att)

        y = att @ v                                        # (B, h, T, head_dim)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        return self.resid_drop(self.proj(y))


class Block(nn.Module):
    """Pre-norm transformer block."""

    def __init__(self, n_embd: int, n_head: int, dropout: float):
        super().__init__()
        self.ln1 = nn.LayerNorm(n_embd)
        self.attn = CausalSelfAttention(n_embd, n_head, dropout)
        self.ln2 = nn.LayerNorm(n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(n_embd, 4 * n_embd),
            nn.GELU(),
            nn.Linear(4 * n_embd, n_embd),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))   # residual around attention
        x = x + self.mlp(self.ln2(x))    # residual around MLP
        return x


class TinyGPT(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        block_size: int = 256,
        n_layer: int = 6,
        n_head: int = 6,
        n_embd: int = 192,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.block_size = block_size
        self.vocab_size = vocab_size

        self.tok_emb = nn.Embedding(vocab_size, n_embd)
        self.pos_emb = nn.Embedding(block_size, n_embd)
        self.drop = nn.Dropout(dropout)
        self.blocks = nn.ModuleList(
            [Block(n_embd, n_head, dropout) for _ in range(n_layer)]
        )
        self.ln_f = nn.LayerNorm(n_embd)
        self.head = nn.Linear(n_embd, vocab_size, bias=False)

        # Weight tying: input embedding and output projection share weights.
        # This is standard for small LMs and removes vocab*n_embd parameters.
        self.head.weight = self.tok_emb.weight

        self.apply(self._init_weights)
        # Scale residual projections by 1/sqrt(2*n_layer), per GPT-2.
        for name, p in self.named_parameters():
            if name.endswith("proj.weight") or name.endswith("mlp.2.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * n_layer))

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(
        self, idx: torch.Tensor, targets: torch.Tensor | None = None
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        B, T = idx.shape
        assert T <= self.block_size, f"sequence length {T} > block_size {self.block_size}"

        pos = torch.arange(T, device=idx.device)
        x = self.drop(self.tok_emb(idx) + self.pos_emb(pos))
        for block in self.blocks:
            x = block(x)
        x = self.ln_f(x)
        logits = self.head(x)                       # (B, T, vocab)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)),
                targets.reshape(-1),
                ignore_index=-1,
            )
        return logits, loss

    @torch.no_grad()
    def generate(
        self,
        idx: torch.Tensor,
        max_new_tokens: int = 300,
        temperature: float = 0.0,
        stop_token: int | None = None,
    ) -> torch.Tensor:
        """Autoregressive sampling. temperature=0 means greedy."""
        self.eval()
        for _ in range(max_new_tokens):
            # Crop to the context window.
            ctx = idx[:, -self.block_size :]
            logits, _ = self(ctx)
            logits = logits[:, -1, :]                       # last position
            if temperature <= 0:
                nxt = torch.argmax(logits, dim=-1, keepdim=True)
            else:
                probs = F.softmax(logits / temperature, dim=-1)
                nxt = torch.multinomial(probs, num_samples=1)
            idx = torch.cat([idx, nxt], dim=1)
            if stop_token is not None and (nxt == stop_token).all():
                break
        return idx
