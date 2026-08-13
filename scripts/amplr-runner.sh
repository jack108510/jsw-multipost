#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="${AMPLR_EXT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CHROME_APP="${AMPLR_CHROME_APP:-/Applications/Google Chrome.app}"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
CHROME_PROFILE="${AMPLR_CHROME_PROFILE:-Default}"
DASHBOARD_URL="${AMPLR_DASHBOARD_URL:-https://jack108510.github.io/jsw-multipost/dashboard.html}"
CHECK_INTERVAL="${AMPLR_RUNNER_INTERVAL:-30}"
HEARTBEAT_STALE_SECONDS="${AMPLR_HEARTBEAT_STALE_SECONDS:-150}"
HEARTBEAT_CHECK_EVERY="${AMPLR_HEARTBEAT_CHECK_EVERY:-60}"
EXTENSION_ID="${AMPLR_EXTENSION_ID:-nglcanaclcaahancoecenliekemolfgp}"
LOG_DIR="$HOME/Library/Logs/Amplr"
WATCH_LOG="$LOG_DIR/runner.watch.log"
WATCHDOG="$EXT_DIR/scripts/amplr-heartbeat-watchdog.py"

mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$WATCH_LOG"
}

if [[ ! -d "$EXT_DIR" ]]; then
  log "Extension directory not found: $EXT_DIR"
  exit 1
fi

if [[ ! -x "$CHROME_BIN" ]]; then
  log "Chrome binary not found: $CHROME_BIN"
  exit 1
fi

if [[ -f "$WATCHDOG" ]]; then
  chmod +x "$WATCHDOG"
else
  log "Heartbeat watchdog not found: $WATCHDOG"
fi

log "Amplr runner started ext=$EXT_DIR profile=$CHROME_PROFILE interval=${CHECK_INTERVAL}s heartbeat_stale=${HEARTBEAT_STALE_SECONDS}s"
last_heartbeat_check=0

launch_chrome() {
  open -a "$CHROME_APP" --args \
    --profile-directory="$CHROME_PROFILE" \
    --load-extension="$EXT_DIR" \
    --no-first-run \
    --disable-features=Translate \
    "$DASHBOARD_URL" || log "Failed to launch Chrome"
}

while true; do
  now=$(date +%s)
  if ! pgrep -f "Google Chrome.*--load-extension=$EXT_DIR" >/dev/null 2>&1; then
    log "Chrome with Amplr extension is not running; launching"
    launch_chrome
  elif [[ -x "$WATCHDOG" && $((now - last_heartbeat_check)) -ge $HEARTBEAT_CHECK_EVERY ]]; then
    last_heartbeat_check=$now
    if output=$(python3 "$WATCHDOG" \
      --ext-dir "$EXT_DIR" \
      --chrome-app "$CHROME_APP" \
      --chrome-profile "$CHROME_PROFILE" \
      --dashboard-url "$DASHBOARD_URL" \
      --extension-id "$EXTENSION_ID" \
      --stale-seconds "$HEARTBEAT_STALE_SECONDS" 2>&1); then
      log "heartbeat watchdog: $output"
    else
      rc=$?
      log "heartbeat watchdog rc=$rc: $output"
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
