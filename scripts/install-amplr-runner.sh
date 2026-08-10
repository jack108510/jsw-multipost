#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="${1:-/Users/jackserver/JSW-MultiPost}"
RUNNER="$EXT_DIR/scripts/amplr-runner.sh"
PLIST="$HOME/Library/LaunchAgents/com.amplr.runner.plist"
LOG_DIR="$HOME/Library/Logs/Amplr"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "Extension directory not found: $EXT_DIR" >&2
  exit 1
fi

if [[ ! -x "$RUNNER" ]]; then
  chmod +x "$RUNNER"
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.amplr.runner</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AMPLR_EXT_DIR</key>
    <string>$EXT_DIR</string>
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
EOF

launchctl bootout gui/$(id -u) "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl enable gui/$(id -u)/com.amplr.runner
launchctl kickstart -k gui/$(id -u)/com.amplr.runner

echo "Amplr runner watcher installed and started."
echo "Plist: $PLIST"
echo "Runner: $RUNNER"
echo "Extension: $EXT_DIR"
