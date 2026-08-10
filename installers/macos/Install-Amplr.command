#!/usr/bin/env bash
set -euo pipefail

REPO_ZIP="https://github.com/jack108510/jsw-multipost/archive/refs/heads/main.zip"
INSTALL_DIR="$HOME/Applications/Amplr"
EXT_DIR="$INSTALL_DIR/extension"
RUNNER="$INSTALL_DIR/scripts/amplr-runner.sh"
INSTALL_RUNNER="$INSTALL_DIR/scripts/install-amplr-runner.sh"
TMP_DIR="$(mktemp -d)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

step() { printf '\033[36m[Amplr]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[Amplr]\033[0m %s\n' "$*" >&2; read -r -p "Press Enter to close..." _ || true; exit 1; }

clear || true
echo "Amplr Installer"
echo "This installs Amplr and keeps Chrome available for scheduled posts."
echo

[[ -x "$CHROME" ]] || fail "Google Chrome was not found. Install Chrome first, then run Amplr Installer again."
mkdir -p "$INSTALL_DIR"

step "Downloading latest Amplr..."
curl -L "$REPO_ZIP" -o "$TMP_DIR/amplr.zip" || fail "Could not download Amplr. Check your internet connection."

step "Installing extension files..."
rm -rf "$EXT_DIR"
unzip -q "$TMP_DIR/amplr.zip" -d "$TMP_DIR" || fail "Could not unzip Amplr."
SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'jsw-multipost-*' | head -n 1)"
[[ -n "$SRC_DIR" ]] || fail "Downloaded Amplr package did not contain the expected folder."
cp -R "$SRC_DIR" "$EXT_DIR"
chmod +x "$EXT_DIR/scripts/amplr-runner.sh" "$EXT_DIR/scripts/install-amplr-runner.sh"

step "Installing background runner..."
"$EXT_DIR/scripts/install-amplr-runner.sh" "$EXT_DIR" || fail "Could not install Amplr Runner."

step "Opening Chrome with Amplr loaded..."
open -a "Google Chrome" --args --profile-directory=Default --load-extension="$EXT_DIR" --no-first-run

echo
echo "Amplr installed."
echo "Next: pin/open the Amplr extension, sign into Amplr, and make sure Facebook is logged in."
echo
read -r -p "Press Enter to close..." _ || true
