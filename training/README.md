# Aria fine-tuning pipeline

Makes Aria's model **more reliable at its actual job**: emitting the exact JSON
the Android app parses, and picking the right tool call every time.

> **Read this first.** Aria is a *bring-your-own-key* app. It calls Gemini,
> GPT or Claude over HTTPS — you don't own those weights, so they can't be
> fine-tuned. What this pipeline gives you is a small local model trained to
> speak Aria's contract perfectly, which you can then serve behind Aria's
> `OPENAI_COMPATIBLE` provider.

---

## Why this is the right target

Aria's parser is strict:

```json
{"sentences": [{"text": "Yay!", "emotion": "excited", "intensity": 2,
                "effect": "none", "style_prompt": "say this bouncy"}],
 "tool_calls": [{"name": "open_app", "arguments": {"name": "YouTube"}}]}
```

Twelve fixed emotions, intensity 1–3, five effect values, eight tool names
with exact argument shapes. That's precisely what small models fumble — and
precisely what fine-tuning fixes. It is a much better bet than trying to teach
a 1.5B model to be knowledgeable.

---

## Pipeline

| Stage | File | What it does |
|---|---|---|
| Contract | `aria/schema.py` | Single source of truth, mirrored from the app. Validates every sample. |
| Prompt | `aria/prompt.py` | Verbatim port of `getSystemPrompt()` — train/inference must match. |
| Data | `aria/generate_dataset.py` | Deterministic, slot-filled synthesis → 6,000 balanced samples. |
| Train | `aria/train_qlora.py` | 4-bit QLoRA, fits a free Colab T4. |
| Evaluate | `aria/evaluate.py` | Scores JSON validity, schema conformance, emotion, tool accuracy. |
| Guard | `tools_audit.py` | Detects drift between declared and handled tools. |
| Tests | `../tests/test_training.py` | 38 tests. |
| Notebook | `../notebooks/aria_finetune_colab.ipynb` | End-to-end on free Colab. |

---

## Quick start (no GPU needed)

```bash
# 1. regenerate data (deterministic)
python training/aria/generate_dataset.py --total 6000 --out training/aria/data/

# 2. verify the harness itself — must print 100.00
python training/aria/evaluate.py --backend oracle

# 3. run the test suite
python training/tests/test_training.py
```

## Actual training (free Colab T4)

Open `training/notebooks/aria_finetune_colab.ipynb` in Colab, set
**Runtime → T4 GPU**, run all. It installs deps, trains, evaluates, and prints
a baseline-vs-fine-tuned table.

Or by hand:

```bash
pip install torch transformers trl peft accelerate bitsandbytes datasets

python training/aria/train_qlora.py \
    --base Qwen/Qwen2.5-1.5B-Instruct \
    --out ./aria-lora --epochs 2

python training/aria/evaluate.py --backend hf \
    --model Qwen/Qwen2.5-1.5B-Instruct --adapter ./aria-lora
```

### Recommended bases

| Model | VRAM | Notes |
|---|---|---|
| `Qwen/Qwen2.5-1.5B-Instruct` | ~3 GB | best speed/quality for T4 |
| `Qwen/Qwen2.5-3B-Instruct` | ~6 GB | best quality that still fits |
| `meta-llama/Llama-3.2-1B-Instruct` | ~3 GB | needs HF token + license |
| `google/gemma-2-2b-it` | ~5 GB | strong at short replies |

---

## Dataset

6,000 unique samples, deterministic (same seed → same file), 100% schema-valid.

| Category | Share | Content |
|---|---|---|
| smalltalk | 12% | greetings, jokes, gratitude, comfort |
| emotion | 20% | slot-filled families across all 12 emotions |
| knowledge | 8% | short factual Q&A in Aria's voice |
| open_app | 7% | `open_app` tool |
| direct_intent | 12% | alarm, timer, flashlight, wifi, music, nav, calendar |
| sensitive | 10% | call/SMS — always confirm, never claim done |
| screen_task | 13% | multi-step automation from `[Foreground Screen UI]` |
| memory | 5% | remember / recall |
| safety | 3% | refuses romantic roleplay and meanness |
| fallback | 2% | the app's real graceful-degradation line |

**Emotion balance** (this is where most synthetic sets fail — the first
version of this one was 90% happy/excited and never emitted `angry` at all):

```
curious 16.6%  neutral 11.9%  proud 11.6%  excited 8.7%  happy 8.3%  sad 6.5%
scared 6.4%  angry 6.2%  annoyed 6.1%  surprised 6.0%  shy 5.8%  sleepy 5.8%
```

All twelve present, minimum share 5.8%.

---

## Scoring

```
score = 0.45 × schema_rate + 0.35 × tool_em + 0.20 × emotion_acc
```

`schema_rate` dominates because a malformed reply means the app speaks nothing.
The harness is self-verifying: `--backend oracle` replays ground truth and
**must** score 100.0, and the test suite asserts it also scores 0.0 on garbage.
A scorer that only ever returns 100 is worthless.

---

## Getting it into the app

The fine-tune is only useful if Aria can reach it. Two options:

**A. Host it, point Aria at it (easiest)**
Serve the adapter behind any OpenAI-compatible endpoint (vLLM, TGI, Ollama,
LM Studio), then in Aria → Models add a provider:
- Type: `OpenAI-Compatible`
- Base URL: your endpoint, e.g. `https://your-host/v1`
- Model id: whatever your server reports

Aria already speaks this protocol — no app changes.

**B. On-device (harder, private)**
Convert to GGUF and run via MediaPipe LLM Inference or llama.cpp. Then add a
new `ProviderType.LOCAL` to `UnifiedLLMClient`. Expect slower responses and
a real APK size increase.

---

## Honest expectations

- **A 1.5B model will be less knowledgeable than Gemini/GPT.** If you replace
  the API entirely, Aria gets dumber at trivia and better at format.
- **The realistic win is reliability**: never malformed JSON, never a missed
  tool call, consistent emotional tagging. That matters more for a voice
  assistant than trivia.
- **If `score` doesn't beat the baseline in step 7 of the notebook, don't ship
  it.** That comparison is the whole point.

---

## A real bug this pipeline found

`schema.py` refused to validate a `ask_user` tool call, which exposed a genuine
defect in the app:

| | Tools |
|---|---|
| Declared to the model (`buildOpenAITools`) | 8 |
| Handled by the app (`executeToolCall`) | 11 |
| **Implemented but never declared** | **`ask_user`, `wait`, `long_press`** |

`AriaAgentLoop` fully implements all three — including the spoken-confirmation
path — but `UnifiedLLMClient.buildOpenAITools()` never tells the model they
exist. **The model therefore cannot call them, so Aria never pauses to confirm
a sensitive action and never waits for UI to settle.**

Run `python training/tools_audit.py` to see this live; add `--strict` to fail
CI on any future drift.

Fix (in `UnifiedLLMClient.kt`, inside `buildOpenAITools()`):

```kotlin
tools.put(createOpenAITool("ask_user", "Ask the user a question and wait for their answer",
    mapOf("question" to "string")))
tools.put(createOpenAITool("wait", "Wait for the screen to settle before the next action",
    mapOf("seconds" to "number")))
tools.put(createOpenAITool("long_press", "Long press at screen coordinates",
    mapOf("x" to "number", "y" to "number")))
```

Then regenerate the dataset — `schema.TOOLS` is the only place to update on
the Python side, and `validate_response` will enforce the new shape.

> I have **not** modified the app. That's a behavioural change to your product
> (it starts asking for confirmation before calls/SMS), so it's your call.
