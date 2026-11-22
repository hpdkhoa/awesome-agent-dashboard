#!/bin/sh
# Runs the bridge in the background: on Linux a systemd user service, on macOS a launchd agent (s14);
# Linux: a systemd user service running `python3 -m agent_bridge watch`.
#   Install:   sh bridge/install-service.sh
#   Remove:    sh bridge/install-service.sh --uninstall
#   Log:       journalctl --user -u agent-dashboard-bridge -f
# Run `python3 -m agent_bridge signin` once before installing.
# To keep it running while you are logged out (a server), also run once: loginctl enable-linger "$USER"
set -eu
NAME=agent-dashboard-bridge

# plan c5cb9485 s14: macOS has no systemd: a launchd agent in ~/Library/LaunchAgents runs the bridge at log-in and
# starts it again when it stops (KeepAlive), so it is back after a reboot. Log: ~/.awesome-agent-dashboard/bridge.log.
if [ "$(uname -s)" = "Darwin" ]; then
  LABEL="co.500kv.$NAME"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ "${1:-}" = "--uninstall" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed launchd agent $LABEL."
    exit 0
  fi
  BRIDGE=$(cd "$(dirname "$0")" && pwd)
  PYTHON=$(command -v python3)
  LOG="$HOME/.awesome-agent-dashboard/bridge.log"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PYTHON</string><string>-m</string><string>agent_bridge</string><string>watch</string></array>
  <key>WorkingDirectory</key><string>$BRIDGE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLISTEOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed and started launchd agent $LABEL. Log: $LOG"
  exit 0
fi
UNIT="$HOME/.config/systemd/user/$NAME.service"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed service $NAME."
  exit 0
fi

BRIDGE=$(cd "$(dirname "$0")" && pwd)
PYTHON=$(command -v python3)
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=awesome-agent-dashboard bridge: syncs Claude Code sessions and token spend (read-only)
After=network-online.target

[Service]
WorkingDirectory=$BRIDGE
ExecStart=$PYTHON -m agent_bridge watch
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
UNITEOF
systemctl --user daemon-reload
systemctl --user enable --now "$NAME"
echo "Installed and started service $NAME. Log: journalctl --user -u $NAME -f"
