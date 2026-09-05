#!/usr/bin/env bash
set -euo pipefail

# Script to regenerate all PWA, iOS, Favicon, and Open Graph resolutions
# from the master icon (static/og-preview.png).
#
# Usage:
#   ./scripts/set-app-icon.sh [optional_source_image.png]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC_DIR="$ROOT_DIR/static"
SOURCE="${1:-$STATIC_DIR/og-preview.png}"

if [ ! -f "$SOURCE" ]; then
  echo "Error: Source image not found at '$SOURCE'"
  exit 1
fi

echo "Generating icons from: $SOURCE"

# iOS Apple Touch Icon (180x180)
sips -z 180 180 "$SOURCE" --out "$STATIC_DIR/apple-touch-icon.png" > /dev/null

# Android / Chrome PWA Icons (192x192 and 512x512)
sips -z 192 192 "$SOURCE" --out "$STATIC_DIR/icon-192.png" > /dev/null
sips -z 512 512 "$SOURCE" --out "$STATIC_DIR/icon-512.png" > /dev/null

# Browser Favicons (32x32 and 64x64)
sips -z 32 32 "$SOURCE" --out "$STATIC_DIR/favicon-32x32.png" > /dev/null
sips -z 64 64 "$SOURCE" --out "$STATIC_DIR/favicon.png" > /dev/null

echo "✅ App icons updated in $STATIC_DIR:"
echo "  - apple-touch-icon.png (180x180)"
echo "  - icon-192.png (192x192)"
echo "  - icon-512.png (512x512)"
echo "  - favicon-32x32.png (32x32)"
echo "  - favicon.png (64x64)"
