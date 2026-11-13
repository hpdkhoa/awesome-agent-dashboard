#!/bin/sh
# Plug a new box into the dashboard, in one run (Linux, macOS). The owner's words, 2026-11-13: "make it in the way I can
# plug and play another box in this dashboard"; "is the setup has setup script to auto run on new box yet?".
#
#   sh bridge/setup-box.sh --url https://box2-files.example.com --roots "labs=/home/me/labs;web=/srv/web"
#
# Before: clone this repo on the box, copy .env from a box that already works (it holds no secret: the Firebase project,
# the page's public key, your email, the page origins), and route --url to 127.0.0.1:<FILES_PORT> with your own tunnel
# (the script never touches the tunnel).
# It then: installs the bridge's Python packages, writes this box's own lines into .env, signs you in (once), makes the
# empty local database, registers the inbox with Claude Code, installs and starts the background service, and waits
# until the bridge says it registered this box. Safe to run again: every step that is already done is skipped.
#
#   --url URL        this box's own address for the page (required the first time)
#   --roots "a=/p;b=/q"   the work folders on this box (WORK_ROOTS)
#   --name NAME      the box's name on the dashboard (default: the host name)
#   --port N         the local port the address routes to (default 8793)
#   --signin-port N  sign in over ssh: open the printed link on your own machine with `ssh -L N:localhost:N`
#   --no-service     do everything but the background service
#   --dry-run        say what would be done, change nothing
set -eu

URL=""; ROOTS=""; NAME=""; PORT=""; SIGNIN_PORT=""; SERVICE=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --roots) ROOTS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --signin-port) SIGNIN_PORT="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

BRIDGE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$BRIDGE")"
ENVF="$REPO/.env"
PY="$(command -v python3 || command -v python || true)"
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "would run: $*"; else "$@"; fi; }
fail() { say "STOP: $*" >&2; exit 1; }

step "1. Python"
[ -n "$PY" ] || fail "no python3 found: install Python 3.11 or newer"
"$PY" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' || fail "Python 3.11 or newer is needed ($("$PY" --version))"
say "$("$PY" --version) at $PY"

step "2. The bridge's packages"
if "$PY" -c 'import agent_bridge, keyring, mcp, psutil, jwt' 2>/dev/null && [ "$("$PY" -c 'import agent_bridge, os; print(os.path.dirname(os.path.dirname(agent_bridge.__file__)))')" = "$BRIDGE" ]; then
  say "already installed"
else
  run "$PY" -m pip install --user -e "$BRIDGE"
fi

step "3. .env"
[ -f "$ENVF" ] || fail "no $ENVF: copy .env from a box that already works, then run this again"
grep -q '^\(FIREBASE_PROJECT_ID\|VITE_FIREBASE_PROJECT_ID\)=.' "$ENVF" || fail ".env has no FIREBASE_PROJECT_ID"
grep -q '^VITE_FIREBASE_API_KEY=.' "$ENVF" || fail ".env has no VITE_FIREBASE_API_KEY"
setenv() {  # setenv KEY VALUE: replace the line or add it
  k="$1"; v="$2"
  [ -n "$v" ] || return 0
  if [ "$DRY" = 1 ]; then say "would set $k=$v in .env"; return 0; fi
  tmp="$ENVF.tmp"
  grep -v "^$k=" "$ENVF" > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$ENVF"
  say "set $k"
}
setenv FILES_URL "${URL%/}"
setenv WORK_ROOTS "$ROOTS"
setenv MACHINE_NAME "$NAME"
setenv FILES_PORT "$PORT"
# a copied .env names the first box's folders and hosts: they do not belong to this one
if [ -z "$ROOTS" ] && [ "$DRY" = 0 ]; then
  "$PY" - "$ENVF" <<'PYEOF' || fail "WORK_ROOTS in .env names folders that are not on this box: pass --roots \"name=/path;...\""
import os, sys
roots = [l.split("=", 1)[1].strip() for l in open(sys.argv[1], encoding="utf-8") if l.startswith("WORK_ROOTS=")]
paths = [p.split("=", 1)[1] for p in (roots[-1].split(";") if roots else []) if "=" in p]
raise SystemExit(0 if paths and all(os.path.isdir(p) for p in paths) else 1)
PYEOF
fi
grep -q '^FILES_URL=.' "$ENVF" || [ "$DRY" = 1 ] || fail "no address for this box: pass --url https://... (this box's own tunnel address)"

step "4. Sign in"
if (cd "$BRIDGE" && "$PY" -c 'from agent_bridge.auth import load_token; raise SystemExit(0 if load_token() else 1)') 2>/dev/null; then
  say "already signed in"
elif [ -n "$SIGNIN_PORT" ]; then
  say "open the printed link on your own machine (ssh -L $SIGNIN_PORT:localhost:$SIGNIN_PORT to this box)"
  (cd "$BRIDGE" && run "$PY" -m agent_bridge signin --port "$SIGNIN_PORT" --no-browser)
else
  (cd "$BRIDGE" && run "$PY" -m agent_bridge signin)
fi

step "5. The local database"
(cd "$BRIDGE" && run "$PY" -m agent_bridge init-local)

step "6. The inbox in Claude Code"
if ! command -v claude >/dev/null 2>&1; then
  say "no claude CLI on this box yet: install Claude Code and sign in, then run this again (runs need it)"
elif claude mcp list 2>/dev/null | grep -q '^agent-inbox'; then
  say "already registered"
else
  run claude mcp add --scope user agent-inbox -- "$PY" -m agent_bridge inbox
fi

step "7. The background service"
if [ "$SERVICE" = 0 ]; then
  say "skipped (--no-service). Start by hand: cd $BRIDGE && $PY -m agent_bridge watch"
else
  run sh "$BRIDGE/install-service.sh"
fi

step "8. Registered?"
if [ "$DRY" = 1 ] || [ "$SERVICE" = 0 ]; then
  say "not checked"
else
  LOG="$("$PY" -c 'import sys; sys.path.insert(0, sys.argv[1]); from agent_bridge.config import data_dir; print(data_dir() / "bridge.log")' "$BRIDGE")"
  i=0
  while [ $i -lt 45 ]; do
    if [ -f "$LOG" ] && grep -q 'registered as box\|in the registry' "$LOG"; then break; fi
    if command -v journalctl >/dev/null 2>&1 && journalctl --user -u agent-dashboard-bridge -n 60 --no-pager 2>/dev/null | grep -q 'registered as box\|in the registry'; then break; fi
    i=$((i + 1)); sleep 2
  done
  if [ $i -lt 45 ]; then
    say "This box is registered. Open the dashboard: it is under Boxes (right panel), plugged in."
  else
    say "The bridge has not said it registered yet. Look at its output (journalctl --user -u agent-dashboard-bridge, or $LOG)."
    say "Common causes: the tunnel does not route $URL to 127.0.0.1:${PORT:-8793}; SITE_ORIGINS in .env lacks the page's address."
  fi
fi
say ""
say "Unplug later: Boxes on the dashboard, Unplug. Remove the service: sh $BRIDGE/install-service.sh --uninstall"
