#!/usr/bin/env bash
# Build the signed desktop app (.app + .dmg on macOS).
# Output: src-tauri/target/release/bundle/{macos,dmg}/
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm tauri build

echo
echo "Artifacts:"
ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
