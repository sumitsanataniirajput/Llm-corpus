#!/usr/bin/env python3
"""
Serve the from-scratch Aria GPT over HTTP so it can be used from a phone.

This is NOT the Android app -- that cannot be built in this environment
(no Java/Android SDK, and Google's Maven repos are blocked). This is the
trained model behind a small web UI, which is the practical way to try it
from a phone browser.

Design:
  * stdlib only (http.server) -- no FastAPI/uvicorn needed, so it starts even
    if package installs fail
  * binds 0.0.0.0 so the sandbox preview proxy can reach it
  * no X-Frame-Options / restrictive CSP, so it renders inside an iframe
  * the page uses *relative* URLs only -- the browser never calls localhost
  * the model is loaded once at startup and reused across requests

Run:
    python serve.py --port 8000
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Imported lazily inside load_model() so `--help` stays fast.
_model = None
_tokenizer = None
_meta: dict = {}
_lock = threading.Lock()   # the CPU is tiny; serialise generation


def load_model(checkpoint: Path | None = None):
    global _model, _tokenizer, _meta
    import torch

    from model import TinyGPT
    from tokenizer import BPETokenizer

    ckpt_path = checkpoint or (HERE / "checkpoints" / "aria_gpt.pt")
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    m = TinyGPT(**ck["config"])
    m.load_state_dict(ck["model"])
    m.eval()
    _model = m
    _tokenizer = BPETokenizer.load(HERE / "tokenizer.json")
    _meta = {
        "params": m.num_params(),
        "val_loss": ck.get("val_loss"),
        "config": ck["config"],
        "checkpoint": ckpt_path.name,
    }
    return _meta


def generate(user_text: str, screen: str | None, max_tokens: int = 200,
             temperature: float = 0.0) -> dict:
    """Run the hybrid path: model writes the reply, rules fix slots."""
    import torch

    from format import ASSIST_TAG, SCREEN_TAG, USER_TAG, parse_reply
    from slots import reconcile

    prompt = ""
    if screen:
        prompt += SCREEN_TAG + screen.replace("\n", " ") + "\n"
    prompt += USER_TAG + user_text.replace("\n", " ") + "\n" + ASSIST_TAG

    with _lock:
        ids = torch.tensor([_tokenizer.encode(prompt)], dtype=torch.long)
        out = _model.generate(ids, max_new_tokens=max_tokens,
                              temperature=temperature)
        raw = _tokenizer.decode(out[0][ids.shape[1]:].tolist())
    raw = raw.split("<|end|>")[0]

    parsed, _ = parse_reply(raw)
    final = reconcile(parsed, user_text) if parsed else None

    # Validate against the app's real schema when available.
    errors: list[str] = []
    try:
        import sys

        sys.path.insert(0, str(HERE.parent))
        from aria.schema import validate_response

        if final is not None:
            errors = validate_response(final)
    except Exception:
        pass

    return {
        "raw": raw,
        "parsed": parsed,
        "final": final,
        "schema_errors": errors,
        "schema_valid": final is not None and not errors,
    }


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Aria GPT — from-scratch model demo</title>
<style>
  :root {
    --bg:#0d0d14; --panel:#16161f; --pink:#ff4d8d; --cyan:#4dd0e1;
    --violet:#b26bff; --text:#f2eef5; --muted:#9d95a8; --ok:#4dd68a; --bad:#ff5c5c;
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex; flex-direction:column; height:100dvh;
  }
  header {
    padding:12px 16px; background:linear-gradient(135deg,#1c1830,#241a2e);
    border-bottom:1px solid #2a2438; flex-shrink:0;
  }
  h1 { margin:0; font-size:16px; font-weight:600; }
  h1 span { color:var(--pink); }
  .sub { font-size:11px; color:var(--muted); margin-top:3px; }
  #chat { flex:1; overflow-y:auto; padding:16px; display:flex;
          flex-direction:column; gap:12px; }
  .msg { max-width:88%; padding:10px 14px; border-radius:16px;
         font-size:15px; line-height:1.45; word-wrap:break-word; }
  .user { align-self:flex-end; background:var(--pink); color:#1a0510;
          border-bottom-right-radius:4px; font-weight:500; }
  .bot  { align-self:flex-start; background:var(--panel);
          border:1px solid #2a2438; border-bottom-left-radius:4px; }
  .meta { font-size:10.5px; color:var(--muted); margin-top:8px;
          padding-top:7px; border-top:1px solid #262031;
          font-family:ui-monospace,Menlo,monospace; white-space:pre-wrap; }
  .pill { display:inline-block; padding:1px 7px; border-radius:9px;
          font-size:10px; font-weight:600; margin-right:5px; }
  .ok { background:rgba(77,214,138,.15); color:var(--ok); }
  .bad { background:rgba(255,92,92,.15); color:var(--bad); }
  .emo { background:rgba(178,107,255,.18); color:var(--violet); }
  .tool { background:rgba(77,208,225,.15); color:var(--cyan); }
  form { display:flex; gap:8px; padding:12px; background:var(--panel);
         border-top:1px solid #2a2438; flex-shrink:0; }
  input {
    flex:1; background:#0d0d14; border:1px solid #332b40; color:var(--text);
    padding:13px 15px; border-radius:12px; font-size:16px; outline:none;
  }
  input:focus { border-color:var(--pink); }
  button {
    background:var(--pink); border:none; color:#1a0510; font-weight:700;
    padding:0 20px; border-radius:12px; font-size:15px; cursor:pointer;
  }
  button:disabled { opacity:.45; }
  .chips { display:flex; gap:6px; overflow-x:auto; padding:0 12px 10px;
           background:var(--panel); flex-shrink:0; }
  .chip { background:#221b2c; border:1px solid #332b40; color:#cfc6d8;
          padding:6px 11px; border-radius:14px; font-size:12px;
          white-space:nowrap; cursor:pointer; }
  .thinking { color:var(--muted); font-style:italic; }
</style>
</head>
<body>
<header>
  <h1>Aria <span>GPT</span> — trained from scratch</h1>
  <div class="sub" id="meta">loading model…</div>
</header>
<div id="chat"></div>
<div class="chips">
  <div class="chip">open gmail</div>
  <div class="chip">set an alarm for 4:35</div>
  <div class="chip">set a timer for 82 minutes</div>
  <div class="chip">call Farida</div>
  <div class="chip">navigate to the aquarium</div>
  <div class="chip">scroll up</div>
  <div class="chip">my dog passed away</div>
  <div class="chip">tell me a joke</div>
  <div class="chip">what's the capital of france</div>
</div>
<form id="f">
  <input id="q" placeholder="Ask Aria something…" autocomplete="off" enterkeyhint="send">
  <button id="b" type="submit">Send</button>
</form>

<script>
const chat = document.getElementById('chat');
const form = document.getElementById('f');
const input = document.getElementById('q');
const btn = document.getElementById('b');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addUser(text) {
  chat.appendChild(el('div', 'msg user', text));
  chat.scrollTop = chat.scrollHeight;
}

function addBot(payload, elapsed) {
  const box = el('div', 'msg bot');
  const say = (payload.final && payload.final.sentences || [])
    .map(s => s.text).filter(Boolean).join(' ');
  box.appendChild(document.createTextNode(say || '(no spoken reply)'));

  const meta = el('div', 'meta');
  const sents = payload.final && payload.final.sentences || [];
  if (sents.length) {
    const e = sents[0];
    const p = el('span', 'pill emo', (e.emotion || '?') + ' ' + (e.intensity || ''));
    meta.appendChild(p);
  }
  if (payload.schema_valid) meta.appendChild(el('span','pill ok','schema ok'));
  else meta.appendChild(el('span','pill bad','schema: ' + JSON.stringify(payload.schema_errors)));

  if (payload.final && payload.final.tool_calls) {
    payload.final.tool_calls.forEach(c => {
      meta.appendChild(el('div', 'meta',
        '→ ' + c.name + '(' + JSON.stringify(c.arguments) + ')'));
    });
  }
  meta.appendChild(el('div','meta','model said: ' + (payload.raw || '').slice(0,160)));
  meta.appendChild(el('div','meta', elapsed + ' ms'));
  box.appendChild(meta);

  chat.appendChild(box);
  chat.scrollTop = chat.scrollHeight;
}

async function send(text) {
  if (!text.trim()) return;
  addUser(text);
  input.value = '';
  btn.disabled = true;
  const thinking = el('div', 'msg bot thinking', 'thinking…');
  chat.appendChild(thinking);
  chat.scrollTop = chat.scrollHeight;
  const t0 = performance.now();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: text})
    });
    const data = await r.json();
    thinking.remove();
    if (data.error) {
      const e = el('div','msg bot'); e.textContent = 'Error: ' + data.error;
      chat.appendChild(e);
    } else {
      addBot(data, Math.round(performance.now() - t0));
    }
  } catch (err) {
    thinking.remove();
    const e = el('div','msg bot'); e.textContent = 'Network error: ' + err;
    chat.appendChild(e);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', ev => { ev.preventDefault(); send(input.value); });
document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => send(c.textContent));
});

fetch('/api/health').then(r => r.json()).then(d => {
  document.getElementById('meta').textContent =
    (d.params/1e6).toFixed(2) + 'M params · val loss ' +
    Number(d.val_loss).toFixed(3) + ' · ' + d.checkpoint + ' · trained on CPU';
}).catch(() => {
  document.getElementById('meta').textContent = 'model status unavailable';
});
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        print(f"  {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Allow embedding in the preview iframe and cross-origin fetches.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return

        if path == "/api/health":
            body = json.dumps({
                "status": "ok",
                "params": _meta.get("params"),
                "val_loss": _meta.get("val_loss"),
                "checkpoint": _meta.get("checkpoint"),
                "device": "cpu",
            }).encode()
            self._send(200, body, "application/json")
            return

        self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/api/chat":
            self._send(404, b'{"error":"not found"}', "application/json")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            message = (payload.get("message") or "").strip()
            screen = payload.get("screen") or None

            if not message:
                self._send(400, b'{"error":"message is required"}', "application/json")
                return
            if len(message) > 500:
                self._send(400, b'{"error":"message too long (max 500 chars)"}',
                           "application/json")
                return

            t0 = time.time()
            result = generate(message, screen)
            result["elapsed_ms"] = int((time.time() - t0) * 1000)

            self._send(200, json.dumps(result).encode(), "application/json")

        except Exception:
            traceback.print_exc()
            self._send(500, json.dumps(
                {"error": "generation failed"}).encode(), "application/json")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--checkpoint", type=Path, default=None)
    args = ap.parse_args()

    print("loading model…", flush=True)
    meta = load_model(args.checkpoint)
    print(f"  {meta['params']:,} params | val loss {meta['val_loss']:.3f} "
          f"| {meta['checkpoint']}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"\nserving on http://{args.host}:{args.port}", flush=True)
    print("open the preview link from your phone\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        server.shutdown()


if __name__ == "__main__":
    main()
