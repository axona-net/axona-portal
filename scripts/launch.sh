#!/bin/bash
# =====================================================================
# launch.sh — start axona.portal from a double-click.
#
# Shared by "Axona Portal.command" and the generated .app bundle. Everything
# awkward about launching a Node app from Finder lives here:
#
#   1. FINDING NODE. A GUI launch does NOT inherit your shell's PATH — Finder
#      hands the process a minimal environment, so `node` is simply not found
#      even though it works perfectly in Terminal. This is THE reason
#      double-click launchers for Node apps usually fail, so we probe the real
#      install locations (Homebrew on both architectures, nvm, fnm, volta,
#      asdf, MacPorts, system) rather than trusting PATH.
#   2. VERSION. Node 20+ is required; an older one fails deep inside the
#      kernel's WebCrypto use, which is a terrible way to learn this.
#   3. FIRST RUN. No node_modules yet -> install them, visibly.
#   4. ALREADY RUNNING. A second double-click should re-open the window, not
#      collide on the port.
#
# Anything that goes wrong is reported in words, not a stack trace.
# =====================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE" || exit 1

RUNTIME="$HOME/.axona-portal/runtime.json"

say()  { printf '%s\n' "$*"; }
die()  {
  say ""
  say "  ✗ $*"
  say ""
  # A .command runs in Terminal so this is visible; the .app bundle sets
  # AXONA_GUI=1 and gets a dialog instead of shouting into /dev/null.
  if [ "${AXONA_GUI:-0}" = "1" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"$*\" with title \"Axona Portal\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
  else
    say "  Press any key to close this window."
    read -r -n 1 -s
  fi
  exit 1
}

open_url() {
  case "$(uname -s)" in
    Darwin) open "$1" ;;
    Linux)  xdg-open "$1" >/dev/null 2>&1 & ;;
    *)      say "  Open this in your browser: $1" ;;
  esac
}

# ── 4. already running? ───────────────────────────────────────────────
if [ -f "$RUNTIME" ]; then
  RPID=$(sed -n 's/.*"pid":[[:space:]]*\([0-9]*\).*/\1/p' "$RUNTIME")
  RURL=$(sed -n 's/.*"url":[[:space:]]*"\([^"]*\)".*/\1/p' "$RUNTIME")
  if [ -n "${RPID:-}" ] && kill -0 "$RPID" 2>/dev/null; then
    say "axona.portal is already running (pid $RPID) — reopening its window."
    [ -n "${RURL:-}" ] && open_url "$RURL"
    exit 0
  fi
  rm -f "$RUNTIME"          # stale file from a crash or a hard kill
fi

# runtime.json is the happy path, but it is absent after a hard kill while the
# process may still hold the port. Ask the OS directly rather than letting node
# fail with EADDRINUSE.
PORT="${AXONA_PORT:-7777}"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is already in use.

If axona.portal is already running, use its window.
Otherwise find what holds the port with:

    lsof -nP -iTCP:$PORT -sTCP:LISTEN

or start on another port:  AXONA_PORT=7788 npm start"
fi

# ── 1. find node ──────────────────────────────────────────────────────
# When launched from a terminal, the user's own PATH choice wins — that is a
# deliberate selection and we should not second-guess it.
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  # GUI launch: there is no user PATH to respect, so gather EVERY install we
  # can find and take the NEWEST. Taking the first hit in a fixed list picked
  # v23 over an installed v24 on the machine this was written on — an
  # arbitrary choice between two of the user's own runtimes.
  candidates=""
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/bin/node" \
    /opt/local/bin/node \
    "$HOME/.asdf/shims/node"
  do
    [ -x "$c" ] && candidates="$candidates$c"$'\n'
  done
  # Version managers keep each release under its own directory.
  for root in "$HOME/.nvm/versions/node" \
              "$HOME/Library/Application Support/fnm/node-versions" \
              "$HOME/.local/share/fnm/node-versions"; do
    [ -d "$root" ] || continue
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      for candidate in "$root/$v/bin/node" "$root/$v/installation/bin/node"; do
        [ -x "$candidate" ] && candidates="$candidates$candidate"$'\n'
      done
    done <<< "$(ls -1 "$root" 2>/dev/null)"
  done

  best_ver=""
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    v="$("$c" -p 'process.versions.node' 2>/dev/null)" || continue
    [ -n "$v" ] || continue
    if [ -z "$best_ver" ] || [ "$(printf '%s\n%s\n' "$best_ver" "$v" | sort -V | tail -1)" = "$v" ]; then
      best_ver="$v"; NODE="$c"
    fi
  done <<< "$candidates"
fi

[ -n "$NODE" ] || die "Node.js was not found.

axona.portal needs Node 20 or newer.
Install it from https://nodejs.org (or 'brew install node'), then try again."

# npm lives beside node in every one of the layouts above.
export PATH="$(dirname "$NODE"):$PATH"

# ── 2. version ────────────────────────────────────────────────────────
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$MAJOR" in
  ''|*[!0-9]*) die "Could not read the version of Node at $NODE." ;;
esac
[ "$MAJOR" -ge 20 ] || die "Node $("$NODE" -v) is too old — axona.portal needs Node 20 or newer.

Found: $NODE"

say "axona.portal"
say "  node $("$NODE" -v)  ($NODE)"

# ── 3. first run ──────────────────────────────────────────────────────
if [ ! -d "node_modules/@axona" ]; then
  say "  first run — installing dependencies, this takes a minute…"
  if ! npm install; then
    die "npm install failed. Run it yourself in:
$HERE"
  fi
fi

say ""
exec "$NODE" src/index.js
