#!/usr/bin/env python3
"""
Audit the Android app's tool wiring for drift.

Compares the tools the model is *told* about (``buildOpenAITools`` in
``UnifiedLLMClient.kt``) against the tools the app can actually *execute*
(``executeToolCall`` in ``AriaAgentLoop.kt``).

A mismatch in either direction is a bug:

  declared but not handled -> the model calls a tool that silently does
                              nothing ("Unknown tool"), so the task appears
                              to succeed while the phone never moves.
  handled but not declared -> dead code: the model can never legitimately
                              emit it, so the feature is unreachable.

This script is the executable record of a real defect found while building
the fine-tuning dataset: ``ask_user``, ``wait`` and ``long_press`` are fully
implemented but never declared, so confirmation prompts and waits never fire.

Usage
-----
    python training/tools_audit.py            # report
    python training/tools_audit.py --strict   # exit 1 if a mismatch exists

Parsing is deliberately simple (regex over the Kotlin source) so it needs no
Kotlin toolchain. It is a lint, not a compiler.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLIENT = REPO / "app/src/main/java/com/example/brain/UnifiedLLMClient.kt"
LOOP = REPO / "app/src/main/java/com/example/brain/AriaAgentLoop.kt"

DECL_RE = re.compile(r'createOpenAITool\(\s*"([a-z_]+)"')
HANDLE_RE = re.compile(r'^\s*"([a-z_]+)"\s*->', re.M)

# Android intent action strings handled inside executeDirectIntent().
INTENT_RE = re.compile(r'^\s*"([a-z_]+)"\s*->', re.M)


def declared_tools(text: str) -> set[str]:
    return set(DECL_RE.findall(text))


# Brace-balanced extraction, because executeToolCall contains nested `when`
# blocks (swipe directions) whose branches are not tool names. A regex over
# the whole function would wrongly report up/down/left/right as tools.
def _extract_function(text: str, signature: str) -> str:
    start = text.find(signature)
    if start == -1:
        return ""
    brace = text.find("{", start)
    if brace == -1:
        return ""
    depth = 0
    for i in range(brace, len(text)):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def handled_tools(text: str) -> set[str]:
    """Tool names in the ``when (toolCall.name)`` block.

    Parsed from the brace-balanced body of executeToolCall, then filtered to
    depth-1 branches only, so nested `when` blocks inside a branch (swipe
    directions like "up"/"down") are excluded.
    """
    body = _extract_function(text, "private suspend fun executeToolCall")
    if not body:
        return set()

    # Find the top-level `when (toolCall.name) {` and walk its branches at
    # brace depth 1 relative to the when-block.
    w = body.find("when (toolCall.name)")
    if w == -1:
        return set()
    brace = body.find("{", w)
    depth = 0
    names: set[str] = set()
    i = brace
    while i < len(body):
        ch = body[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
        elif depth == 1:
            # At branch level: a `"name" ->` label starts a tool branch.
            m = re.match(r'\s*"([a-z_]+)"\s*->', body[i:])
            if m and (i == 0 or body[i - 1] in "\n;{} "):
                names.add(m.group(1))
                i += m.end()
                continue
        i += 1
    return names


def direct_intents(text: str) -> set[str]:
    start = text.find("private fun executeDirectIntent")
    if start == -1:
        return set()
    nxt = text.find("\n    private ", start + 10)
    block = text[start : nxt if nxt != -1 else len(text)]
    return set(INTENT_RE.findall(block))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--strict", action="store_true", help="exit 1 on any mismatch")
    args = ap.parse_args()

    for p in (CLIENT, LOOP):
        if not p.exists():
            sys.exit(f"missing {p.relative_to(REPO)}")

    client_src = CLIENT.read_text(encoding="utf-8")
    loop_src = LOOP.read_text(encoding="utf-8")

    declared = declared_tools(client_src)
    handled = handled_tools(loop_src)
    intents = direct_intents(loop_src)

    print(f"declared to the model : {len(declared)}")
    print(f"handled by the app    : {len(handled)}")
    print(f"direct intent actions : {len(intents)}")
    print()

    unhandled = sorted(declared - handled)
    unreachable = sorted(handled - declared)

    problems = 0

    if unhandled:
        problems += len(unhandled)
        print("BUG: declared to the model but never handled:")
        for t in unhandled:
            print(f"  - {t}")
        print("  -> the model can call these and nothing happens.\n")

    if unreachable:
        problems += len(unreachable)
        print("BUG: implemented but never declared (dead code):")
        for t in unreachable:
            print(f"  - {t}")
        print("  -> the model can never emit these; the feature is unreachable.\n")

    if not problems:
        print("OK: declared and handled tools match exactly.")

    if "direct_intent" in declared and not intents:
        print("WARN: direct_intent declared but no actions parsed.")

    # Cross-check the dataset's schema against the app.
    sys.path.insert(0, str(REPO / "training/aria"))
    try:
        from schema import TOOLS

        schema_only = sorted(set(TOOLS) - declared)
        app_only = sorted(declared - set(TOOLS))
        if schema_only or app_only:
            print("\nWARN: training schema drifted from the app")
            if schema_only:
                print(f"  in schema, not in app: {schema_only}")
            if app_only:
                print(f"  in app, not in schema: {app_only}")
            print("  -> regenerate training data after fixing.")
    except ImportError:
        pass

    if args.strict and (problems or unhandled or unreachable):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
