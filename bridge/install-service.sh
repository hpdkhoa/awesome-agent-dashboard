#!/bin/sh
# Runs the bridge in the background on Linux: a systemd user service running `python3 -m agent_bridge watch`.
#   Install:   sh bridge/install-service.sh
#   Remove:    sh bridge/install-service.sh --uninstall
#   Log:       journalctl --user -u agent-dashboard-bridge -f
# Run `python3 -m agent_bridge signin` once before installing.
# To keep it running while you are logged out (a server), also run once: loginctl enable-linger "$USER"
set -eu
NAME=agent-dashboard-bridge
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
