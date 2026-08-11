#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="${AMPLR_EXT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CHROME_APP="${AMPLR_CHROME_APP:-/Applications/Google Chrome.app}"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
CHROME_PROFILE="${AMPLR_CHROME_PROFILE:-Default}"
DASHBOARD_URL="${AMPLR_DASHBOARD_URL:-https://jack108510.github.io/jsw-multipost/dashboard.html}"
CHECK_INTERVAL="${AMPLR_RUNNER_INTERVAL:-30}"
LOG_DIR="$HOME/Library/Logs/Amplr"
WATCH_LOG="$LOG_DIR/runner.watch.log"

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

log "Amplr runner started ext=$EXT_DIR profile=$CHROME_PROFILE interval=${CHECK_INTERVAL}s"

while true; do
  if ! pgrep -f "Google Chrome.*--load-extension=$EXT_DIR" >/dev/null 2>&1; then
    log "Chrome with Amplr extension is not running; launching"
    open -a "$CHROME_APP" --args \
      --profile-directory="$CHROME_PROFILE" \
      --load-extension="$EXT_DIR" \
      --no-first-run \
      --disable-features=Translate \
      "$DASHBOARD_URL" || log "Failed to launch Chrome"
  fi
  sleep "$CHECK_INTERVAL"
done
