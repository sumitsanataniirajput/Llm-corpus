# Aria GPT — trained from scratch, on CPU

A ~2.5M-parameter GPT trained **entirely from scratch** on Aria's corpus: BPE
tokenizer, transformer, and training loop all implemented here in plain
PyTorch. No pretrained weights, no HuggingFace, no GPU.

That isn't a stylistic choice — it's what the environment allowed:

| Requirement | Status here |
|---|---|
| `huggingface.co` (any pretrained weights) | **blocked** (HTTP 000) |
| GPU | none |
| PyPI (`torch`) | works |
| CPU | 2 cores, 3 GB RAM |

With no access to pretrained weights and no GPU, training something from
scratch on CPU was the only way to produce an actually-trained model. So I did.

---

## What this model is — and is not

**Is:** a model that learned Aria's *output contract* — JSON structure, the
twelve emotions, intensity/effect ranges, the eight tool schemas, and the
mapping from intent to tool call. That's the part small models get wrong.

**Is not:** a knowledgeable assistant. It has read only Aria's training
examples, nothing else. It won't out-reason Gemini and was never going to.

The honest framing: a **format specialist**, not a general brain. For a voice
assistant, malformed JSON and missed tool calls are the failures that hurt
most, and those are what this model eliminates.

---

## Measured results

Trained 26.7 min on 2 CPU cores (2,500 steps, ~380K tokens).

| Step | Train | Val | Perplexity |
|---|---|---|---|
| 0 (init) | 6.97 | 6.97 | ~1060 (random) |
| 500 | 0.356 | 0.404 | 1.50 |
| 1000 | 0.260 | 0.307 | 1.36 |
| 1500 | 0.224 | 0.285 | 1.33 |
| 2000 | 0.203 | 0.246 | 1.28 |
| **2500** | **0.194** | **0.247** | **1.28** |

### Held-out validation (100 unseen rows)

| Metric | Score |
|---|---|
| JSON parseable | **100.00%** |
| Schema valid (app can parse) | **100.00%** |
| Emotion match | 77.00% |
| Tool exact match | 90.32% |
| **Weighted score** | **92.01** |

### Generalization to prompts never in training

13 hand-written prompts absent from the corpus (`open gmail`,
`launch the camera app`, `set an alarm for 6:45`, `take me to the airport`,
`scroll up`, `my cat ran away`, …):

**13/13 produced valid JSON with the correct tool route.** Emotion selection
was right for emotional inputs (`angry` for a stolen bike, `sad` for a lost
cat, `curious` for a factual question).

### Where it fails — slots

Correct action: **5/6**. Exact slot value (time/number/name): **3/6**.

```
"set an alarm for 6:45"  -> action alarm, but target "6:00"    (wrong time)
"set a timer for 45 min" -> action timer, but target "25"      (stale value)
"play some jazz"         -> says music time, but emits no tool
```

**Root cause, and it was my bug:** the first dataset had only **9 distinct
alarm times, 7 durations, 12 names** across 5,700 rows. With so little
variety the model learned to *recall* a plausible constant rather than *copy*
the value from the prompt.

Fixed by making the slots generative — any hour/minute, any duration 1–120,
40 names, 20 places — giving **141 alarm times, 119 durations, 40 names**.
Retrained; see `RESULTS.md` for the before/after comparison.

**This is the honest limit of a 2.5M-parameter model.** It learned structure
and routing; reliable verbatim copying of arbitrary values keeps improving
with more diversity and more capacity, but it will always trail a 100B model.

---

## Pipeline

| Stage | File | Notes |
|---|---|---|
| Corpus | `format.py` | Compact training format; same contract, ~5× shorter |
| Tokenizer | `tokenizer.py` | Byte-level BPE, 1024 vocab, trained here |
| Model | `model.py` | 5-layer pre-LN GPT, weight-tied embeddings |
| Prepare | `prepare_corpus.py` | corpus → tokenizer → uint16 token ids |
| Train | `train_scratch.py` | AdamW, cosine LR, grad clipping, best-val checkpoint |
| Infer | `infer_scratch.py` | Generate + validate against `aria/schema.py` |
| Eval | `evaluate_scratch.py` | Same metrics as the hosted-API harness |
| Tests | `../tests/test_scratch.py` | 30 tests |

---

## Reproduce

```bash
pip install torch numpy

python training/aria/generate_dataset.py --total 8000
python training/scratch/prepare_corpus.py        # ~90 s (tokenizer training)
python training/scratch/train_scratch.py --steps 2500   # ~27 min on 2 cores

python training/scratch/infer_scratch.py "open youtube"
python training/scratch/evaluate_scratch.py --limit 100
```

---

## Design decisions

**Compact format.** The app's real system prompt is ~1,000 chars on every
call. A 2.5M CPU-trained model can't afford that context, so training uses a
canonical compact form (`U: …` / `A: {…}`) encoding the same contract.
`infer_scratch.py` expands replies back to the full app object.

**Byte-level BPE from 256 base tokens.** Guarantees the tokenizer can encode
*any* input — braces, quotes, emoji — which matters when the output must be
valid JSON.

**Weight tying.** Input embeddings and output head share weights: ~200K fewer
parameters at no quality cost.

**Gradient clipping at 1.0.** Small models hit exploding gradients; clipping
made 2,500 unattended steps stable.

**Best-val checkpointing.** The saved weights are the best-val ones, not the
last — an over-trained run can't hurt you.

**A real causality test.** `test_causality_not_violated_by_shape` mutates the
final token and asserts earlier logits are unchanged. A mask bug would leak
answers into training and inflate every number on this page; this catches it.

---

## Using it in the app

The checkpoint is a 30 MB `.pt` for PyTorch on a server — **not** something you
drop into an APK as-is.

1. **Host it** behind a small FastAPI service (load `aria_gpt.pt`, accept
   `{message, screen}`, return the JSON object).
2. In Aria → Models, add an `OpenAI-Compatible` provider pointing at it. The
   response shape already matches, because the model emits the exact contract.
3. Or export to GGUF/ONNX and embed on-device via MediaPipe — more work,
   slower replies.

If you want a better assistant *now*, a hosted API will beat this model on
general quality. This one wins on format reliability, which is a real
engineering win — just not the same as "smarter".

---

## Artifacts

`checkpoints/` is gitignored — these are build outputs (~30 MB each).
Retrain deterministically with `--seed 7`.

Committed: `tokenizer.json` (9 KB, needed for reproducibility) and the code.

---

## Try it in a browser (`serve.py`)

```bash
python training/scratch/serve.py --port 8000
```

Serves a phone-friendly chat UI plus a JSON API:

| Route | Purpose |
|---|---|
| `GET /` | mobile web UI (chips for common requests, shows emotion, tool calls, raw model text) |
| `GET /api/health` | params, val loss, checkpoint name |
| `POST /api/chat` | `{"message": "...", "screen": "..."}` → reply + parsed object + schema validation |

Stdlib only (`http.server`) — no FastAPI/uvicorn, so it starts even when
package installs are unavailable. Binds `0.0.0.0`, sends permissive CORS and
no `X-Frame-Options`, so it renders inside a preview iframe. The page uses
relative URLs exclusively; the browser never calls `localhost`.

**This is not the Android app.** See the limitation below.

---

## Why the Android app can't be built here

| Requirement | Status in this environment |
|---|---|
| Java / Gradle / Android SDK / adb | **not installed** |
| `dl.google.com`, `maven.google.com`, `repo1.maven.org`, `services.gradle.org` | **all blocked (HTTP 000)** |

Gradle cannot resolve AGP, Kotlin or Compose dependencies, so no APK can be
produced here, and `adb install` to a physical phone is impossible. To build
the actual app you need Android Studio (or a machine with the SDK and Maven
access) — `training/README.md` steps 1–6 in the app README cover that.

What `serve.py` gives you instead is the **trained model** running live in a
phone browser, which is the honest substitute for "try it on my phone".
