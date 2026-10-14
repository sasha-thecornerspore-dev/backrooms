#!/usr/bin/env bash
# usage: bash tools/build-itch.sh src dist/backrooms-web-<version>.zip
# The /play/ bundle (tools/build-play.sh) built for itch.io and other portals (Game Jolt, Newgrounds), zipped: index.html at the root,
# relative paths only, itch's limits checked (itch.io/docs/creators/html5), no counter (the GoatCounter tag is the site's alone — owner
# decision 2026-10-13), no service worker (build-play.sh's itch target), and nothing from the desktop build config inside. Every
# check runs before the zip exists: a failed check leaves no zip behind. Zips with `zip`, or Python's zipfile where `zip` is missing (Windows Git Bash has unzip but no zip).
set -euo pipefail
SRC="${1:?src dir}"; OUT="${2:?out zip}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
P="$TMP/play"
PLAY_TARGET=itch bash "$(dirname "$0")/build-play.sh" "$SRC" "$P" >/dev/null

[ -f "$P/index.html" ] || { echo "build-itch: no index.html at the root" >&2; exit 1; }
n=$(find "$P" -type f | wc -l); [ "$n" -le 1000 ] || { echo "build-itch: $n files: itch allows 1000" >&2; exit 1; }
! find "$P" -type f -size +200M | grep -q . || { echo "build-itch: a file over 200 MB" >&2; exit 1; }
long=$(cd "$P" && find . -type f | sed 's#^\./##' | awk 'length > 240'); [ -z "$long" ] || { echo "build-itch: a path over 240 characters: $long" >&2; exit 1; }
! grep -nE '(src|href)="/[^/]' "$P"/index.html || { echo "build-itch: an absolute path survived in index.html" >&2; exit 1; }
! grep -rli goatcounter "$P" || { echo "build-itch: a goatcounter string reached the itch build (the counter is the site's alone)" >&2; exit 1; }
! grep -rlE 'wishToken|ghp_|github_pat_' "$P" || { echo "build-itch: a token-shaped string reached the web build" >&2; exit 1; }
[ ! -e "$P/build-config.json" ] || { echo "build-itch: build-config.json must never ship to the web" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"; OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"; rm -f "$OUT_ABS"
if command -v zip >/dev/null; then
  (cd "$P" && zip -q -r -X "$OUT_ABS" .)
else
  PY=""; for c in python3 python; do if "$c" -c 'import zipfile' >/dev/null 2>&1; then PY="$c"; break; fi; done
  [ -n "$PY" ] || { echo "build-itch: neither 'zip' nor Python is installed" >&2; exit 1; }
  (cd "$P" && "$PY" -m zipfile -c "$OUT_ABS" .)   # '.' puts every entry at the root, as zip -r does
fi
echo "built $OUT_ABS ($n files)"
