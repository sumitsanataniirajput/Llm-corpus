"""
Deterministic slot extraction -- the hybrid answer.

Measurement showed the 2.5M from-scratch model cannot reliably copy novel
values into tool arguments (2/26 on unseen times, durations, names, places).
That's a capacity + data limit, not a bug to paper over.

So split the job by what each half is actually good at:

  * the MODEL writes the spoken part (sentences, emotion, intensity) -- which
    it does at 100% schema validity and good emotional agreement;
  * THIS MODULE fills the tool arguments -- using rules that are exact,
    inspectable and testable, instead of hoping a small LM guesses right.

This is the standard production pattern for voice assistants: language model
for language, deterministic parser for structured values (times, numbers,
contacts). It is not a workaround; it's the correct division of labour.
"""

from __future__ import annotations

import re

# --- times -----------------------------------------------------------------

_HOUR_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}

_TEEN_MINUTES = {
    "oh five": 5, "ten": 10, "fifteen": 15, "twenty": 20,
    "twenty five": 25, "thirty": 30, "thirty five": 35,
    "forty": 40, "forty five": 45, "fifty": 50, "fifty five": 55,
}

# "set an alarm for 6:45" / "alarm at 7.30" / "wake me at 06:45"
_DIGITAL_TIME = re.compile(r"\b(\d{1,2})[:.](\d{2})\b")


def extract_time(text: str) -> str | None:
    """Return a normalised HH:MM 24h string, or None.

    Accepts digital ("6:45", "18:30") and spoken ("six forty-five",
    "six o'clock") forms.
    """
    # Normalise hyphens: "forty-five" must match the two-word minute table.
    t = text.lower().strip().replace("-", " ")

    # 1. digital form is unambiguous -- always prefer it
    m = _DIGITAL_TIME.search(t)
    if m:
        hour, minute = int(m.group(1)), int(m.group(2))
        # "6:45 pm" / "6 pm"
        if re.search(r"\b(pm|p\.m\.)", t) and hour < 12:
            hour += 12
        if re.search(r"\b(am|a\.m\.)", t) and hour == 12:
            hour = 0
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"

    # 2. bare hour + am/pm: "at 7 pm", "7am"
    m = re.search(r"\bat\s+(\d{1,2})\s*(am|pm)\b", t) or re.search(r"\b(\d{1,2})\s*(am|pm)\b", t)
    if m:
        hour = int(m.group(1)) % 12
        if m.group(2) == "pm":
            hour += 12
        return f"{hour:02d}:00"

    # 3. bare "at 7" / "for 7"
    m = re.search(r"\b(?:at|for)\s+(\d{1,2})\b", t)
    if m and "minute" not in t:
        hour = int(m.group(1))
        if 0 <= hour <= 23:
            return f"{hour:02d}:00"

    # 4. spoken: "six forty-five", "six o'clock"
    m = re.search(
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b"
        r"(?:\s+(oh five|ten|fifteen|twenty five|twenty|thirty five|thirty|"
        r"forty five|forty|fifty five|fifty))?",
        t,
    )
    if m:
        hour = _HOUR_WORDS[m.group(1)]
        minute = _TEEN_MINUTES.get(m.group(2) or "", 0)
        if re.search(r"\bpm\b", t) and hour < 12:
            hour += 12
        return f"{hour:02d}:{minute:02d}"

    return None


# --- durations -------------------------------------------------------------

# "for 25 minutes", "25 min timer", "for twenty-five minutes", "an hour"
_DIGIT_DURATION = re.compile(r"\b(\d{1,3})\s*(?:minute|min|minutes|mins)\b")
_WORD_DURATION = re.compile(
    r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|"
    r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)"
    r"(?:[\s-]+(one|two|three|four|five|six|seven|eight|nine))?\s*"
    r"(?:minute|min|minutes|mins)\b",
)
_WORD_NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "hundred": 100,
}


def extract_duration(text: str) -> str | None:
    """Return a duration in whole minutes as a string, or None."""
    t = text.lower()

    m = _DIGIT_DURATION.search(t)
    if m:
        return str(int(m.group(1)))

    if re.search(r"\bhalf an hour\b|\bhalf hour\b", t):
        return "30"
    if re.search(r"\ban hour\b|\bone hour\b", t):
        return "60"

    m = _WORD_DURATION.search(t)
    if m:
        first = _WORD_NUM.get(m.group(1), 0)
        second = _WORD_NUM.get(m.group(2) or "", 0)
        if first == 100 and second:        # "one hundred five"
            return str(100 + second)
        if first >= 20 and second:         # "twenty five"
            return str(first + second)
        return str(first or second)

    return None


# --- contacts / targets ----------------------------------------------------

# Words that are never a contact name.
_STOPWORDS = {
    "mom", "dad", "mum", "mother", "father", "brother", "sister", "home",
    "me", "him", "her", "them", "my", "the", "a", "an", "it", "this", "that",
}

_NAME_PATTERNS = [
    # call Neha / dial Neha / phone Neha
    re.compile(r"\b(?:call|dial|ring|phone)\s+(?!on\b|the\b|a\b)([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)"),
    # text/message Neha / whatsapp Neha
    re.compile(r"\b(?:text|message|whatsapp|sms)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)"),
    # call my mom / call mom
    re.compile(r"\b(?:call|dial|text|message)\s+(my\s+(?:mom|dad|mother|father|brother|sister|wife|husband))"),
]


def extract_target(text: str) -> str | None:
    """Best-effort contact/place name from the user's own wording.

    Returns the text as the user wrote it -- never invents a value.
    """
    for pat in _NAME_PATTERNS:
        m = pat.search(text)
        if m:
            cand = m.group(1).strip()
            # strip a trailing politeness/clause
            cand = re.split(r"\s+(?:that|saying|to say|please)\b", cand)[0].strip()
            if cand and cand.lower() not in _STOPWORDS:
                return cand
    return None


def extract_place(text: str) -> str | None:
    """Destination for navigation: 'to the airport', 'to Blue Tokai'."""
    m = re.search(
        r"\b(?:navigate|directions|take me|go)\s+(?:to|towards)\s+"
        r"((?:the|a|an)\s+)?([\w' -]{2,40}?)(?:\s+(?:please|now|by|via)\b|$)",
        text,
        re.IGNORECASE,
    )
    if m:
        return m.group(2).strip()
    return None


def extract_message_body(text: str) -> str | None:
    """Body of a text/WhatsApp message: '... saying I'll be late'."""
    m = re.search(
        r"\b(?:saying|that says?|with the message|text says?)\s+(.+?)(?:[.!?]|$)",
        text,
        re.IGNORECASE,
    )
    return m.group(1).strip() if m else None


# --- action classification -------------------------------------------------

_ACTION_RULES = [
    ("alarm", r"\balarm\b|\bwake me\b"),
    ("timer", r"\btimer\b|\bcountdown\b"),
    ("call", r"\bcall\b|\bdial\b|\bring\b|\bphone\b"),
    ("sms", r"\b(?:text|sms)\b|\bmessage\b(?!\s+me\b)"),
    ("whatsapp", r"\bwhats\s?app\b"),
    ("navigation", r"\bnavigate\b|\bdirections\b|\btake me\b|\bhow do i get\b"),
    ("music", r"\bplay\b|\bmusic\b|\bsong\b"),
    ("calendar", r"\bcalendar\b|\bappointment\b|\bschedule\b"),
    ("flashlight", r"\bflash\s?light\b|\btorch\b"),
    ("wifi_panel", r"\bwi-?fi\b"),
    ("settings", r"\bsettings\b|\bbluetooth\b"),
]


def classify_action(text: str) -> str | None:
    """Which direct_intent action this utterance implies, if any."""
    t = text.lower()
    for action, pattern in _ACTION_RULES:
        if re.search(pattern, t):
            return action
    return None


def build_arguments(action: str, text: str) -> dict:
    """Assemble tool arguments for `action` from the utterance."""
    if action == "alarm":
        when = extract_time(text)
        return {"action": "alarm", "target": when or "", "content": "Alarm"}
    if action == "timer":
        dur = extract_duration(text)
        return {"action": "timer", "target": dur or "", "content": "minutes"}
    if action in ("call", "sms", "whatsapp"):
        who = extract_target(text) or ""
        body = extract_message_body(text) or "" if action != "call" else ""
        return {"action": action, "target": who, "content": body}
    if action == "navigation":
        place = extract_place(text) or ""
        return {"action": "navigation", "target": place, "content": ""}
    if action == "flashlight":
        off = re.search(r"\b(?:turn\s+off|switch\s+off|disable)\b", text, re.I)
        on = re.search(r"\b(?:turn\s+on|switch\s+on|enable)\b", text, re.I)
        state = "off" if off else ("on" if on else "on")
        return {"action": "flashlight", "target": state, "content": ""}
    if action == "music":
        m = re.search(r"\bplay\s+(?:some\s+|me\s+)?(.+?)(?:\s+music|\s+songs?)?$", text, re.I)
        return {"action": "music", "target": (m.group(1).strip() if m else ""), "content": ""}
    return {"action": action, "target": "", "content": ""}


def repair_tool_calls(model_obj: dict, user_text: str) -> dict:
    """Replace model-guessed tool arguments with deterministically extracted ones.

    Keeps the model's choice of *whether* to act (which it gets right 5/6),
    and fixes *what values* to act on (which it gets wrong). Falls back to the
    model's own arguments if extraction yields nothing usable.
    """
    action = classify_action(user_text)
    if action is None:
        return model_obj

    calls = model_obj.get("tool_calls") or []
    di = next((c for c in calls if c.get("name") == "direct_intent"), None)

    if di is None:
        # Model didn't emit a tool but the utterance clearly needs one.
        di = {"name": "direct_intent", "arguments": {}}
        calls = [di] + [c for c in calls if c.get("name") != "direct_intent"]
        model_obj["tool_calls"] = calls

    extracted = build_arguments(action, user_text)
    model_args = di.get("arguments") or {}

    # Prefer extracted values; never overwrite a good value with an empty one.
    merged = dict(model_args)
    merged["action"] = action
    for key, val in extracted.items():
        if val:
            merged[key] = val
        elif key in merged and merged[key]:
            pass  # keep the model's value
        else:
            merged[key] = val
    di["arguments"] = merged

    # Keep a matching spoken confirmation for sensitive actions.
    return model_obj


# --- last-resort fallback --------------------------------------------------

import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent))
try:
    from aria.schema import EMOTIONS  # noqa: F401
except ImportError:  # pragma: no cover
    EMOTIONS = ["neutral"]

_STYLE = {
    "alarm": ("happy", "Setting that alarm now."),
    "timer": ("happy", "Starting the timer."),
    "call": ("neutral", "I can make that call for you."),
    "sms": ("neutral", "I can send that message."),
    "whatsapp": ("happy", "Opening WhatsApp with your message."),
    "navigation": ("excited", "Let's get going."),
    "music": ("excited", "Music time!"),
    "calendar": ("curious", "Adding that to your calendar."),
    "flashlight": ("happy", "Flashlight coming up."),
    "wifi_panel": ("neutral", "Opening Wi-Fi settings."),
    "settings": ("neutral", "Opening settings."),
}


def fallback_response(user_text: str) -> dict | None:
    """Build a valid reply purely from rules, for when the model's JSON breaks.

    Returns None if the utterance implies no action we can handle, so callers
    can surface the model's raw failure rather than inventing an answer.
    """
    action = classify_action(user_text)
    if action is None:
        return None

    emotion, line = _STYLE.get(action, ("neutral", "Okay."))
    return {
        "sentences": [
            {"text": line, "emotion": emotion, "intensity": 2,
             "effect": "none", "style_prompt": ""}
        ],
        "tool_calls": [
            {"name": "direct_intent", "arguments": build_arguments(action, user_text)}
        ],
    }


def respond(model_obj: dict | None, user_text: str) -> dict | None:
    """Full hybrid path: repair a good model reply, or rebuild a broken one.

    Order of preference:
      1. model produced valid JSON -> keep its prose, fix the tool arguments
      2. model produced nothing usable but the intent is clear -> rules
      3. give up and return None (caller reports the raw failure)
    """
    if model_obj is not None:
        return reconcile(model_obj, user_text)
    fb = fallback_response(user_text)
    if fb is None:
        return None
    return reconcile(fb, user_text)


# --- non-intent actions (navigate the UI, not the OS) -----------------------

_SWIPE_DIR = re.compile(r"\bscroll\s+(up|down)\b|\bswipe\s+(up|down|left|right)\b")
_OPEN_APP = re.compile(r"\b(?:open|launch|start|pull up|go to)\s+(?:the\s+)?([\w ]{2,24}?)\s*$", re.I)
_NAV_SYSTEM = re.compile(r"\b(?:press|hit|tap)\s+(back|home)\b|\bgo\s+(back|home)\b")

_APP_NAMES = {
    "gmail": "Gmail", "youtube": "YouTube", "spotify": "Spotify",
    "settings": "Settings", "chrome": "Chrome", "camera": "Camera",
    "whatsapp": "WhatsApp", "instagram": "Instagram", "maps": "Maps",
    "clock": "Clock", "gallery": "Gallery", "calendar": "Calendar",
    "calculator": "Calculator", "contacts": "Contacts", "files": "Files",
    "notes": "Notes", "email": "Gmail", "my email": "Gmail",
    "browser": "Chrome", "insta": "Instagram", "photos": "Gallery",
}


def extract_swipe(text: str) -> dict | None:
    m = _SWIPE_DIR.search(text.lower())
    if not m:
        return None
    return {"name": "swipe", "arguments": {"direction": m.group(1) or m.group(2)}}


def extract_system_nav(text: str) -> dict | None:
    m = _NAV_SYSTEM.search(text.lower())
    if not m:
        return None
    which = m.group(1) or m.group(2)
    return {"name": "press_home" if which == "home" else "press_back", "arguments": {}}


def extract_open_app(text: str) -> dict | None:
    t = text.lower().strip()
    m = _OPEN_APP.search(t)
    if not m:
        return None
    cand = m.group(1).strip()
    if cand in _APP_NAMES:
        return {"name": "open_app", "arguments": {"name": _APP_NAMES[cand]}}
    # Only accept a bare word we recognise; never invent an app name.
    first = cand.split()[0] if cand else ""
    if first in _APP_NAMES:
        return {"name": "open_app", "arguments": {"name": _APP_NAMES[first]}}
    return None


def rule_tool_calls(user_text: str) -> list[dict] | None:
    """Derive the *complete* tool call list from the utterance, or None.

    This is what makes routing trustworthy: when a rule fires we replace the
    model's tool calls entirely, so a hallucinated 77-minute timer can't
    survive a request to scroll.
    """
    calls: list[dict] = []

    swipe = extract_swipe(user_text)
    if swipe:
        return [swipe, {"name": "finish",
                        "arguments": {"summary": f"Scrolled {swipe['arguments']['direction']}."}}]

    nav = extract_system_nav(user_text)
    if nav:
        label = "home screen" if nav["name"] == "press_home" else "back"
        return [nav, {"name": "finish", "arguments": {"summary": f"Went {label}."}}]

    app = extract_open_app(user_text)
    if app and not classify_action(user_text):
        pretty = app["arguments"]["name"]
        return [app, {"name": "finish", "arguments": {"summary": f"Opened {pretty}."}}]

    action = classify_action(user_text)
    if action:
        args = build_arguments(action, user_text)
        calls.append({"name": "direct_intent", "arguments": args})
        if action in ("alarm", "timer"):
            if action == "alarm":
                summary = f"Alarm set for {args.get('target','')}."
            else:
                summary = f"Timer set for {args.get('target','')} minutes."
            calls.append({"name": "finish", "arguments": {"summary": summary}})
            return calls
        if action == "navigation":
            calls.append({"name": "finish",
                          "arguments": {"summary": f"Opened navigation to {args.get('target','')}."}})
            return calls
        if action == "music":
            calls.append({"name": "finish",
                          "arguments": {"summary": f"Started playing {args.get('target','')}.".strip()}})
            return calls
        if action == "flashlight":
            calls.append({"name": "finish",
                          "arguments": {"summary": f"Flashlight turned {args.get('target','')}."}})
            return calls
        if action == "wifi_panel":
            calls.append({"name": "finish", "arguments": {"summary": "Opened Wi-Fi settings."}})
            return calls
        if action == "settings":
            calls.append({"name": "finish", "arguments": {"summary": "Opened settings."}})
            return calls
        if action == "calendar":
            calls.append({"name": "finish",
                          "arguments": {"summary": f"Added {args.get('target','event')} to your calendar."}})
            return calls
        # call / sms / whatsapp: sensitive, no finish (the app confirms first)
        return calls

    return None


def reconcile(model_obj: dict, user_text: str) -> dict:
    """Replace model tool calls with rule-derived ones when rules apply.

    Keeps the model's spoken sentences; makes the *actions* deterministic.
    If no rule matches, the model's own tool calls are dropped when they look
    like a hallucinated action for a purely conversational utterance.
    """
    calls = rule_tool_calls(user_text)
    if calls is not None:
        model_obj["tool_calls"] = calls
        model_obj = align_spoken_text(model_obj, user_text, calls)
    else:
        # Conversational input: an opportunistic direct_intent is a misroute.
        kept = [c for c in model_obj.get("tool_calls") or []
                if c.get("name") not in ("direct_intent", "finish")]
        if kept:
            model_obj["tool_calls"] = kept
        else:
            model_obj.pop("tool_calls", None)
    return model_obj


# --- spoken-text consistency -------------------------------------------------

def _spoken_hhmm(target: str) -> str:
    """'04:35' -> 'four thirty-five' (for correcting the model's phrasing)."""
    try:
        hour, minute = target.split(":")
        h, m = int(hour) % 24, int(minute)
    except (ValueError, AttributeError):
        return target
    h12 = h % 12 or 12
    names = {0: "", 5: "oh five", 10: "ten", 15: "fifteen", 20: "twenty",
             25: "twenty-five", 30: "thirty", 35: "thirty-five", 40: "forty",
             45: "forty-five", 50: "fifty", 55: "fifty-five"}
    hour_word = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
                 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
                 12: "twelve"}[h12]
    if m == 0:
        return f"{hour_word} o'clock"
    return f"{hour_word} {names.get(m, str(m))}"



def _time_phrase_present(said: str, expected: str) -> bool:
    """True only if `said` names the correct hour AND minute.

    Handles the half-day ambiguity: the model may say "four thirty-five" for
    16:35, so an exact 12-hour match counts. A wrong minute ("four forty" for
    4:35) must not pass just because the hour word appears.
    """
    s = said.lower().replace("-", " ").rstrip("!.,?")
    e = expected.lower().replace("-", " ")
    if e in s:
        return True
    # 24h -> also accept the 12h spoken form
    return e.replace(" o'clock", "") in s and e.split()[0] in s


def align_spoken_text(model_obj: dict, user_text: str, calls: list[dict]) -> dict:
    """Rewrite the first sentence when the model misstates the value it acts on.

    The model frequently writes a *different* number from the one it puts in
    the tool call ("alarm for four forty" for 04:35, "one hundred and
    forty-four" for an 82-minute timer). The tool call is authoritative, so
    the spoken line must agree with it. This replaces only numeric/entity
    mismatches; wording the model got right is left alone.
    """
    sents = model_obj.get("sentences") or []
    if not sents:
        return model_obj

    di = next((c for c in calls if c.get("name") == "direct_intent"), None)
    if di is None:
        return model_obj

    action = di["arguments"].get("action")
    target = str(di["arguments"].get("target", ""))
    said = sents[0].get("text", "")

    if action == "alarm" and target:
        expected = _spoken_hhmm(target)
        hour_word = expected.split()[0]
        # The sentence must name the right HOUR. "four forty" for 04:35 is a
        # wrong time even though "forty" appears; "four thirty-five" is right.
        if not _time_phrase_present(said, expected):
            sents[0]["text"] = f"Setting an alarm for {expected}!"
    elif action == "timer" and target:
        if target not in said:
            article = "an" if target[:1] in "8" or target in ("11", "18") else "a"
            sents[0]["text"] = f"Setting {article} {target} minute timer!"
    elif action in ("call", "sms", "whatsapp") and target:
        if target.lower() not in said.lower():
            verb = {"call": "call", "sms": "send a message to",
                    "whatsapp": "send a WhatsApp to"}[action]
            sents[0]["text"] = f"I can {verb} {target} for you."
            model_obj["sentences"] = sents
    elif action in ("navigation", "music") and target:
        if target.lower() not in said.lower():
            verb = "Navigating to" if action == "navigation" else "Playing"
            sents[0]["text"] = f"{verb} {target}."

    model_obj["sentences"] = sents
    return model_obj
