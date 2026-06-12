#!/usr/bin/env bash
# Point a release tag at the current commit and upload fresh binaries.
#   scripts/release.sh v0.1.0
# Builds nothing itself — run build-desktop.sh / build-ios.sh first.
# Requires the gh CLI authenticated for the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: scripts/release.sh <tag>}"
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
IPA="src-tauri/gen/apple/build/arm64/Order.ipa"

echo "Tag: $TAG -> $(git rev-parse --short HEAD)"
git tag -f "$TAG"
git push -f origin "$TAG"

# Create the release if it doesn't exist yet, then upload artifacts
# (--clobber replaces same-named assets from a previous build).
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "$TAG" --notes "Source-available release. Build instructions in the README."

[ -n "$DMG" ] && gh release upload "$TAG" "$DMG" --clobber && echo "uploaded $(basename "$DMG")"
[ -f "$IPA" ] && gh release upload "$TAG" "$IPA" --clobber && echo "uploaded Order.ipa"

gh release view "$TAG" --json assets --jq '.assets[].name'
