#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT_DIR/installers/macos/Amplr-Installer.pkg"
SCRIPTS="$ROOT_DIR/installers/macos/pkg-scripts"

chmod +x "$SCRIPTS/postinstall"
pkgbuild \
  --identifier ca.amplr.installer \
  --version 1.0.0 \
  --scripts "$SCRIPTS" \
  --nopayload \
  "$OUT"

echo "Built $OUT"
