#!/usr/bin/env bash
# Build the iOS .ipa.
#   scripts/build-ios.sh            -> debugging export (sideload via devicectl)
#   scripts/build-ios.sh app-store  -> App Store export (requires paid team)
# Output: src-tauri/gen/apple/build/arm64/Order.ipa
set -euo pipefail
cd "$(dirname "$0")/.."

METHOD="${1:-debugging}"

pnpm install --frozen-lockfile
pnpm tauri ios build --export-method "$METHOD"

echo
echo "Artifact:"
ls -lh src-tauri/gen/apple/build/arm64/Order.ipa
