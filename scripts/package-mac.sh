#!/usr/bin/env bash
# =====================================================================
# package-mac.sh — produce a macOS build someone else can actually open.
#
# `npm run dist` alone does NOT do this. Three things bite, in order:
#
#  1. mac.identity:null makes electron-builder skip signing, leaving
#     Electron's own signature over a bundle we renamed and repacked. macOS
#     reports "code has no resources but signature indicates they must be
#     present" and REFUSES TO RUN IT on Apple Silicon — no dialog, no log.
#
#  2. codesign refuses any bundle carrying com.apple.FinderInfo. `xattr -cr`
#     does not clear it reliably from nested helpers, and com.apple.provenance
#     cannot be removed at all. Only rewriting the bundle with ditto sheds it.
#
#  3. Staging under ~/Documents re-adds the attribute as fast as you strip it.
#     The signing scratch space must live outside the protected tree.
#
# And the .dmg electron-builder produces re-breaks the signature after our
# afterPack hook has fixed it, which is why this ships a ditto archive —
# the format Apple documents as preserving a signature — and not a dmg.
#
# This does NOT notarize. A recipient still has to allow the app explicitly.
# What it buys is that the app CAN run once they do.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
WORK=$(mktemp -d /private/tmp/axona-portal-pkg.XXXXXX)   # NOT under ~/Documents
trap 'rm -rf "$WORK"' EXIT

npm run dist:dir
mkdir -p dist/share && rm -f dist/share/*.zip

for pair in "mac-arm64:AppleSilicon" "mac:Intel"; do
  src="dist/${pair%%:*}/axona.portal.app"; label="${pair##*:}"
  [ -d "$src" ] || { echo "  skip $label (not built)"; continue; }
  ditto --norsrc --noextattr --noacl "$src" "$WORK/$label.app"
  codesign --force --deep --sign - "$WORK/$label.app"
  codesign --verify --strict "$WORK/$label.app"          # fail loud, not later on a stranger's Mac
  mkdir -p "$WORK/$label-box"
  ditto "$WORK/$label.app" "$WORK/$label-box/axona.portal.app"
  ditto -c -k --keepParent "$WORK/$label-box/axona.portal.app" "dist/share/axona.portal-$VERSION-$label.zip"

  # Prove the signature survived the archive — that is the artifact that ships.
  ditto -x -k "dist/share/axona.portal-$VERSION-$label.zip" "$WORK/rt-$label"
  codesign --verify --strict "$WORK/rt-$label/axona.portal.app"
  echo "  ✓ dist/share/axona.portal-$VERSION-$label.zip  (signature verified after round-trip)"
done
