#!/usr/bin/env python3
"""Regression tests for `session-redact.py`.

Run it directly; it needs no test framework and no network:

    python tools/test-session-redact.py

SAFETY RULE THIS FILE OBEYS, AND SO MUST ANY TEST ADDED TO IT
-------------------------------------------------------------
No real secret is read, printed or written here. Every fixture value below is
INVENTED for the test, every fixture file is created in a temporary directory and
deleted afterwards, and no assertion prints a candidate value -- only a test name
and PASS/FAIL. A test suite for a redactor is the last place a real value should
ever be pasted, because the suite is committed and the transcript of the run is
not.

WHAT IT COVERS
--------------
  * the gap that motivated the extra-secrets layer, reproduced: a short bare
    password, an unpunctuated phone number and an unlabelled date of birth all
    SURVIVE with the mechanism unconfigured, so the later assertions prove the
    mechanism is what fixed them rather than some coincidence of the corpus;
  * the same values struck once an operator file is supplied, via both the
    --extra-secrets flag and BACKROOMS_EXTRA_SECRET_FILES;
  * the length floor, the longest-first ordering, missing/unreadable paths,
    os.pathsep lists, and the zero-argument call session-summary.py depends on;
  * the PHONE and DOB rules, positive forms and the false-positive classes they
    are most likely to eat (version strings, dotted quads, unix timestamps, file
    modes, numeric table rows, ISO timestamps, ordinary prose);
  * a clean corpus of prose, code, UUIDs, paths and version strings that must
    come through untouched;
  * the pre-existing detectors, so this pass cannot have regressed one.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "session-redact.py"
SUMMARY_PATH = HERE / "session-summary.py"

_spec = importlib.util.spec_from_file_location("session_redact", MODULE_PATH)
if _spec is None or _spec.loader is None:  # pragma: no cover - packaging accident
    raise SystemExit(f"cannot load {MODULE_PATH}")
sr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sr)

RESULTS: list[tuple[str, bool]] = []


def check(name: str, ok: bool) -> None:
    RESULTS.append((name, bool(ok)))


def redact(text: str, known) -> str:
    return sr.redact(text, list(known), {}, {})


def labels(text: str, known=()) -> set[str]:
    return {d[2] for d in sr.detect(text, list(known))}


# ---------------------------------------------------------------------------
# INVENTED fixture values. Not real credentials, not derived from any.
# ---------------------------------------------------------------------------

FX_PASSWORD = "Qz7#mR!4vKp"       # 11 chars: below every length floor
FX_PHONE_BARE = "4155550142"       # unpunctuated: PHONE deliberately cannot see it
FX_DOB = "1985-03-14"              # unlabelled: DOB deliberately cannot see it
FX_LONG = "Qz7#mR!4vKp-Extended"   # contains FX_PASSWORD; longest-first check

EXTRA_FILE_BODY = "\n".join(
    [
        "# invented fixtures for a test -- not real credentials",
        "// both comment styles are tolerated",
        FX_PASSWORD,
        FX_LONG,
        FX_PHONE_BARE,
        f"birthday: {FX_DOB}",   # key: value -- the value alone is a secret too
        "ab",                    # below EXTRA_SECRET_MIN_LEN: refused and counted
        "",
    ]
)

# Deliberately keyword-free prose: nothing on these lines says token, key,
# password or secret, so only exact match can reach the values.
BARE_PROSE = (
    "The card taped inside the cabinet door said {pw} in ballpoint.\n"
    "A slip of paper with {ph} was folded under the lamp.\n"
    "The engraving on the underside reads {dob} and a workshop mark.\n"
).format(pw=FX_PASSWORD, ph=FX_PHONE_BARE, dob=FX_DOB)


def run_extra_secret_tests() -> None:
    fd, raw = tempfile.mkstemp(suffix=".txt", prefix="redact-fixture-")
    tmp = Path(raw)
    os.close(fd)
    saved_env = os.environ.get(sr.EXTRA_SECRET_FILES_ENV)
    try:
        tmp.write_text(EXTRA_FILE_BODY, encoding="utf-8")

        # --- 1. Unconfigured: the gap is real, and it reproduces. ------------
        os.environ.pop(sr.EXTRA_SECRET_FILES_ENV, None)
        baseline_out = redact(BARE_PROSE, sr.load_known_secrets())
        check("gap reproduces: bare password survives unconfigured",
              FX_PASSWORD in baseline_out)
        check("gap reproduces: unpunctuated phone survives unconfigured",
              FX_PHONE_BARE in baseline_out)
        check("gap reproduces: bare date of birth survives unconfigured",
              FX_DOB in baseline_out)

        # --- 2. Configured via the --extra-secrets path. ---------------------
        stats: dict[str, int] = {}
        known = sr.load_known_secrets([str(tmp)], stats)
        out = redact(BARE_PROSE, known)
        check("cli flag: bare password struck", FX_PASSWORD not in out)
        check("cli flag: unpunctuated phone struck", FX_PHONE_BARE not in out)
        check("cli flag: bare date of birth struck", FX_DOB not in out)
        check("cli flag: EXTRA_SECRET marker present",
              "[REDACTED:EXTRA_SECRET]" in out)
        check("cli flag: surrounding prose preserved",
              "ballpoint" in out and "workshop mark" in out)

        # --- 3. Configured via the environment variable. ---------------------
        os.environ[sr.EXTRA_SECRET_FILES_ENV] = str(tmp)
        env_stats: dict[str, int] = {}
        env_out = redact(BARE_PROSE, sr.load_known_secrets((), env_stats))
        check("env var: bare password struck", FX_PASSWORD not in env_out)
        check("env var: unpunctuated phone struck", FX_PHONE_BARE not in env_out)
        check("env var: bare date of birth struck", FX_DOB not in env_out)
        check("env var: file counted as read", env_stats["extra_files_read"] == 1)

        # --- 4. The length floor, and what it protects against. --------------
        check("length floor: short entry refused and counted",
              stats["extra_too_short"] >= 1)
        check("length floor: short entry is not a known value",
              all(v != "ab" for _, v in known))
        two_char_doc = "a table of ab ab ab and more ab text"
        check("length floor: document not destroyed by short entry",
              redact(two_char_doc, known) == two_char_doc)

        # --- 5. Longest-first: a value containing another goes whole. --------
        nested_out = redact(f"The tag read {FX_LONG} on the reverse.", known)
        check("ordering: containing value struck whole",
              FX_LONG not in nested_out
              and FX_PASSWORD not in nested_out
              and nested_out.count("[REDACTED:EXTRA_SECRET]") == 1)

        # --- 6. `key: value` keeps the whole line as a value as well. --------
        check("kv: whole line struck as one span",
              FX_DOB not in redact(
                  f"a note reading birthday: {FX_DOB} was pinned there", known))

        # --- 7. Comment-leading values: the documented escape hatch. ---------
        hash_file = tmp.parent / "redact-fixture-hash.txt"
        try:
            hash_file.write_text("#Qz7mR4vKp\nesc = #Qz7mR4vKp\n", encoding="utf-8")
            hash_known = sr.load_known_secrets([str(hash_file)], {})
            check("comment-leading value reachable via `key = value`",
                  "#Qz7mR4vKp" not in redact(
                      "the label read #Qz7mR4vKp on the reverse", hash_known))
        finally:
            try:
                hash_file.unlink()
            except OSError:
                pass

        # --- 8. Missing / unreadable paths are skipped, never fatal. ---------
        os.environ.pop(sr.EXTRA_SECRET_FILES_ENV, None)
        miss_stats: dict[str, int] = {}
        try:
            miss_known = sr.load_known_secrets(
                [str(tmp.parent / "definitely-not-here-8412.txt")], miss_stats)
            missing_ok = miss_stats["extra_files_missing"] == 1
        except Exception:
            missing_ok, miss_known = False, []
        check("missing file: skipped quietly and counted", missing_ok)
        check("missing file: other sources still loaded", isinstance(miss_known, list))

        dir_stats: dict[str, int] = {}
        try:
            sr.load_known_secrets([str(tmp.parent)], dir_stats)
            dir_ok = dir_stats["extra_files_missing"] == 1
        except Exception:
            dir_ok = False
        check("directory path: skipped quietly and counted", dir_ok)

        # --- 9. os.pathsep lists in a single value. --------------------------
        multi_stats: dict[str, int] = {}
        sr.load_known_secrets(
            [os.pathsep.join([str(tmp), str(tmp.parent / "nope-9931.txt")])],
            multi_stats)
        check("pathsep list: both entries seen",
              multi_stats["extra_files_listed"] == 2
              and multi_stats["extra_files_read"] == 1
              and multi_stats["extra_files_missing"] == 1)

        # --- 10. session-summary.py calls this with no arguments at all. -----
        try:
            sr.load_known_secrets()
            zero_ok = True
        except Exception:
            zero_ok = False
        check("back-compat: load_known_secrets() takes no arguments", zero_ok)

    finally:
        if saved_env is None:
            os.environ.pop(sr.EXTRA_SECRET_FILES_ENV, None)
        else:
            os.environ[sr.EXTRA_SECRET_FILES_ENV] = saved_env
        try:
            tmp.unlink()
        except OSError:
            pass
        check("cleanup: temporary fixture file deleted", not tmp.exists())


# ---------------------------------------------------------------------------
# PHONE
# ---------------------------------------------------------------------------

PHONE_POSITIVE = (
    "(240) 490-0053",
    "240-490-0053",
    "240.490.0053",
    "+1 240 490 0053",
    "1-240-490-0053",
    "(415) 555-0142",
    "+44 20 7946 0958",
    "+33 1 42 68 53 00",
    "+49 30 901820",
    "+12404900053",
)

# Every one of these is a shape the rule would eat if the punctuation evidence
# were relaxed. They are the reason the rule looks the way it does.
PHONE_NEGATIVE = (
    "electron 39.8.5 shipped",
    "version 1.240.490.0053 of the shim",
    "semver 10.15.7 and 1.2.3",
    "router at 8.8.8.8 responded",
    "id 1753142400 and 1753142400123 in the log",
    "chmod 755 400 0644 on the tree",
    "columns: 250 300 1000 rows",
    "2026-07-22T10:30:00Z is the stamp",
    "2026-07-22 10:30:00 local",
    "run 240 490 0053 through the filter",
    "placeholder 100-200-3000 in the docs",
    "commit f47ac10b-58cc-4372-a567-0e02b2c3d479 landed",
    "C:/Users/sasha/Documents/Repos/backrooms/tools/session-redact.py",
    "/usr/local/lib/python3.14/site-packages/foo-1.2.3.dist-info",
)


def run_phone_tests() -> None:
    for i, sample in enumerate(PHONE_POSITIVE, 1):
        text = f"reach the desk at {sample} between ten and four"
        check(f"phone matches form #{i}",
              "PHONE" in labels(text) and sample not in redact(text, []))

    for i, sample in enumerate(PHONE_NEGATIVE, 1):
        check(f"phone false-positive guard #{i}", "PHONE" not in labels(sample))

    check("phone redacted with no keyword nearby",
          "240-490-0053" not in redact(
              "the sign said 240-490-0053 and nothing else", []))
    check("phone at end of sentence",
          "240-490-0053" not in redact("call 240-490-0053.", []))


# ---------------------------------------------------------------------------
# DOB
# ---------------------------------------------------------------------------

DOB_POSITIVE = (
    "dob: 1985-03-14",
    "DOB 03/14/1985",
    "d.o.b. 14.03.1985",
    "date of birth: 1985-03-14",
    "birth date = 1985/03/14",
    "birthday: March 14, 1985",
    "my birthday is 14 March 1985",
    "Birthdate: 14-03-1985",
)

# A general date matcher would strike every one of these. That is why there
# isn't one.
DOB_NEGATIVE = (
    "the release date is 2026-07-22 as planned",
    "meeting on 2026-07-22 at ten",
    "birthday party on the 14th, bring cake",
    "date of birth field was left blank",
    "changelog entry 2026-07-22: shipped the ward",
    "a bare 1985-03-14 in the middle of a sentence",
    "born in the spring of 1985 near the coast",
)


def run_dob_tests() -> None:
    for i, sample in enumerate(DOB_POSITIVE, 1):
        text = f"the form said {sample} in the margin"
        # The label must survive; only the date goes, as with the other
        # by-position rules.
        check(f"dob matches labelled form #{i}",
              "DOB" in labels(text) and "[REDACTED:DOB]" in redact(text, []))

    for i, sample in enumerate(DOB_NEGATIVE, 1):
        check(f"dob false-positive guard #{i}", "DOB" not in labels(sample))


# ---------------------------------------------------------------------------
# Over-redaction guard: prose, code, UUIDs, paths, versions.
# ---------------------------------------------------------------------------

CLEAN_CORPUS = """\
The ward went in on Tuesday and the freeze turned out to be our own getChunk bug,
not Electron. We bumped electron 33.4.11 to 39.8.5 and it cleared seventeen alerts.

def get_chunk(index: int) -> bytes:
    offset = index * CHUNK_SIZE
    return buffer[offset:offset + CHUNK_SIZE]

Session f47ac10b-58cc-4372-a567-0e02b2c3d479 wrote to
D:/Users/sasha/Documents/Repos/backrooms/tools/session-summary.py and then to
/usr/local/lib/python3.14/site-packages/backrooms/level_null.py at 2026-07-22.

The release notes list versions 1.2.3, 10.15.7 and 2.240.490.0053 side by side.
Row totals were 250 300 1000 and the file modes were 755 400 0644.
"""


def run_clean_corpus_tests() -> None:
    found = labels(CLEAN_CORPUS)
    check("clean corpus: no PHONE detection", "PHONE" not in found)
    check("clean corpus: no DOB detection", "DOB" not in found)
    out = redact(CLEAN_CORPUS, [])
    check("clean corpus: uuid preserved",
          "f47ac10b-58cc-4372-a567-0e02b2c3d479" in out)
    check("clean corpus: windows path preserved",
          "D:/Users/sasha/Documents/Repos/backrooms/tools/session-summary.py" in out)
    check("clean corpus: posix path preserved",
          "/usr/local/lib/python3.14/site-packages/backrooms/level_null.py" in out)
    check("clean corpus: version strings preserved",
          "1.2.3" in out and "10.15.7" in out and "2.240.490.0053" in out)
    check("clean corpus: code body preserved",
          "buffer[offset:offset + CHUNK_SIZE]" in out)
    check("clean corpus: prose preserved",
          "the freeze turned out to be our own getChunk bug" in out)
    check("clean corpus: numeric rows preserved",
          "250 300 1000" in out and "755 400 0644" in out)
    check("clean corpus: verification clean", sr.verify(out) == [])


# ---------------------------------------------------------------------------
# The detectors that already existed. All fixtures below are invented and
# structurally valid only -- none is or was a working credential.
# ---------------------------------------------------------------------------

REGRESSION = (
    ("anthropic key", "ANTHROPIC_KEY", "sk-ant-" + "A" * 40),
    ("github pat", "GITHUB_PAT", "github_pat_" + "B" * 30),
    ("aws key", "AWS_KEY", "AKIA" + "C" * 16),
    ("jwt", "JWT",
     "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
     "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ("assigned secret", "ASSIGNED_SECRET", "password=hunter2swordfish"),
    ("dsn password", "DSN_PASSWORD", "postgres://admin:s3cr3tp4ss@db.internal:5432/app"),
    ("json secret", "JSON_SECRET", '{"api_key": "abc123def456ghi789"}'),
    ("ssn", "SSN", "123-45-6789"),
    ("email", "EMAIL", "someone@example.invalid"),
    ("private ip", "PRIVATE_IP", "172.16.1.1"),
    ("url secret", "URL_SECRET", "https://host/x?sig=AbCdEfGhIjKlMnOp"),
    ("pin code", "PIN_CODE", "the cvv is 4821"),
)


def run_regression_tests() -> None:
    for name, label, sample in REGRESSION:
        check(f"regression: {name} still detected", label in labels(sample))


# ---------------------------------------------------------------------------
# End to end, through the real CLI, in a subprocess.
# ---------------------------------------------------------------------------

def run_cli_tests() -> None:
    tmpdir = Path(tempfile.mkdtemp(prefix="redact-e2e-"))
    session = tmpdir / "fixture-session.jsonl"
    secrets_file = tmpdir / "fixture-secrets.txt"
    out_md = tmpdir / "out.md"
    try:
        body = (
            f"The card in the drawer said {FX_PASSWORD} in ballpoint.\n"
            f"A slip with {FX_PHONE_BARE} was folded under the lamp.\n"
            f"The engraving reads {FX_DOB} and a workshop mark.\n"
            "Reach the desk at (415) 555-0142 between ten and four.\n"
            "The form said date of birth: 1972-11-02 in the margin.\n"
        )
        session.write_text(
            json.dumps({"message": {"role": "user", "content": body}}) + "\n",
            encoding="utf-8")
        secrets_file.write_text(
            "# invented fixtures\n"
            f"{FX_PASSWORD}\n{FX_PHONE_BARE}\nbirthday: {FX_DOB}\nab\n",
            encoding="utf-8")

        env = dict(os.environ)
        env.pop(sr.EXTRA_SECRET_FILES_ENV, None)

        r = subprocess.run(
            [sys.executable, str(MODULE_PATH), str(session), "-o", str(out_md)],
            capture_output=True, text=True, env=env)
        check("cli unconfigured: exits 0", r.returncode == 0)
        check("cli unconfigured: reports 'none configured'",
              "none configured" in r.stdout)
        text = out_md.read_text(encoding="utf-8")
        check("cli unconfigured: bare password survives", FX_PASSWORD in text)
        check("cli unconfigured: unpunctuated phone survives", FX_PHONE_BARE in text)
        check("cli unconfigured: bare dob survives", FX_DOB in text)
        check("cli unconfigured: punctuated phone redacted",
              "(415) 555-0142" not in text and "[REDACTED:PHONE]" in text)
        check("cli unconfigured: labelled dob redacted",
              "1972-11-02" not in text and "[REDACTED:DOB]" in text)

        r = subprocess.run(
            [sys.executable, str(MODULE_PATH), str(session),
             "--extra-secrets", str(secrets_file), "-o", str(out_md)],
            capture_output=True, text=True, env=env)
        check("cli --extra-secrets: exits 0", r.returncode == 0)
        check("cli --extra-secrets: reports files read", "1 listed, 1 read" in r.stdout)
        check("cli --extra-secrets: reports refused short entry", "1 refused" in r.stdout)
        text = out_md.read_text(encoding="utf-8")
        check("cli --extra-secrets: bare password struck", FX_PASSWORD not in text)
        check("cli --extra-secrets: unpunctuated phone struck", FX_PHONE_BARE not in text)
        check("cli --extra-secrets: bare dob struck", FX_DOB not in text)
        check("cli --extra-secrets: EXTRA_SECRET marker present",
              "[REDACTED:EXTRA_SECRET]" in text)

        env2 = dict(env)
        env2[sr.EXTRA_SECRET_FILES_ENV] = os.pathsep.join(
            [str(secrets_file), str(tmpdir / "absent-4471.txt")])
        r = subprocess.run(
            [sys.executable, str(MODULE_PATH), str(session), "-o", str(out_md)],
            capture_output=True, text=True, env=env2)
        check("cli env var: exits 0", r.returncode == 0)
        check("cli env var: missing path reported, not fatal",
              "2 listed, 1 read, 1 missing/unreadable" in r.stdout)
        text = out_md.read_text(encoding="utf-8")
        check("cli env var: bare password struck", FX_PASSWORD not in text)
        check("cli env var: bare dob struck", FX_DOB not in text)

        if SUMMARY_PATH.is_file():
            r = subprocess.run(
                [sys.executable, str(SUMMARY_PATH), str(session)],
                capture_output=True, text=True, env=env)
            check("session-summary.py still loads the redactor", r.returncode == 0)

    finally:
        for p in (session, secrets_file, out_md):
            try:
                p.unlink()
            except OSError:
                pass
        for leftover in tmpdir.glob("*"):
            try:
                leftover.unlink()
            except OSError:
                pass
        try:
            tmpdir.rmdir()
        except OSError:
            pass
        check("cleanup: temporary e2e fixtures removed", not tmpdir.exists())


def main() -> int:
    run_extra_secret_tests()
    run_phone_tests()
    run_dob_tests()
    run_clean_corpus_tests()
    run_regression_tests()
    run_cli_tests()

    failed = [n for n, ok in RESULTS if not ok]
    width = max(len(n) for n, _ in RESULTS) + 2
    for name, ok in RESULTS:
        print(f"{name:<{width}} {'PASS' if ok else 'FAIL'}")
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
