#!/usr/bin/env python3
"""Redact secrets from a Claude Code session transcript before it is published.

Publishing raw session transcripts leaks credentials: real sessions have contained
API keys, OAuth tokens, WAN addresses and internal LAN topology. This module is the
gate every publish path goes through.

Detection has four layers, because none is sufficient alone:

  1. Known-value redaction. Exact secret values are read at RUNTIME from the
     environment and local token files, never hardcoded here, and struck from the
     text. This is the high-confidence layer -- it scores 1.0 by definition.
  2. Named patterns. Vendor prefixes (sk-ant-, ghp_, AKIA, JWT, PEM blocks) plus
     STRUCTURAL shapes where credential-ness comes from the position rather than
     the value: the userinfo field of a URI, `password=`/`api_key:` assignments,
     credential-named JSON keys, credential-named query parameters, CLI password
     flags. A password is a password because of where it sits, not because it
     looks random -- most real passwords do not.
  3. Structure detectors that regexes over a single token cannot express:
     BIP39-shaped mnemonics, blocks of 2FA recovery codes, Luhn-valid card
     numbers.
  4. Pattern + entropy scoring over a heuristic, for the opaque blobs we hold no
     copy of and that carry no structural marker.

Layers 2-4 are also run over NORMALIZED SHADOW COPIES of the text (line-unwrapped
base64, quoted-printable soft breaks removed, JSON `\\n` escapes removed, interior
separators removed, percent-decoded) with an index map back to the original, so a
credential that has been chopped up by wrapping or encoding is still caught and the
ORIGINAL span is destroyed.

GRADUATED RESPONSE
------------------
Redaction is not binary. Every detection carries a confidence score in 0.0-1.0 and
two thresholds decide what happens to it:

    score >= --redact-threshold (default 0.85)  ->  [REDACTED:LABEL]
    score >= --garble-threshold (default 0.382) ->  <~garbled:LEN:FP~>
    below that                                  ->  left untouched

The middle band exists because the old binary gate forced a bad choice: either nuke
every high-entropy string (destroying the shape of the transcript -- you could no
longer tell a 12-char id from a 400-char blob) or leave maybes in the clear. A
garbled value is destroyed but its *shape* survives: the reader sees that something
was there and how long it was, and identical values garble identically so
intra-document correlation ("this is the same string as up there") is preserved.

Garbling is a keyed one-way hash (blake2b), never a cipher and never an encoding.
It cannot be reversed, by us or by anyone.

THE SCORING MODEL
-----------------
Deliberately a transparent weighted heuristic, not a model anyone has to trust
blindly. Every weight below is a named constant; a human can read them, argue with
them, and tune them. Features: Shannon entropy, length, character-class diversity,
and lexical CONTEXT (a big bump when the same line -- or the label line above it --
already said token/key/secret/password/auth/bearer/credential before the
candidate). Penalties push back on the things that look random but are identifiers,
not credentials: bare UUIDs, short hex digests, filesystem paths and URLs, dotted
names. Every penalty is CONDITIONAL: a UUID after the word `api_key` is not an
identifier, and a hyphen-joined lowercase run after `passphrase:` is not prose.

Then a verification pass re-scans the *output* and fails loudly on anything that
still scores at or above the redact threshold. A publish pipeline must treat a
non-zero exit as "do not ship" -- silent partial redaction is worse than no
redaction, because it looks safe. Garbled values in the output are fine; that is
the point of them.

LIMITATIONS (known, deliberate, unfixed)
----------------------------------------
These are honest gaps, not promises. Do not read a clean run as proof the
transcript is safe -- read it as proof that nothing we know how to look for
survived.

  * No bundled BIP39 wordlist. Mnemonics are detected by SHAPE (a run of 12/15/18/
    21/24 short lowercase words with at most one English function word among them),
    not by membership. A mnemonic whose words happen to include two function words
    that are also BIP39 entries is missed; a contrived prose sentence of the same
    shape is a false positive.
  * A bare secret with no structural marker, no credential keyword anywhere near
    it, fewer than 16 characters, and only one or two character classes is
    invisible. `hunter2` on a line by itself cannot be distinguished from any other
    seven-character word, and no threshold setting changes that.
  * Only single-step encodings are undone. Double percent-encoding, base64 of
    base64, gzip+base64, and encodings we do not model still hide a credential from
    every layer.
  * Context is line-scoped, plus a single carry-over from a label line immediately
    above. A keyword three lines up from its value does not bump anything.
  * Known-value redaction covers the env vars and token files listed below and
    nothing else. Third-party credentials that are shaped like identifiers (UUID
    form especially) rely entirely on structural context; main() prints a warning
    count when UUID-shaped values with credential context survive so a human can
    look.

Usage:
    python session-redact.py SESSION.jsonl -o out.md
    python session-redact.py SESSION.jsonl --check      # verify only, no output
    python session-redact.py SESSION.jsonl --redact-threshold 0.7
"""

from __future__ import annotations

import argparse
import base64
import binascii
import bisect
import hashlib
import json
import math
import os
import re
import secrets
import sys
from pathlib import Path

# Env vars whose *values* are secrets. Read at runtime so no secret is stored here.
SECRET_ENV_VARS = (
    "OPNSENSE_API_KEY",
    "OPNSENSE_API_SECRET",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CF_API_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
)

# Files whose entire contents are a single secret.
SECRET_FILES = ("~/.backrooms-cf-token",)

# JSON credential stores: file -> keys whose values are secrets.
SECRET_JSON_FILES = {
    "~/.claude/.credentials.json": ("accessToken", "refreshToken"),
}

# ---------------------------------------------------------------------------
# Confidence scale. Everything downstream is a number in [0, 1].
# ---------------------------------------------------------------------------

DEFAULT_REDACT_THRESHOLD = 0.85
DEFAULT_GARBLE_THRESHOLD = 0.382  # 1 - 1/phi; a deliberate, memorable "maybe" line

# We hold the literal value, so there is nothing to be uncertain about.
KNOWN_VALUE_SCORE = 1.0

# ---------------------------------------------------------------------------
# Value validators. A structural pattern says "a credential goes HERE"; a
# validator says "...and this particular text is not obviously a placeholder".
# They exist to keep `secret = None` and `-p8080:80` out of the output, nothing
# more -- when in doubt a validator says yes.
# ---------------------------------------------------------------------------

_PLACEHOLDER = re.compile(
    r"\A(?:none|null|nil|true|false|undefined|no|yes|n/a|xxx+|x{3,}|\*+|\.+|-+|_+"
    r"|redacted\w*|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?|%[A-Za-z_]+%"
    r"|(?:os|process|env|self|this)\..*)\Z",
    re.I,
)


def _secretish(v: str) -> bool:
    """Mixed enough to be a generated/typed credential rather than a word."""
    return (
        any(c.isdigit() for c in v)
        or any(not c.isalnum() for c in v)
        or (any(c.islower() for c in v) and any(c.isupper() for c in v))
    )


def _credential_value(v: str) -> bool:
    if v.startswith("[REDACTED") or v.startswith("<~garbled"):
        return False
    if "(" in v or ")" in v or _PLACEHOLDER.match(v):
        return False
    return len(v) >= 16 or _secretish(v)


def _spaced_credential_value(v: str) -> bool:
    """Whitespace-separated `password VALUE`: prose is one word away, so be strict."""
    return _credential_value(v) and _secretish(v)


def _cli_value(v: str) -> bool:
    """`-p<value>`: must not be a port map, a path or a plain flag argument."""
    if re.fullmatch(r"[\d:.\-/]+", v):
        return False
    return _credential_value(v) and _secretish(v)


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


CARD_IINS = "3456"  # Amex/Diners/JCB, Visa, Mastercard, Discover/UnionPay


def _card_number(v: str) -> bool:
    """Luhn plus a plausible issuer digit.

    Luhn alone is a 1-in-10 filter, and a 13-digit epoch-millisecond timestamp
    passes it often enough to be a nuisance. Requiring the leading digit of an
    actual card network costs nothing and drops that whole false-positive class.
    """
    digits = re.sub(r"[ \-]", "", v)
    if not (13 <= len(digits) <= 19 and digits.isdigit()):
        return False
    return digits[0] in CARD_IINS and _luhn(digits)


# ---------------------------------------------------------------------------
# Named patterns. Entries are (label, regex, group, validator). `group` names the
# capture holding the value to destroy -- structural patterns match the *frame*
# (`password=`, `://user:`, `?sig=`) and redact only what sits in the slot, so the
# frame stays readable and the transcript still says what kind of thing was there.
# Ordered with the most specific first; ties in the overlap resolver break by
# score, then length, then position.
# ---------------------------------------------------------------------------

UUID_CORE = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# The vocabulary that makes a slot a credential slot.
SECRET_WORD = (
    r"(?:pass(?:word|wd|phrase)?|pwd|passcode|secret|token|api[_\- ]?key|apikey"
    r"|auth(?:orization)?|bearer|credential|client[_\-]?secret|access[_\-]?key"
    r"|private[_\-]?key|signing[_\-]?key|session[_\-]?key|hec[_\-]?token"
    r"|app[_\-]?key|consumer[_\-]?secret)"
)

PATTERNS = (
    ("PRIVATE_KEY", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), 0, None),
    ("ANTHROPIC_KEY", re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}"), 0, None),
    ("GITHUB_PAT", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), 0, None),
    ("GITHUB_TOKEN", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), 0, None),
    ("AWS_KEY", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), 0, None),
    ("SLACK_TOKEN", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"), 0, None),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), 0, None),

    # Structural: a credential by position, redacted regardless of length/entropy.
    # `scheme://user:PASSWORD@host` is not produced by accident.
    ("DSN_PASSWORD", re.compile(r"\b[A-Za-z][A-Za-z0-9+.\-]*://(?:[^\s:/@]+)?:(?P<secret>[^\s/@]+)@"), "secret", None),
    ("URL_SECRET", re.compile(
        r"(?i)[?&](?:sig|signature|access[_\-]?token|refresh[_\-]?token|id[_\-]?token"
        r"|api[_\-]?key|apikey|token|key|password|passwd|pwd|secret|auth|credential)"
        r"=(?P<secret>[^&\s\"'<>]{8,})"), "secret", None),
    ("JSON_SECRET", re.compile(
        r"(?i)\"(?:auth|password|passwd|pwd|secret|token|apikey|api_key|client_secret"
        r"|private_key|accountkey|[a-z][a-z0-9_\-]*[_\-]key(?:[_\-]?data)?)\""
        r"\s*:\s*\"(?P<secret>[^\"\\\n]{4,})\""), "secret", _credential_value),
    ("UUID_SECRET", re.compile(r"(?i)" + SECRET_WORD + r"\W{0,6}(?P<secret>" + UUID_CORE + r")"), "secret", None),
    ("ASSIGNED_SECRET", re.compile(
        r"(?i)" + SECRET_WORD + r"[\"']?\s*(?:[:=]|=>)\s*"
        r"(?:Bearer\s+|Basic\s+|Token\s+)?[\"']?(?P<secret>[^\s\"'`,;]{6,})"), "secret", _credential_value),
    ("ASSIGNED_SECRET", re.compile(r"(?i)\b" + SECRET_WORD + r"\s+(?P<secret>[^\s\"'`,;]{6,})"), "secret", _spaced_credential_value),
    ("CLI_SECRET", re.compile(
        r"(?:--password[= ]|--passwd[= ]|--token[= ]|--api-key[= ]|--secret[= ]"
        r"|PGPASSWORD=|MYSQL_PWD=|REDIS_PASSWORD=|sshpass\s+-p\s*|(?<=\s)-a\s+|(?<=\s)-p(?=\S))"
        r"\s*[\"']?(?P<secret>[^\s\"']{6,})"), "secret", _cli_value),
    ("PIN_CODE", re.compile(r"(?i)\b(?:pin|cvv|cvc|passcode|otp)\b[^\d\n]{0,12}(?P<secret>\d{3,8})\b"), "secret", None),

    # Regulated identifiers. Privacy classes, like EMAIL/PRIVATE_IP below.
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), 0, None),
    ("CARD_NUMBER", re.compile(r"\b(?:\d[ \-]?){12,18}\d\b"), 0, _card_number),

    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), 0, None),
    ("PRIVATE_IP", re.compile(r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b"), 0, None),

    # Base32: TOTP/MFA seeds and recovery secrets. Digest-shaped, so garble tier.
    ("BASE32_SECRET", re.compile(r"\b[A-Z2-7]{16,}={0,6}\b"), 0, None),
)

# Base confidence per named pattern. The credential prefixes are issued by one
# vendor each and are not produced by accident, so they sit above the redact
# threshold on shape alone. The structural patterns clear it too: the frame, not
# the value, is the evidence. EMAIL/PRIVATE_IP/SSN/CARD_NUMBER are privacy classes
# rather than credentials but we still want them gone.
PATTERN_CONFIDENCE = {
    "PRIVATE_KEY": 1.00,
    "ANTHROPIC_KEY": 0.99,
    "GITHUB_PAT": 0.99,
    "GITHUB_TOKEN": 0.97,
    "DSN_PASSWORD": 0.97,
    "AWS_KEY": 0.96,
    "SLACK_TOKEN": 0.96,
    "JWT": 0.95,
    "URL_SECRET": 0.95,
    "JSON_SECRET": 0.95,
    "UUID_SECRET": 0.95,
    "ASSIGNED_SECRET": 0.95,
    "CLI_SECRET": 0.95,
    "SSN": 0.95,
    "CARD_NUMBER": 0.95,
    "MNEMONIC": 0.98,
    "RECOVERY_CODE": 0.95,
    "PIN_CODE": 0.90,
    "EMAIL": 0.90,
    "PRIVATE_IP": 0.90,
    "BASE32_SECRET": 0.55,
}

# Labels that are not credentials. They are still redacted, but a residual one in
# the output is not a reason to block a publish -- see verify().
NON_CREDENTIAL_LABELS = ("EMAIL", "PRIVATE_IP")

# A token must be at least this long to be scored at all when nothing else marks
# it. CANDIDATE_MIN_LEN is the floor for an unanchored scan; when a credential
# keyword already appeared on the line, the floor drops -- context is what makes a
# 12-character span worth looking at, and the old floor of 24 meant the context
# bump could never apply to anything in the realistic password length range.
CANDIDATE_MIN_LEN = 16
CANDIDATE_ANCHORED_MIN_LEN = 8
ENTROPY_MIN_LEN = 24  # length-weight scaling floor; see W_LENGTH
ENTROPY_MIN_BITS = 3.2
CANDIDATE = re.compile(r"[A-Za-z0-9+/=_\-]{%d,}" % CANDIDATE_MIN_LEN)
CANDIDATE_ANCHORED = re.compile(r"[A-Za-z0-9+/=_\-]{%d,}" % CANDIDATE_ANCHORED_MIN_LEN)

# A whole opaque field, including the punctuation that CANDIDATE treats as a
# delimiter. Only ever applied to the trailing value on a line that already said
# "password"/"key"/... -- unanchored it would eat source code and prose.
TRAILING_FIELD = re.compile(r"(\S{8,})\s*$")
FIELD_STRIP = "\"'`.,;:)]}>"

# Whole-token runs that are dense with the punctuation generated password rules
# push people towards. No '/' or ':' so URLs and paths do not qualify.
SYMBOL_DENSE = re.compile(r"(?<!\S)[A-Za-z0-9!#$%&*^~@+\-_=?.]{16,}(?!\S)")
SYMBOL_DENSE_SCORE = 0.60
SYMBOL_CHARS = re.compile(r"[!#$%&*^~@]")

# Canonical UUIDs are usually identifiers -- session ids, resource ids, run ids --
# and they saturate the entropy net. Penalising them keeps the verification gate
# credible; a gate that fires on every session id trains people to ignore it. But
# the penalty is CONDITIONAL: plenty of third-party credentials (Splunk HEC
# tokens, Azure AD client secrets, Wazuh/Grafana keys) are issued in UUID form,
# and a UUID sitting after the word `api_key` is not an identifier. See
# UUID_SECRET above for the assignment shape, and uuid_context_survivors() for the
# warning printed when one slips through anyway.
UUID_RX = re.compile(r"\A" + UUID_CORE + r"\Z")

# Hex strings this long are digests, keys or ids, not prose. 32 is the canonical
# dashless-UUID / MD5-key / Twilio-token length and a far stronger credential
# prior than a generic digest; 40-char commit shas land here too and garbling one
# costs nothing.
LONG_HEX = re.compile(r"\b[0-9a-fA-F]{32,}\b")
LONG_HEX_SCORE = 0.55  # digest-shaped: suspicious enough to garble, not to nuke
HEX_NO_PENALTY_LEN = 32  # at/above this, "incidental id" stops being likely

HEX_ONLY = re.compile(r"[0-9a-fA-F]+")
WORD_LIKE = re.compile(r"[a-z_\-]+|[A-Z_\-]+")

# ---------------------------------------------------------------------------
# Structure detectors: shapes no single-token regex can express.
# ---------------------------------------------------------------------------

# Runs of short lowercase words: a mnemonic seed phrase. No wordlist is bundled
# (see LIMITATIONS); membership is approximated by "almost no English function
# words", which prose cannot satisfy over 12+ consecutive words.
MNEMONIC_RUN = re.compile(r"(?<![A-Za-z])[a-z]{3,8}(?:[ \t\n]+[a-z]{3,8}){11,23}(?![A-Za-z])")
MNEMONIC_LENGTHS = (12, 15, 18, 21, 24)
STOPWORDS = frozenset(
    """the and but for nor yet not you your our its his her him she was were been
    this that these those with from they them their there then than when what
    which who whom whose will would can could should shall may might must all
    any some such only also very just more most much many into over under about
    after before because while where how why does did done has have had here
    are was for not one out its""".split()
)
MNEMONIC_MAX_STOPWORDS = 1

# 2FA / recovery code blocks: several consecutive lines of short grouped chunks.
RECOVERY_LINE = re.compile(r"\A[A-Za-z0-9]{4,6}(?:[- ][A-Za-z0-9]{4,6})+\Z")
RECOVERY_MIN_LINES = 3

# ---------------------------------------------------------------------------
# Scoring weights. Audit and tune these; nothing else decides the outcome.
# The unpenalised maximum is SCORE_BASE + W_ENTROPY + W_LENGTH + W_CLASSES = 0.85,
# i.e. a maximally random long mixed-class token lands exactly on the default
# redact threshold, and anything short of maximal needs CONTEXT to get there.
# ---------------------------------------------------------------------------

SCORE_BASE = 0.10       # merely being a long opaque run is weak evidence
W_ENTROPY = 0.30        # scaled over [ENTROPY_MIN_BITS, ENTROPY_FULL_BITS]
W_LENGTH = 0.20         # scaled over [ENTROPY_MIN_LEN, LENGTH_SATURATION]
W_CLASSES = 0.25        # scaled over 1..4 character classes present
W_CONTEXT = 0.30        # "token"/"secret"/... earlier on the same line

ENTROPY_FULL_BITS = 4.8  # ~base64 alphabet saturation
LENGTH_SATURATION = 48   # beyond this, extra length says nothing new

P_UUID = -0.60          # bare canonical UUID: an identifier, not a credential
P_PATH = -0.35          # sits inside a filesystem path
P_URL = -0.30           # sits inside a URL
P_DOTTED = -0.25        # part of a dotted name (module.path.thing, host names)
P_HEX_ONLY = -0.20      # short pure hex: digest or id, low credential prior
P_WORD_LIKE = -0.45     # single-case run with separators: prose, not a token
B_PASSPHRASE = +0.10    # ...unless it is a diceware passphrase, which is not prose

# A diceware/hyphenated passphrase is lexically indistinguishable from prose, so
# P_WORD_LIKE would erase it. These say when a single-case separator-joined run is
# a passphrase instead: enough segments, long enough, and no English function word
# among the segments ("state-of-the-art-design" stays prose).
PASSPHRASE_MIN_SEGMENTS = 4
PASSPHRASE_MIN_LEN = 20
SEGMENT_SPLIT = re.compile(r"[-_]+")

# A word-like run on a credential line is only exempt from P_WORD_LIKE once it is
# too long to be an ordinary word ("opnsense" on a password line is still a word).
WORD_LIKE_CONTEXT_MIN_LEN = 24

# Below ENTROPY_MIN_LEN with no keyword anywhere on the line, an opaque run needs
# real diversity to be worth scoring -- otherwise every SCREAMING_CONSTANT and
# camelCase identifier in the transcript lands in the garble band.
SHORT_SPAN_MIN_CLASSES = 3
HAS_DIGIT = re.compile(r"[0-9]")

# Context is scanned per line, before the candidate. Only detections weaker than
# this ceiling can be bumped -- the named credential patterns are already decided.
CONTEXT_BUMP_CEILING = 0.95
CONTEXT_KEYWORDS = re.compile(
    r"token|key|secret|password|passwd|passphrase|pwd|passcode|auth|bearer|credential"
    r"|private|oauth|signature|recovery|backup code|one-time|otp|2fa|mfa|totp"
    r"|mnemonic|seed|\bpin\b|\bcvv\b|\bcvc\b|login|wallet",
    re.I,
)
# A label line with no value on it ("api key for the storage account:") carries its
# context down to the next line. Pretty-printed JSON, YAML block scalars, kubeconfig
# and dashboard pastes all put the label and the value on separate lines, and that
# split was the entire difference between untouched and redacted.
LABEL_LINE_END = re.compile(r"[:=>|]\s*\Z")

# Immediate neighbourhood inspected for path/URL/dotted penalties. Kept tiny on
# purpose: the verification pass must score a surviving token identically to the
# redaction pass, and a small window is not perturbed by nearby replacements.
NEIGHBOUR_CHARS = 3

# Replacement markers. Both are recognised again on the way back in, so the
# verification pass does not score its own footprints.
REDACT_MARK = "[REDACTED:{label}]"
MARKER_RX = re.compile(r"\[REDACTED:[A-Za-z0-9_.\-]+\]|<~garbled:\d+:[0-9a-f]+~>")

# ---------------------------------------------------------------------------
# Garbling.
#
# One-way only: blake2b keyed with a random salt generated fresh for THIS process
# and never written anywhere. The tradeoff that buys:
#
#   * WITHIN one run/document, equal inputs give equal fingerprints, so a reader
#     can still see "the same value appears in three places" -- which is often the
#     whole reason the line was worth reading.
#   * ACROSS runs, the same input gives a different fingerprint, so nobody can
#     build a rainbow table of candidate secrets and match it against a published
#     transcript, and nobody can correlate two published transcripts to learn that
#     they share a credential.
#
# The length IS disclosed, on purpose -- it is what makes a garbled value readable
# as "something of this size was here". That is a small, deliberate leak: it tells
# an attacker a token's length and nothing else.
# ---------------------------------------------------------------------------

GARBLE_SALT_BYTES = 16
GARBLE_FINGERPRINT_CHARS = 4
_GARBLE_SALT = secrets.token_bytes(GARBLE_SALT_BYTES)


def garble(value: str) -> str:
    """Irreversibly replace a value with a length-preserving marker."""
    digest = hashlib.blake2b(
        value.encode("utf-8", "replace"), key=_GARBLE_SALT, digest_size=8
    ).hexdigest()
    return f"<~garbled:{len(value)}:{digest[:GARBLE_FINGERPRINT_CHARS]}~>"


def shannon_bits(s: str) -> float:
    if not s:
        return 0.0
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def char_classes(s: str) -> int:
    return sum(
        bool(re.search(p, s)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[+/=_\-]")
    )


def _is_passphrase_shaped(tok: str) -> bool:
    """A separator-joined single-case run that is a passphrase, not prose."""
    if len(tok) < PASSPHRASE_MIN_LEN:
        return False
    segs = [s for s in SEGMENT_SPLIT.split(tok) if s]
    if len(segs) < PASSPHRASE_MIN_SEGMENTS:
        return False
    if not all(s.isalpha() for s in segs):
        return False
    return not any(s.lower() in STOPWORDS for s in segs)


class ContextIndex:
    """Where the credential-ish words are, line by line.

    Context is line-scoped rather than character-windowed so that the score a
    token gets during redaction is the score it gets again during verification:
    replacing a value elsewhere on the line shortens the line but cannot smuggle a
    new keyword in front of a survivor. Keyword hits inside our own replacement
    markers are ignored for the same reason -- "[REDACTED:GITHUB_TOKEN]" must not
    manufacture the word "token".

    One deterministic exception to line-scoping: a LABEL LINE (contains a keyword
    and ends in ':', '=', '>' or '|', i.e. announces a value it does not contain)
    carries its context to the following line.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self._line_starts = [0]
        for m in re.finditer(r"\n", text):
            self._line_starts.append(m.end())
        self._hits: dict[int, list[int]] = {}
        self._inherited: dict[int, bool] = {}

    def _line_start(self, pos: int) -> int:
        i = bisect.bisect_right(self._line_starts, pos) - 1
        return self._line_starts[max(i, 0)]

    def _line_text(self, start: int) -> str:
        end = self.text.find("\n", start)
        if end < 0:
            end = len(self.text)
        return self.text[start:end]

    def _line_hits(self, start: int) -> list[int]:
        cached = self._hits.get(start)
        if cached is not None:
            return cached
        line = self._line_text(start)
        masked = [(m.start(), m.end()) for m in MARKER_RX.finditer(line)]
        hits = []
        for m in CONTEXT_KEYWORDS.finditer(line):
            if any(s <= m.start() < e for s, e in masked):
                continue
            hits.append(start + m.end())
        self._hits[start] = hits
        return hits

    def _inherits(self, start: int) -> bool:
        """Does the nearest non-blank line above announce a value for this one?"""
        cached = self._inherited.get(start)
        if cached is not None:
            return cached
        result = False
        i = bisect.bisect_left(self._line_starts, start) - 1
        while i >= 0:
            prev_start = self._line_starts[i]
            prev = self._line_text(prev_start)
            if prev.strip():
                stripped = MARKER_RX.sub(" ", prev)
                result = bool(
                    LABEL_LINE_END.search(stripped) and CONTEXT_KEYWORDS.search(stripped)
                )
                break
            i -= 1
        self._inherited[start] = result
        return result

    def keyword_before(self, pos: int) -> bool:
        start = self._line_start(pos)
        hits = self._line_hits(start)
        if bisect.bisect_left(hits, pos) > 0:
            return True
        return self._inherits(start)


def score_candidate(text: str, start: int, end: int, ctx: ContextIndex) -> float:
    """Weighted heuristic confidence that text[start:end] is a credential.

    Supersedes the old binary looks_random() gate: the same features, but each
    contributes a documented weight instead of voting the value out entirely.
    Every penalty is conditional on the evidence that motivated it still holding.
    """
    tok = text[start:end]
    before = text[max(0, start - NEIGHBOUR_CHARS):start]
    after = text[end:end + NEIGHBOUR_CHARS]
    has_context = ctx.keyword_before(start)

    score = SCORE_BASE
    score += W_ENTROPY * clamp01(
        (shannon_bits(tok) - ENTROPY_MIN_BITS) / (ENTROPY_FULL_BITS - ENTROPY_MIN_BITS)
    )
    score += W_LENGTH * clamp01(
        (len(tok) - ENTROPY_MIN_LEN) / (LENGTH_SATURATION - ENTROPY_MIN_LEN)
    )
    score += W_CLASSES * ((char_classes(tok) - 1) / 3.0)

    # A UUID is an identifier only until something calls it a key.
    if UUID_RX.match(tok) and not has_context:
        score += P_UUID
    # Pure hex is an id at digest length and below; past that it is a key shape.
    if HEX_ONLY.fullmatch(tok) and len(tok) < HEX_NO_PENALTY_LEN:
        score += P_HEX_ONLY
    if WORD_LIKE.fullmatch(tok):
        # Prose is single-case with separators; so is a diceware passphrase, and so
        # is the word "opnsense" sitting on a line that mentions passwords. Only the
        # first two shapes earn an exemption.
        if _is_passphrase_shaped(tok):
            score += B_PASSPHRASE
        elif not (has_context and len(tok) >= WORD_LIKE_CONTEXT_MIN_LEN):
            score += P_WORD_LIKE
    if before.endswith("://") or before.endswith(":/"):
        score += P_URL
    elif before.endswith("/") or before.endswith("\\") or after.startswith("/") or after.startswith("\\"):
        score += P_PATH
    # Only a real dotted name, not a token that happens to end a sentence.
    dotted_before = before.endswith(".") and len(before) > 1 and before[-2].isalnum()
    dotted_after = len(after) > 1 and after[0] == "." and after[1].isalnum()
    if dotted_before or dotted_after:
        score += P_DOTTED

    if score < CONTEXT_BUMP_CEILING and has_context:
        score += W_CONTEXT
    # A heuristic never outranks a named pattern: when both cover the same value,
    # the pattern knows what the value IS and should win the overlap, taking its
    # whole span with it (the heuristic's span usually stops at a delimiter the
    # pattern happily includes).
    return min(clamp01(score), CONTEXT_BUMP_CEILING)


def load_known_secrets() -> list[tuple[str, str]]:
    """Collect exact secret values from the environment and local token stores."""
    found: list[tuple[str, str]] = []

    for name in SECRET_ENV_VARS:
        val = os.environ.get(name)
        if val and len(val) >= 8:
            found.append((name, val))

    for raw in SECRET_FILES:
        p = Path(os.path.expanduser(raw))
        if p.is_file():
            val = p.read_text(encoding="utf-8", errors="replace").strip()
            if val and len(val) >= 8:
                found.append((p.name, val))

    for raw, keys in SECRET_JSON_FILES.items():
        p = Path(os.path.expanduser(raw))
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except (ValueError, OSError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for k, v in node.items():
                    if k in keys and isinstance(v, str) and len(v) >= 8:
                        found.append((k, v))
                    else:
                        stack.append(v)
            elif isinstance(node, list):
                stack.extend(node)

    # Longest first, so a secret that contains another is struck whole.
    found.sort(key=lambda kv: len(kv[1]), reverse=True)
    return found


# ---------------------------------------------------------------------------
# Normalized shadow copies.
#
# Every detector above assumes the credential is contiguous in the document. Line
# wrapping, quoted-printable, JSON escaping, percent-encoding and interior
# separators all break that assumption -- and they break it in exactly the places
# credentials get pasted (MIME mail, curl commands, config dumps, HTTP logs). So we
# rebuild plausible un-mangled views of the text alongside index maps, detect in
# those, and destroy the ORIGINAL span that produced the hit.
#
# The maps are per-character: omap_s[i]/omap_e[i] give the original half-open span
# that produced shadow character i, so a shadow hit always maps back to a real
# region even when the shadow is shorter or longer than the source.
# ---------------------------------------------------------------------------

Shadow = tuple[str, list[int], list[int]]


def _rewrite(text: str, edits: list[tuple[int, int, str]]) -> Shadow:
    """Apply sorted, disjoint (start, end, replacement) edits, keeping an index map."""
    out: list[str] = []
    omap_s: list[int] = []
    omap_e: list[int] = []
    pos = 0
    for s, e, repl in edits:
        if s < pos:
            continue
        if s > pos:
            out.append(text[pos:s])
            omap_s.extend(range(pos, s))
            omap_e.extend(range(pos + 1, s + 1))
        if repl:
            out.append(repl)
            omap_s.extend([s] * len(repl))
            omap_e.extend([e] * len(repl))
        pos = e
    if pos < len(text):
        out.append(text[pos:])
        omap_s.extend(range(pos, len(text)))
        omap_e.extend(range(pos + 1, len(text) + 1))
    return "".join(out), omap_s, omap_e


def _protect_markers(text: str, edits: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Never normalize inside our own markers.

    `[REDACTED:ASSIGNED_SECRET]` contains a colon between two alphanumerics, which
    the separator shadow would happily delete -- and a marker that no longer
    matches MARKER_RX stops being recognised as our footprint, so the shadow pass
    reads the label text as real context. Leave markers exactly as they are.
    """
    spans = [(m.start(), m.end()) for m in MARKER_RX.finditer(text)]
    if not spans:
        return edits
    starts = [a for a, _ in spans]
    kept = []
    for e in edits:
        i = bisect.bisect_right(starts, max(e[1] - 1, e[0])) - 1
        if i >= 0 and e[0] < spans[i][1]:
            continue
        kept.append(e)
    return kept


B64_LINE = re.compile(r"\A[A-Za-z0-9+/=_\-]{4,}\Z")
QP_SOFT_BREAK = re.compile(r"=\r?\n[ \t]*")
JSON_ESCAPE = re.compile(r"\\[nrt]")
INTERIOR_SEP = re.compile(r"(?<=[A-Za-z0-9+/=_\-])[:,|\\%](?=[A-Za-z0-9+/=_\-])")
PERCENT_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})")


def _shadow_unwrapped(text: str) -> Shadow:
    """Undo the three ways a credential gets split across lines."""
    edits: list[tuple[int, int, str]] = []
    edits.extend((m.start(), m.end(), "") for m in QP_SOFT_BREAK.finditer(text))
    edits.extend((m.start(), m.end(), "") for m in JSON_ESCAPE.finditer(text))

    # Join runs of consecutive lines that are nothing but base64 alphabet.
    prev_b64 = False
    pos = 0
    for m in re.finditer(r"[^\n]*\n?", text):
        line = m.group(0)
        if not line:
            break
        body = line.rstrip("\r\n")
        indent = len(body) - len(body.lstrip())
        is_b64 = bool(B64_LINE.match(body.strip()))
        if is_b64 and prev_b64 and pos > 0:
            edits.append((pos - 1, m.start() + indent, ""))  # kill newline + indent
        prev_b64 = is_b64
        pos = m.end()

    edits.sort()
    merged: list[tuple[int, int, str]] = []
    for e in edits:
        if merged and e[0] < merged[-1][1]:
            continue
        merged.append(e)
    return _rewrite(text, _protect_markers(text, merged))


def _shadow_deseparated(text: str) -> Shadow:
    """Remove separators injected *inside* a token (`sk-ant-api:03-:Qv7...`)."""
    edits = [(m.start(), m.end(), "") for m in INTERIOR_SEP.finditer(text)]
    return _rewrite(text, _protect_markers(text, edits))


def _shadow_percent(text: str) -> Shadow:
    """Percent-decode, so an encoded blob is one token again."""
    edits = []
    for m in PERCENT_ESCAPE.finditer(text):
        try:
            edits.append((m.start(), m.end(), chr(int(m.group(1), 16))))
        except ValueError:  # pragma: no cover - regex guarantees hex
            continue
    return _rewrite(text, _protect_markers(text, edits))


def _decoded_hits(run: str) -> list[tuple[str, float]]:
    """Named-pattern hits inside a base64/hex run once decoded."""
    payloads: list[bytes] = []
    if len(run) >= 16:
        try:
            payloads.append(base64.b64decode(run + "=" * (-len(run) % 4), validate=False))
        except (binascii.Error, ValueError):
            pass
    if len(run) >= 24 and len(run) % 2 == 0 and HEX_ONLY.fullmatch(run):
        try:
            payloads.append(bytes.fromhex(run))
        except ValueError:
            pass

    hits: list[tuple[str, float]] = []
    for payload in payloads:
        try:
            plain = payload.decode("ascii")
        except UnicodeDecodeError:
            continue
        if not plain or sum(c.isprintable() for c in plain) / len(plain) < 0.9:
            continue
        for label, rx, group, validator in PATTERNS:
            base = PATTERN_CONFIDENCE[label]
            if base < DEFAULT_REDACT_THRESHOLD or label in NON_CREDENTIAL_LABELS:
                continue
            for m in rx.finditer(plain):
                value = m.group(group)
                if not value or (validator and not validator(value)):
                    continue
                hits.append((f"ENCODED_{label}", base))
    return hits


ENCODED_RUN = re.compile(r"[A-Za-z0-9+/=]{16,}")


# ---------------------------------------------------------------------------
# Detectors.
# ---------------------------------------------------------------------------

Detection = tuple[int, int, str, float]


def _pattern_spans(text: str, ctx: ContextIndex) -> list[Detection]:
    # A structural pattern reads the FRAME as evidence, so a frame that overlaps
    # one of our own markers is evidence we manufactured: "[REDACTED:X]" ends in
    # the word "secret" and would make the next token look like an assigned value.
    # Same rule as ContextIndex's keyword masking, applied to the whole match.
    markers = [(m.start(), m.end()) for m in MARKER_RX.finditer(text)]
    marker_starts = [s for s, _ in markers]

    def _touches_marker(s: int, e: int) -> bool:
        i = bisect.bisect_right(marker_starts, e - 1) - 1
        return i >= 0 and s < markers[i][1]

    out: list[Detection] = []
    for label, rx, group, validator in PATTERNS:
        base = PATTERN_CONFIDENCE[label]
        for m in rx.finditer(text):
            value = m.group(group)
            if not value or (validator and not validator(value)):
                continue
            if markers and _touches_marker(m.start(), m.end()):
                continue
            start, end = m.span(group)
            score = base
            if score < CONTEXT_BUMP_CEILING and ctx.keyword_before(start):
                score = clamp01(score + W_CONTEXT)
            out.append((start, end, label, score))
    return out


def _hex_spans(text: str, ctx: ContextIndex) -> list[Detection]:
    out: list[Detection] = []
    for m in LONG_HEX.finditer(text):
        score = LONG_HEX_SCORE
        if ctx.keyword_before(m.start()):
            score = clamp01(score + W_CONTEXT)
        out.append((m.start(), m.end(), "LONG_HEX", score))
    return out


def _candidate_spans(text: str, ctx: ContextIndex) -> list[Detection]:
    """Entropy-scored spans, at three widths.

    Unanchored: opaque runs of CANDIDATE_MIN_LEN+.
    Anchored:   shorter runs, but only where the line already said "password".
    Field:      the trailing value on a keyword line, punctuation included, so a
                symbol-rich human password is one span instead of four fragments.
    """
    out: list[Detection] = []
    for m in CANDIDATE.finditer(text):
        tok = m.group(0)
        if len(tok) < ENTROPY_MIN_LEN and not ctx.keyword_before(m.start()):
            if char_classes(tok) < SHORT_SPAN_MIN_CLASSES or not HAS_DIGIT.search(tok):
                continue
        out.append((m.start(), m.end(), "HIGH_ENTROPY", score_candidate(text, m.start(), m.end(), ctx)))

    for m in CANDIDATE_ANCHORED.finditer(text):
        if len(m.group(0)) >= CANDIDATE_MIN_LEN:
            continue  # already covered above
        if not ctx.keyword_before(m.start()):
            continue
        out.append((m.start(), m.end(), "HIGH_ENTROPY", score_candidate(text, m.start(), m.end(), ctx)))

    for m in SYMBOL_DENSE.finditer(text):
        tok = m.group(0)
        if len(SYMBOL_CHARS.findall(tok)) < 2 or char_classes(tok) < 2:
            continue
        if not _credential_value(tok):
            continue
        score = SYMBOL_DENSE_SCORE
        if ctx.keyword_before(m.start()):
            score = clamp01(score + W_CONTEXT)
        out.append((m.start(), m.end(), "SYMBOL_DENSE", score))

    line_start = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        m = TRAILING_FIELD.search(body)
        if m and ctx.keyword_before(line_start + m.start(1)):
            tok = m.group(1).strip(FIELD_STRIP)
            if len(tok) >= CANDIDATE_ANCHORED_MIN_LEN and _credential_value(tok):
                off = body.index(tok, m.start(1)) if tok in body[m.start(1):] else m.start(1)
                s = line_start + off
                e = s + len(tok)
                if "://" not in tok and not tok.startswith(("/", "\\", "~", "./", "../")):
                    out.append((s, e, "KEYWORD_VALUE", score_candidate(text, s, e, ctx)))
        line_start += len(line)
    return out


def _structure_spans(text: str) -> list[Detection]:
    """Mnemonics and recovery-code blocks: multi-token shapes."""
    out: list[Detection] = []

    for m in MNEMONIC_RUN.finditer(text):
        words = m.group(0).split()
        if len(words) not in MNEMONIC_LENGTHS:
            continue
        if sum(w in STOPWORDS for w in words) > MNEMONIC_MAX_STOPWORDS:
            continue
        if len(set(words)) < len(words) - 2:
            continue
        out.append((m.start(), m.end(), "MNEMONIC", PATTERN_CONFIDENCE["MNEMONIC"]))

    block: list[tuple[int, int]] = []
    pos = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        stripped = body.strip()
        if stripped and RECOVERY_LINE.match(stripped):
            off = body.index(stripped)
            block.append((pos + off, pos + off + len(stripped)))
        else:
            if len(block) >= RECOVERY_MIN_LINES:
                out.extend((s, e, "RECOVERY_CODE", PATTERN_CONFIDENCE["RECOVERY_CODE"]) for s, e in block)
            block = []
        pos += len(line)
    if len(block) >= RECOVERY_MIN_LINES:
        out.extend((s, e, "RECOVERY_CODE", PATTERN_CONFIDENCE["RECOVERY_CODE"]) for s, e in block)
    return out


def _shadow_spans(text: str) -> list[Detection]:
    """Run the detectors over normalized views and map the hits back."""
    out: list[Detection] = []
    for build in (_shadow_unwrapped, _shadow_deseparated, _shadow_percent):
        norm, omap_s, omap_e = build(text)
        if norm == text:
            continue
        ctx = ContextIndex(norm)
        found = _pattern_spans(norm, ctx) + _hex_spans(norm, ctx) + _candidate_spans(norm, ctx)
        for m in ENCODED_RUN.finditer(norm):
            for label, score in _decoded_hits(m.group(0)):
                found.append((m.start(), m.end(), label, score))
        for s, e, label, score in found:
            if s >= len(omap_s) or e - 1 >= len(omap_e) or e <= s:
                continue
            out.append((omap_s[s], omap_e[e - 1], label, score))

    for m in ENCODED_RUN.finditer(text):
        for label, score in _decoded_hits(m.group(0)):
            out.append((m.start(), m.end(), label, score))
    return out


def _drop_marker_hits(text: str, dets: list[Detection]) -> list[Detection]:
    """Never score our own footprints.

    A detection that begins inside `[REDACTED:...]` or `<~garbled:...~>` is an
    artefact of the previous pass -- `password: [REDACTED:X]` otherwise reads as an
    assignment whose value is the marker. Dropping them is what keeps verify()
    from failing on a correctly redacted document.
    """
    markers = [(m.start(), m.end()) for m in MARKER_RX.finditer(text)]
    if not markers:
        return dets
    starts = [s for s, _ in markers]
    kept = []
    for det in dets:
        i = bisect.bisect_right(starts, det[0]) - 1
        if i >= 0 and det[0] < markers[i][1]:
            continue
        kept.append(det)
    return kept


def detect(text: str, known: list[tuple[str, str]]) -> list[Detection]:
    """Every candidate span in `text`, each with a confidence score.

    Overlaps are resolved here: the highest-scoring span wins, then the longest,
    then the leftmost. Returned spans are disjoint and sorted by position.
    """
    ctx = ContextIndex(text)
    raw: list[Detection] = []

    for label, value in known:
        i = text.find(value)
        while i >= 0:
            raw.append((i, i + len(value), label, KNOWN_VALUE_SCORE))
            i = text.find(value, i + len(value))

    raw += _pattern_spans(text, ctx)
    raw += _hex_spans(text, ctx)
    raw += _candidate_spans(text, ctx)
    raw += _structure_spans(text)
    raw += _shadow_spans(text)
    raw = _drop_marker_hits(text, raw)

    chosen: list[Detection] = []
    starts: list[int] = []
    for det in sorted(raw, key=lambda d: (-d[3], -(d[1] - d[0]), d[0])):
        s, e = det[0], det[1]
        i = bisect.bisect_left(starts, s)
        if i < len(chosen) and chosen[i][0] < e:
            continue
        if i > 0 and s < chosen[i - 1][1]:
            continue
        chosen.insert(i, det)
        starts.insert(i, s)
    return chosen


def redact(
    text: str,
    known: list[tuple[str, str]],
    counts: dict[str, int],
    garbles: dict[str, int],
    redact_threshold: float = DEFAULT_REDACT_THRESHOLD,
    garble_threshold: float = DEFAULT_GARBLE_THRESHOLD,
) -> str:
    """Apply the graduated response: replace, garble, or leave alone."""
    out: list[str] = []
    last = 0
    for start, end, label, score in detect(text, known):
        if score < garble_threshold:
            continue
        out.append(text[last:start])
        if score >= redact_threshold:
            out.append(REDACT_MARK.format(label=label))
            counts[label] = counts.get(label, 0) + 1
        else:
            out.append(garble(text[start:end]))
            garbles[label] = garbles.get(label, 0) + 1
        last = end
    out.append(text[last:])
    return "".join(out)


def verify(text: str, redact_threshold: float = DEFAULT_REDACT_THRESHOLD) -> list[str]:
    """Re-scan redacted output. Anything returned here means DO NOT PUBLISH.

    Fail-closed on the same terms the redactor was told to work to: if a span
    still scores at or above the redact threshold, the redactor did not do its
    job. Garbled spans are expected in the output and are not scored -- they no
    longer contain the value. Known values are not re-scanned from the environment
    here; they are covered by the score-1.0 detections in the pass above.
    """
    leaks = []
    for start, end, label, score in detect(text, []):
        if score < redact_threshold:
            continue
        if label in NON_CREDENTIAL_LABELS:
            continue  # redacted above; residuals are not credentials
        tok = text[start:end]
        leaks.append(f"{label}: ...{tok[:6]}... ({len(tok)} chars, score {score:.2f})")
    return leaks


def uuid_context_survivors(text: str) -> int:
    """UUID-shaped values that kept credential context and survived anyway.

    The UUID escape hatch is keyed on shape alone, so it is trivially reachable by
    any 8-4-4-4-12 hex string. When one survives on a line that talks about keys
    or tokens, that is exactly the case the exemption was not meant to cover, and
    a human should look at it. Counted, not failed on: session ids legitimately
    appear next to the word "key" all the time.
    """
    ctx = ContextIndex(text)
    count = 0
    for m in re.finditer(UUID_CORE, text):
        if MARKER_RX.match(text, m.start()):
            continue
        if ctx.keyword_before(m.start()):
            count += 1
    return count


def message_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                parts.append(block.get("text", ""))
            elif kind == "tool_use":
                parts.append(f"[tool: {block.get('name', '?')}]")
            elif kind == "tool_result":
                inner = block.get("content")
                if isinstance(inner, str):
                    parts.append(inner)
                elif isinstance(inner, list):
                    for x in inner:
                        if isinstance(x, dict) and x.get("type") == "text":
                            parts.append(x.get("text", ""))
    return "\n".join(p for p in parts if p)


def render(
    path: Path,
    known: list[tuple[str, str]],
    counts: dict[str, int],
    garbles: dict[str, int],
    redact_threshold: float = DEFAULT_REDACT_THRESHOLD,
    garble_threshold: float = DEFAULT_GARBLE_THRESHOLD,
) -> str:
    out = [f"# Session transcript (redacted)\n", f"_source: `{path.name}`_\n"]
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            msg = obj.get("message") or {}
            role = msg.get("role") or obj.get("type") or "?"
            body = message_text(msg).strip()
            if not body:
                continue
            clean = redact(body, known, counts, garbles, redact_threshold, garble_threshold)
            out.append(f"\n### {role}\n\n{clean}\n")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Redact a Claude Code session transcript.")
    ap.add_argument("session", type=Path, help="path to the session .jsonl")
    ap.add_argument("-o", "--out", type=Path, help="write redacted markdown here")
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    ap.add_argument(
        "--redact-threshold",
        type=float,
        default=DEFAULT_REDACT_THRESHOLD,
        help="score at or above which a value is replaced outright (default %(default)s)",
    )
    ap.add_argument(
        "--garble-threshold",
        type=float,
        default=DEFAULT_GARBLE_THRESHOLD,
        help="score at or above which a value is garbled rather than kept (default %(default)s)",
    )
    args = ap.parse_args()

    if not args.session.is_file():
        print(f"no such session file: {args.session}", file=sys.stderr)
        return 2
    if not 0.0 <= args.garble_threshold <= args.redact_threshold <= 1.0:
        print("thresholds must satisfy 0 <= garble <= redact <= 1", file=sys.stderr)
        return 2

    known = load_known_secrets()
    counts: dict[str, int] = {}
    garbles: dict[str, int] = {}
    text = render(
        args.session, known, counts, garbles, args.redact_threshold, args.garble_threshold
    )

    print(f"known secret values loaded : {len(known)}")
    print(f"thresholds                 : redact >= {args.redact_threshold}, "
          f"garble >= {args.garble_threshold}")
    print("redactions:")
    for label in sorted(counts):
        print(f"  {label:<16} {counts[label]}")
    if not counts:
        print("  (none)")
    print(f"garbled: {sum(garbles.values())}")
    for label in sorted(garbles):
        print(f"  {label:<16} {garbles[label]}")

    exempt = uuid_context_survivors(text)
    if exempt:
        print(
            f"\nWARNING: {exempt} UUID-shaped value(s) with credential context survived "
            "the identifier exemption.\n"
            "         Shape alone does not prove a UUID is an id -- eyeball these before publishing."
        )

    leaks = verify(text, args.redact_threshold)
    if leaks:
        print(f"\nFAILED verification -- {len(leaks)} possible secret(s) survived:", file=sys.stderr)
        for leak in leaks[:20]:
            print(f"  {leak}", file=sys.stderr)
        if len(leaks) > 20:
            print(f"  ... and {len(leaks) - 20} more", file=sys.stderr)
        print("\nDO NOT PUBLISH this transcript.", file=sys.stderr)
        return 1

    print("\nverification passed: nothing at or above the redact threshold remains")
    if args.out and not args.check:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(text)} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
