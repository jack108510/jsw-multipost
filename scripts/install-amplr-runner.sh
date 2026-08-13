#!/usr/bin/env bash
set -euo pipefail

LABEL="com.amplr.runner"
EXT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNNER="$EXT_DIR/scripts/amplr-runner.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Amplr"
CHROME_PROFILE="${AMPLR_CHROME_PROFILE:-Default}"
CHECK_INTERVAL="${AMPLR_RUNNER_INTERVAL:-30}"
HEARTBEAT_STALE_SECONDS="${AMPLR_HEARTBEAT_STALE_SECONDS:-150}"
HEARTBEAT_CHECK_EVERY="${AMPLR_HEARTBEAT_CHECK_EVERY:-60}"
EXTENSION_ID="${AMPLR_EXTENSION_ID:-nglcanaclcaahancoecenliekemolfgp}"
DASHBOARD_URL="${AMPLR_DASHBOARD_URL:-https://jack108510.github.io/jsw-multipost/dashboard.html}"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "Extension directory not found: $EXT_DIR" >&2
  exit 1
fi

if [[ ! -f "$EXT_DIR/manifest.json" ]]; then
  echo "manifest.json not found in extension directory: $EXT_DIR" >&2
  exit 1
fi

if [[ ! -f "$RUNNER" ]]; then
  echo "Runner script not found: $RUNNER" >&2
  exit 1
fi

chmod +x "$RUNNER"
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AMPLR_EXT_DIR</key>
    <string>$EXT_DIR</string>
    <key>AMPLR_CHROME_PROFILE</key>
    <string>$CHROME_PROFILE</string>
    <key>AMPLR_RUNNER_INTERVAL</key>
    <string>$CHECK_INTERVAL</string>
    <key>AMPLR_HEARTBEAT_STALE_SECONDS</key>
    <string>$HEARTBEAT_STALE_SECONDS</string>
    <key>AMPLR_HEARTBEAT_CHECK_EVERY</key>
    <string>$HEARTBEAT_CHECK_EVERY</string>
    <key>AMPLR_EXTENSION_ID</key>
    <string>$EXTENSION_ID</string>
    <key>AMPLR_DASHBOARD_URL</key>
    <string>$DASHBOARD_URL</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>20</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/runner.out.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/runner.err.log</string>
</dict>
</plist>
EOF_PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
sleep 2

"$EXT_DIR/scripts/status-amplr-runner.sh" || true

echo
echo "Amplr runner installed."
echo "LaunchAgent: $PLIST"
echo "Runner:      $RUNNER"
echo "Extension:   $EXT_DIR"
echo "Logs:        $LOG_DIR"
