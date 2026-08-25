#!/usr/bin/env bash
set -euo pipefail

LABEL="com.amplr.runner"
EXT_DIR="${AMPLR_EXT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CHROME_USER_DATA_DIR="${AMPLR_CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Amplr/ChromeProfile}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Amplr"

if launchctl print "gui/$(id -u)/$LABEL" >/tmp/amplr-runner-status.$$ 2>/dev/null; then
  echo "LaunchAgent: running"
  awk '/state =|pid =|runs =|path =/ {print "  "$0}' /tmp/amplr-runner-status.$$
else
  echo "LaunchAgent: not loaded"
fi
rm -f /tmp/amplr-runner-status.$$

if [[ -f "$PLIST" ]]; then
  echo "Plist: $PLIST"
else
  echo "Plist: missing ($PLIST)"
fi

if pgrep -f "Google Chrome.*--load-extension=$EXT_DIR" >/dev/null 2>&1; then
  echo "Chrome: running with Amplr extension"
  pgrep -fl "Google Chrome.*--load-extension=$EXT_DIR" | head -5
else
  echo "Chrome: NOT running with Amplr extension path $EXT_DIR"
fi

if curl -fsS --max-time 3 http://127.0.0.1:9223/json/version >/tmp/amplr-cdp-status.$$ 2>/dev/null; then
  echo "CDP: healthy on 127.0.0.1:9223"
  python3 - /tmp/amplr-cdp-status.$$ <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print('  Browser:', data.get('Browser'))
PY
else
  echo "CDP: NOT reachable on 127.0.0.1:9223"
fi
rm -f /tmp/amplr-cdp-status.$$

if [[ -f "$LOG_DIR/runner.watch.log" ]]; then
  echo "Recent runner log:"
  tail -5 "$LOG_DIR/runner.watch.log"
fi

WATCHDOG="$EXT_DIR/scripts/amplr-heartbeat-watchdog.py"
if [[ -x "$WATCHDOG" || -f "$WATCHDOG" ]]; then
  echo "Heartbeat watchdog:"
  python3 "$WATCHDOG" \
    --ext-dir "$EXT_DIR" \
    --chrome-user-data-dir "$CHROME_USER_DATA_DIR" \
    --chrome-profile "${AMPLR_CHROME_PROFILE:-Default}" \
    --dashboard-url "${AMPLR_DASHBOARD_URL:-https://jack108510.github.io/jsw-multipost/dashboard.html}" \
    --extension-id "${AMPLR_EXTENSION_ID:-nglcanaclcaahancoecenliekemolfgp}" \
    --stale-seconds "${AMPLR_HEARTBEAT_STALE_SECONDS:-150}" \
    --no-restart || true
fi
