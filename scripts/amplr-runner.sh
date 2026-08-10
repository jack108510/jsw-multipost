#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="${AMPLR_EXT_DIR:-/Users/jackserver/JSW-MultiPost}"
CHROME_APP="/Applications/Google Chrome.app"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
LOG_DIR="$HOME/Library/Logs/Amplr"
mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_DIR/runner.watch.log"
}

if [[ ! -d "$EXT_DIR" ]]; then
  log "Extension directory not found: $EXT_DIR"
  exit 1
fi

if [[ ! -x "$CHROME_BIN" ]]; then
  log "Chrome binary not found: $CHROME_BIN"
  exit 1
fi

log "Amplr runner started for $EXT_DIR"

while true; do
  if ! pgrep -f "Google Chrome.*--load-extension=$EXT_DIR" >/dev/null 2>&1; then
    log "Chrome with Amplr extension is not running; starting it"
    open -a "$CHROME_APP" --args \
      --profile-directory=Default \
      --load-extension="$EXT_DIR" \
      --no-first-run \
      --disable-features=Translate || log "Failed to start Chrome"
  fi
  sleep 30
done
