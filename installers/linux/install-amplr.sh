#!/usr/bin/env bash
set -euo pipefail

REPO_ZIP="https://github.com/jack108510/jsw-multipost/archive/refs/heads/main.zip"
INSTALL_DIR="$HOME/.local/share/amplr"
EXT_DIR="$INSTALL_DIR/extension"
RUNNER="$INSTALL_DIR/amplr-runner.sh"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="$SERVICE_DIR/amplr-runner.service"
LOG_DIR="$HOME/.local/state/amplr"
TMP_DIR="$(mktemp -d)"

log() { printf '\033[36m[Amplr]\033[0m %s\n' "$*"; }

find_chrome() {
  for cmd in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  done
  echo "Google Chrome or Chromium was not found. Install Chrome first, then run this installer again." >&2
  exit 1
}

CHROME="$(find_chrome)"
mkdir -p "$INSTALL_DIR" "$LOG_DIR"

log "Downloading latest Amplr..."
if command -v curl >/dev/null 2>&1; then
  curl -L "$REPO_ZIP" -o "$TMP_DIR/amplr.zip"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TMP_DIR/amplr.zip" "$REPO_ZIP"
else
  echo "curl or wget is required." >&2
  exit 1
fi

log "Installing extension files..."
rm -rf "$EXT_DIR"
unzip -q "$TMP_DIR/amplr.zip" -d "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'jsw-multipost-*' | head -n 1)"
cp -R "$SRC_DIR" "$EXT_DIR"

cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CHROME="$CHROME"
EXT_DIR="$EXT_DIR"
LOG_DIR="$LOG_DIR"
mkdir -p "\$LOG_DIR"
while true; do
  if ! pgrep -af "\$CHROME.*--load-extension=\$EXT_DIR" >/dev/null 2>&1; then
    printf '[%s] Starting Chrome with Amplr\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "\$LOG_DIR/runner.log"
    "\$CHROME" --profile-directory=Default --load-extension="\$EXT_DIR" --no-first-run --disable-features=Translate >/dev/null 2>&1 &
  fi
  sleep 30
done
EOF
chmod +x "$RUNNER"

if command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE" <<EOF
[Unit]
Description=Amplr Runner

[Service]
ExecStart=$RUNNER
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
EOF
  log "Installing user service..."
  systemctl --user daemon-reload
  systemctl --user enable --now amplr-runner.service
else
  log "systemd not found; starting runner for this session only."
  nohup "$RUNNER" >/dev/null 2>&1 &
fi

log "Opening Chrome with Amplr loaded..."
"$CHROME" --profile-directory=Default --load-extension="$EXT_DIR" --no-first-run >/dev/null 2>&1 &

log "Amplr installed. Sign into Amplr and make sure Facebook is logged in."
