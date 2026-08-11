#!/usr/bin/env bash
set -euo pipefail

LABEL="com.amplr.runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl disable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Amplr runner uninstalled."
echo "Removed LaunchAgent: $PLIST"
echo "Chrome was not quit. If you want to stop Chrome too, quit it manually."
