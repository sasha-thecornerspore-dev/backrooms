#!/usr/bin/env python3
"""Build the curated session digest that gets published to the admin portal.

The redaction path (`session-redact.py`) ships the *whole* transcript with the
secrets struck out. That is the right tool for an audit trail, but it is the
wrong tool for a portal: a transcript that is 99% preserved is still 99% of the
conversation, and the redactor can only remove what it recognises. Anything it
has never seen -- a vendor token in a novel format, a customer name, a snippet
of someone else's source -- rides straight through.

This tool inverts the default. Nothing is published unless it was explicitly
derived. We read the session and emit *facts about* it: which files were
touched, what shape the commands had, which commits landed. Raw conversation
text never reaches the page, so a redactor miss cannot leak it -- there is
nothing there to miss. That is what "safe by construction" buys: the failure
mode of an unknown secret format is a less useful summary, not a disclosure.

Two rules hold the guarantee up:

  1. Derived-only. Command *text* is never emitted -- only its shape ("git
     commit", "npm test"), rebuilt from a whitelist of identifier-shaped tokens.
     `curl https://api/?token=...` becomes "curl". Free prose is admitted only
     from the assistant's own headline/conclusion lines, length-capped.
  2. Redact anyway. Every derived string is passed through the redactor at
     extraction time, and the assembled document is passed through again before
     it is written. Belt and braces: rule 1 is the guarantee, rule 2 is the net
     under it. The redactor's verification pass then gates the write, so a
     non-zero exit means DO NOT PUBLISH.

Usage:
    python session-summary.py SESSION.jsonl -o out.md
    python session-summary.py SESSION.jsonl --check     # verify only, no output
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import re
import sys
from collections import Counter
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from types import ModuleType

# Tool names whose calls prove a file was written.
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")

# Tool names whose calls prove a command was run.
SHELL_TOOLS = ("Bash", "PowerShell", "BashOutput")

# A shell token may be echoed only if it is a bare identifier. Anything with a
# quote, URL, '=', or '$' in it is a value, and values are where secrets live.
SAFE_PROGRAM = re.compile(r"\A[A-Za-z][A-Za-z0-9._+-]{0,39}\Z")
SAFE_SUBCOMMAND = re.compile(r"\A[A-Za-z][A-Za-z0-9:_-]{0,24}\Z")

# Splits a command line into independently-shaped segments.
SEGMENT_SPLIT = re.compile(r"&&|\|\||[;|]|\n")

# Leading `FOO=bar` env prefixes are values, never the program.
ENV_PREFIX = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*=")

# `git commit` prints this on success; it is the one reliable commit signal in
# tool output. `git log` output is not parsed -- too easy to mistake unrelated
# hex for a sha, and 40-char shas are redacted as LONG_HEX anyway.
COMMIT_LINE = re.compile(r"^\[([\w./-]{1,40})\s+([0-9a-f]{7,12})\]\s+(.+)$", re.M)

# Paths that read as deliverables rather than working files.
ARTIFACT_DIRS = ("docs/", "doc/", "plans/", "specs/", "reports/", "rfc/")
ARTIFACT_WORDS = ("plan", "spec", "report", "design", "proposal", "readme", "changelog")

# Assistant lines admissible as "decisions": markdown headings and fully-bolded
# standalone lines. These are the model summarising itself, not quoting others.
HEADLINE = re.compile(r"\A#{1,6}\s+(.{3,})\Z")
BOLD_LINE = re.compile(r"\A\*\*(.{3,}?)\*\*:?\Z")

MAX_DECISIONS = 25
MAX_DECISION_CHARS = 200
MAX_SUBJECT_CHARS = 120
MAX_SEGMENTS_PER_COMMAND = 4

# How much of an out-of-tree path is worth showing. Enough to identify the file,
# never enough to reconstruct the operator's home directory.
OUT_OF_TREE_SEGMENTS = 2

# A transcript file is not always one session. Resuming, forking and `--continue`
# all append to a file named for only one of the sessions inside it, and a session
# that moved between projects carries more than one cwd. Taking the FIRST value
# seen therefore mislabels the digest -- and picking the wrong cwd is not merely
# cosmetic, because display_path() measures every file path against it and
# truncates whatever does not match. The dominant value is the honest summary of a
# mixed file; the alternatives are counted and disclosed rather than hidden.
MIXED_METADATA_NOTE = "_This file contains more than one {kind}; the dominant one is shown._"


def load_redactor(here: Path) -> ModuleType:
    """Import the sibling `session-redact.py` as a module.

    The filename is hyphenated, so it is not importable by name. It is loaded
    rather than reimplemented on purpose: there must be exactly one redaction
    implementation, or the two drift and the weaker one becomes the publish
    path.
    """
    target = here.parent / "session-redact.py"
    if not target.is_file():
        raise SystemExit(f"redaction module not found next to this tool: {target}")
    spec = importlib.util.spec_from_file_location("session_redact", target)
    if spec is None or spec.loader is None:
        raise SystemExit(f"could not load redaction module: {target}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for attr in ("load_known_secrets", "redact", "verify"):
        if not hasattr(module, attr):
            raise SystemExit(f"redaction module is missing {attr}(); refusing to publish")
    return module


class Redactor:
    """Binds the redactor's state so callers cannot forget to pass it.

    The signature is discovered rather than assumed. `session-redact.py` is
    under active development -- its graduated-response form takes a `garbles`
    tally that the earlier form did not -- and this tool must not become the
    reason a security fix cannot land next door.
    """

    def __init__(self, module: ModuleType) -> None:
        self._module = module
        self.known = module.load_known_secrets()
        self.counts: dict[str, int] = {}
        self.garbles: dict[str, int] = {}
        params = inspect.signature(module.redact).parameters
        self._wants_garbles = "garbles" in params

    def __call__(self, text: str) -> str:
        if self._wants_garbles:
            return self._module.redact(text, self.known, self.counts, self.garbles)
        return self._module.redact(text, self.known, self.counts)

    def verify(self, text: str) -> list[str]:
        return self._module.verify(text)


def parse_ts(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def command_shapes(command: str) -> list[str]:
    """Reduce a command line to program/subcommand pairs, discarding all values.

    This is the tool's core safety property, so it is deliberately pessimistic:
    a token is echoed only if it matches an identifier whitelist. A segment
    whose program is unrecognisable is dropped entirely rather than guessed at.
    """
    shapes: list[str] = []
    for segment in SEGMENT_SPLIT.split(command)[:MAX_SEGMENTS_PER_COMMAND]:
        tokens = segment.strip().split()
        while tokens and ENV_PREFIX.match(tokens[0]):
            tokens.pop(0)
        if not tokens:
            continue
        program = re.split(r"[\\/]", tokens[0].strip("'\"`"))[-1]
        if program.lower().endswith(".exe"):
            program = program[:-4]
        if not SAFE_PROGRAM.match(program):
            continue
        shape = program
        for token in tokens[1:]:
            if token.startswith("-"):
                break
            if SAFE_SUBCOMMAND.match(token):
                shape = f"{program} {token}"
            break
        shapes.append(shape)
    return shapes


def is_artifact(path: str) -> bool:
    lowered = path.replace("\\", "/").lower()
    if any(part in lowered for part in ARTIFACT_DIRS):
        return True
    stem = lowered.rsplit("/", 1)[-1]
    return lowered.endswith(".md") and any(word in stem for word in ARTIFACT_WORDS)


def display_path(path: str, roots: Iterable[str]) -> str:
    """Render a path relative to a project root, and never absolutely.

    Absolute paths do not belong on a portal: they carry the operator's home
    directory, username and drive layout, none of which the redactor treats as
    a secret. Anything under a project root becomes a relative path; everything
    else is truncated to its last few segments.

    ALL of the session's working directories are candidate roots, not just the
    dominant one. A resumed session that spans two checkouts writes most of its
    files outside whichever cwd happens to win the tally, and measuring those
    against the wrong root truncated them to an unhelpful `.../a/b`. The longest
    matching root wins, so a nested checkout beats its parent. Safety does not
    depend on which root matches: an unmatched path is still truncated, and
    neither branch can emit an absolute path.

    This also keeps paths *readable*. The redactor's entropy net counts '/' as a
    token character, so a long absolute path matches as one high-entropy blob
    and is struck whole -- a correct-but-useless outcome that this avoids by not
    handing it a long path in the first place.
    """
    norm_path = path.replace("\\", "/")
    best: str | None = None
    for root in roots:
        norm_root = root.replace("\\", "/").rstrip("/")
        if not norm_root:
            continue
        if norm_path.lower().startswith(norm_root.lower() + "/"):
            candidate = norm_path[len(norm_root) + 1 :]
            if best is None or len(candidate) < len(best):
                best = candidate
    if best:
        return best
    tail = [seg for seg in norm_path.split("/") if seg][-OUT_OF_TREE_SEGMENTS:]
    return ".../" + "/".join(tail) if tail else "(unknown path)"


def decision_lines(text: str) -> list[str]:
    """Pull the assistant's own headline/conclusion lines out of a message."""
    found: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or len(line) > 400:
            continue
        match = HEADLINE.match(line) or BOLD_LINE.match(line)
        if not match:
            continue
        claim = match.group(1).strip().rstrip(":")
        if len(claim) < 8:
            continue
        found.append(claim[:MAX_DECISION_CHARS])
    return found


def dominant(counter: Counter[str]) -> str:
    """The most frequent value, ties broken by name so runs are reproducible."""
    if not counter:
        return ""
    best = max(counter.values())
    return sorted(k for k, v in counter.items() if v == best)[0]


class Digest:
    """Accumulates derived facts. Holds no raw conversation text.

    Identity fields are tallied rather than latched: see MIXED_METADATA_NOTE for
    why the first value in the file is the wrong one to publish.
    """

    def __init__(self) -> None:
        self.session_ids: Counter[str] = Counter()
        self.cwds: Counter[str] = Counter()
        self.branches: Counter[str] = Counter()
        self.first_ts: datetime | None = None
        self.last_ts: datetime | None = None
        self.roles: Counter[str] = Counter()
        self.files: Counter[str] = Counter()
        self.shapes: Counter[str] = Counter()
        self.commits: list[tuple[str, str]] = []
        self.decisions: list[str] = []
        self.tool_names: dict[str, str] = {}
        self.lines_read = 0
        self.lines_bad = 0

    @property
    def session_id(self) -> str:
        return dominant(self.session_ids)

    @property
    def cwd(self) -> str:
        return dominant(self.cwds)

    @property
    def branch(self) -> str:
        return dominant(self.branches)


def scan(path: Path) -> Digest:
    digest = Digest()
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                digest.lines_bad += 1
                continue
            digest.lines_read += 1
            absorb(digest, obj)
    return digest


def absorb(digest: Digest, obj: dict) -> None:
    if isinstance(obj.get("sessionId"), str) and obj["sessionId"]:
        digest.session_ids[obj["sessionId"]] += 1
    if isinstance(obj.get("cwd"), str) and obj["cwd"]:
        digest.cwds[obj["cwd"]] += 1
    if isinstance(obj.get("gitBranch"), str) and obj["gitBranch"]:
        digest.branches[obj["gitBranch"]] += 1

    ts = parse_ts(obj.get("timestamp"))
    if ts:
        if digest.first_ts is None or ts < digest.first_ts:
            digest.first_ts = ts
        if digest.last_ts is None or ts > digest.last_ts:
            digest.last_ts = ts

    message = obj.get("message")
    if not isinstance(message, dict):
        return
    role = message.get("role") or obj.get("type") or "?"
    digest.roles[str(role)] += 1

    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "tool_use":
            absorb_tool_use(digest, block)
        elif kind == "tool_result":
            absorb_tool_result(digest, block)
        elif kind == "text" and role == "assistant":
            digest.decisions.extend(decision_lines(block.get("text") or ""))


def absorb_tool_use(digest: Digest, block: dict) -> None:
    name = str(block.get("name") or "")
    call_id = block.get("id")
    if isinstance(call_id, str):
        digest.tool_names[call_id] = name
    params = block.get("input")
    if not isinstance(params, dict):
        return
    if name in WRITE_TOOLS:
        target = params.get("file_path") or params.get("notebook_path") or params.get("path")
        if isinstance(target, str) and target:
            digest.files[target] += 1
    if name in SHELL_TOOLS:
        command = params.get("command")
        if isinstance(command, str) and command.strip():
            for shape in command_shapes(command):
                digest.shapes[shape] += 1


def absorb_tool_result(digest: Digest, block: dict) -> None:
    if digest.tool_names.get(str(block.get("tool_use_id"))) not in SHELL_TOOLS:
        return
    inner = block.get("content")
    chunks: list[str] = []
    if isinstance(inner, str):
        chunks.append(inner)
    elif isinstance(inner, list):
        for item in inner:
            if isinstance(item, dict) and item.get("type") == "text":
                chunks.append(item.get("text") or "")
    for chunk in chunks:
        for match in COMMIT_LINE.finditer(chunk):
            subject = match.group(3).strip()[:MAX_SUBJECT_CHARS]
            digest.commits.append((match.group(2), subject))


def render(digest: Digest, source: Path, safe) -> tuple[str, dict[str, int]]:
    """Assemble the markdown. Every interpolated string goes through `safe`."""
    out: list[str] = ["# Session summary", ""]
    out.append("_Curated digest. Derived facts only -- no conversation text._")
    out.append("")

    duration = "unknown"
    if digest.first_ts and digest.last_ts:
        seconds = int((digest.last_ts - digest.first_ts).total_seconds())
        duration = f"{seconds // 3600}h {(seconds % 3600) // 60}m"
    started = digest.first_ts.isoformat() if digest.first_ts else "unknown"
    ended = digest.last_ts.isoformat() if digest.last_ts else "unknown"
    total = sum(digest.roles.values())

    out.append("## Session metadata")
    out.append("")
    out.append(f"- Session id: `{safe(digest.session_id or 'unknown')}`")
    if len(digest.session_ids) > 1:
        out.append(f"- Sessions in this file: {len(digest.session_ids)} (resumed or forked)")
    out.append(f"- Source file: `{safe(source.name)}`")
    out.append(f"- Started: {safe(started)}")
    out.append(f"- Ended: {safe(ended)}")
    out.append(f"- Duration: {safe(duration)}")
    out.append(f"- Messages: {total}")
    for role in sorted(digest.roles):
        out.append(f"  - {safe(role)}: {digest.roles[role]}")
    # Project *name*, not the working directory: the full cwd is an absolute
    # path and absolute paths are never published (see display_path).
    project = digest.cwd.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    out.append(f"- Project: `{safe(project or 'unknown')}`")
    if len(digest.cwds) > 1:
        others = sorted(
            {c.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] for c in digest.cwds}
            - {project}
        )
        out.append(f"- Other projects touched: {', '.join(f'`{safe(o)}`' for o in others)}")
    out.append(f"- Git branch: `{safe(digest.branch or 'unknown')}`")
    if len(digest.session_ids) > 1 or len(digest.cwds) > 1:
        out.append("")
        kind = "session" if len(digest.session_ids) > 1 else "working directory"
        out.append(MIXED_METADATA_NOTE.format(kind=kind))
    out.append("")

    files = sorted(digest.files.items(), key=lambda kv: (-kv[1], kv[0]))
    out.append("## Files created or modified")
    out.append("")
    if files:
        for path, hits in files:
            rel = display_path(path, digest.cwds)
            out.append(f"- `{safe(rel)}` ({hits} write{'s' if hits != 1 else ''})")
    else:
        out.append("_None._")
    out.append("")

    shapes = sorted(digest.shapes.items(), key=lambda kv: (-kv[1], kv[0]))
    out.append("## Commands run")
    out.append("")
    out.append("_Command shapes only; arguments are never published._")
    out.append("")
    if shapes:
        for shape, hits in shapes:
            out.append(f"- `{safe(shape)}` x{hits}")
    else:
        out.append("_None._")
    out.append("")

    out.append("## Git commits")
    out.append("")
    if digest.commits:
        seen: set[str] = set()
        for sha, subject in digest.commits:
            if sha in seen:
                continue
            seen.add(sha)
            out.append(f"- `{safe(sha)}` {safe(subject)}")
    else:
        out.append("_None discoverable from tool output._")
    out.append("")

    artifacts = [p for p in digest.files if is_artifact(p)]
    out.append("## Artifacts produced")
    out.append("")
    if artifacts:
        for path in sorted(artifacts):
            out.append(f"- `{safe(display_path(path, digest.cwds))}`")
    else:
        out.append("_None._")
    out.append("")

    decisions: list[str] = []
    seen_claims: set[str] = set()
    for claim in digest.decisions:
        key = claim.lower()
        if key in seen_claims:
            continue
        seen_claims.add(key)
        decisions.append(claim)
    decisions = decisions[:MAX_DECISIONS]

    out.append("## Decisions & outcomes")
    out.append("")
    if decisions:
        for claim in decisions:
            out.append(f"- {safe(claim)}")
    else:
        out.append("_None extracted._")
    out.append("")

    sections = {
        "files": len(files),
        "command_shapes": len(shapes),
        "commits": len({sha for sha, _ in digest.commits}),
        "artifacts": len(artifacts),
        "decisions": len(decisions),
    }
    return "\n".join(out) + "\n", sections


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build a curated, publish-safe summary of a Claude Code session."
    )
    ap.add_argument("session", type=Path, help="path to the session .jsonl")
    ap.add_argument("-o", "--out", type=Path, help="write the markdown digest here")
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    args = ap.parse_args()

    if not args.session.is_file():
        print(f"no such session file: {args.session}", file=sys.stderr)
        return 2

    redactor = Redactor(load_redactor(Path(__file__).resolve()))
    digest = scan(args.session)
    text, sections = render(digest, args.session, redactor)

    # Second pass over the assembled document. Rule 1 should already have made
    # this a no-op; if it fires, something derived was richer than expected.
    text = redactor(text)

    print(f"lines parsed               : {digest.lines_read}")
    if digest.lines_bad:
        print(f"lines skipped (bad json)   : {digest.lines_bad}")
    print(f"known secret values loaded : {len(redactor.known)}")
    print("sections:")
    for name in sorted(sections):
        print(f"  {name:<16} {sections[name]}")
    print("redactions:")
    for label in sorted(redactor.counts):
        print(f"  {label:<16} {redactor.counts[label]}")
    if not redactor.counts:
        print("  (none)")
    if redactor.garbles:
        print("garbled:")
        for label in sorted(redactor.garbles):
            print(f"  {label:<16} {redactor.garbles[label]}")

    leaks = redactor.verify(text)
    if leaks:
        print(f"\nFAILED verification -- {len(leaks)} possible secret(s) survived:", file=sys.stderr)
        for leak in leaks[:20]:
            print(f"  {leak}", file=sys.stderr)
        if len(leaks) > 20:
            print(f"  ... and {len(leaks) - 20} more", file=sys.stderr)
        print("\nDO NOT PUBLISH this summary.", file=sys.stderr)
        return 1

    print("\nverification passed: no secret-shaped strings remain")
    if args.out and not args.check:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(text)} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
