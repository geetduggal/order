#!/usr/bin/env bash
# Point a release tag at the current commit and upload fresh binaries.
#   scripts/release.sh v0.1.0
# Builds nothing itself — run build-desktop.sh / build-ios.sh first.
# Requires the gh CLI authenticated for the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: scripts/release.sh <tag>}"
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
APP="src-tauri/target/release/bundle/macos/Order.app"
IPA="src-tauri/gen/apple/build/arm64/Order.ipa"

# dmg bundling needs Finder automation and fails in headless shells;
# fall back to a ditto-zipped .app (signing preserved).
if [ -z "$DMG" ] && [ -d "$APP" ]; then
  DMG="/tmp/Order_${TAG#v}_aarch64_macos.app.zip"
  ditto -c -k --keepParent "$APP" "$DMG"
fi

echo "Tag: $TAG -> $(git rev-parse --short HEAD)"
git tag -f "$TAG"
git push -f origin "$TAG"

# Create the release if it doesn't exist yet, then upload artifacts
# (--clobber replaces same-named assets from a previous build).
NOTES="Source-available release. Build instructions in the README.

**macOS:** the .app is signed but not notarized, so macOS quarantines
the download and claims it is damaged. It isn't — clear the flag:
\`xattr -cr ~/Downloads/Order.app\`

**iOS:** development export; sideload via Xcode or
\`xcrun devicectl device install app --device <UDID> Order.ipa\`"
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "$TAG" --notes "$NOTES"

[ -n "$DMG" ] && gh release upload "$TAG" "$DMG" --clobber && echo "uploaded $(basename "$DMG")"
[ -f "$IPA" ] && gh release upload "$TAG" "$IPA" --clobber && echo "uploaded Order.ipa"

gh release view "$TAG" --json assets --jq '.assets[].name'
