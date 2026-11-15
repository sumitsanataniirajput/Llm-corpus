"""CORPUS ULTIMATE — Text generation from a trained CorpusTransformer."""

from corpus_engine.inference.decoding import sample_token, greedy, top_k_predictions


class Generator:
    def __init__(self, model, tokenizer):
        self.model = model
        self.tokenizer = tokenizer

    def generate(self, prompt: str, max_tokens: int = 50,
                 temperature: float = 0.8, top_k: int = 50, top_p: float = 0.9,
                 greedy_decode: bool = False) -> str:
        ids = self.tokenizer.encode(prompt)
        generated = list(ids)
        for _ in range(max_tokens):
            # Use last context_length tokens
            context = generated[-self.model.context_length:]
            # Pad to context_length if needed
            if len(context) < self.model.context_length:
                context = [self.tokenizer.special_tokens["<pad>"]] * (self.model.context_length - len(context)) + context
            logits = self.model.forward([context])[0][-1]
            if greedy_decode:
                next_id = greedy(logits)
            else:
                next_id = sample_token(logits, temperature, top_k, top_p)
            generated.append(next_id)
            if next_id == self.tokenizer.special_tokens.get("<eos>", 3):
                break
        return self.tokenizer.decode(generated, skip_special=True)

    def predict_next(self, prompt: str, top_k: int = 10,
                     temperature: float = 1.0, top_p: float = 0.9) -> dict:
        ids = self.tokenizer.encode(prompt)
        context = ids[-self.model.context_length:]
        if len(context) < self.model.context_length:
            context = [self.tokenizer.special_tokens["<pad>"]] * (self.model.context_length - len(context)) + context
        logits = self.model.forward([context])[0][-1]
        probs = [math.exp(v - max(logits)) for v in logits]
        s = sum(probs)
        probs = [v / s for v in probs]
        top = top_k_predictions(logits, top_k)
        return {
            "prompt": prompt,
            "token_ids": [t for t, _ in top],
            "tokens": [self.tokenizer.id_to_token.get(t, "?") for t, _ in top],
            "probabilities": [p for _, p in top],
            "logits": [logits[t] for t, _ in top],
            "ranks": list(range(1, len(top) + 1)),
        }


import math