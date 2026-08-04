#!/usr/bin/env bash
# Build Order and sideload it to a connected iPhone WITHOUT needing Xcode's
# GUI account for signing.
#
# Why this exists: command-line `xcodebuild` (what `scripts/build-ios.sh` /
# `tauri ios build` drive) CANNOT do automatic signing with a free "Personal
# Team" — it fails with "No Accounts", because free-team provisioning is only
# available through the Xcode GUI. This script sidesteps that: it builds the app
# UNSIGNED (`tauri ios build --no-sign`, which still runs the Rust build via
# Tauri's own RPC), then codesigns the .app OFFLINE with the Xcode-managed
# provisioning profile already on disk + the Apple Development certificate.
# Offline signing needs no live account, so it works headless.
#
# Prereq: a provisioning profile for the bundle id must already exist on disk.
# Xcode creates one automatically the first time you Run (⌘R) the app on the
# device, and refreshes it (free-team profiles expire ~7 days). If none is
# found, this script tells you to do that once.
#
# Usage: scripts/sideload-ios.sh [DEVICE_ID]
#   DEVICE_ID defaults to the first connected iPhone (from `devicectl`).
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="com.geetduggal.order"

echo "==> Building unsigned app (tauri ios build --no-sign)…"
pnpm tauri ios build --no-sign --ci

APP=$(ls -td "$HOME"/Library/Developer/Xcode/DerivedData/order-*/Build/Products/release-iphoneos/Order.app 2>/dev/null | head -1)
[ -d "$APP" ] || { echo "!! Order.app not found in DerivedData"; exit 1; }
echo "==> Built: $APP"

# Find a valid provisioning profile whose application-identifier ends in the
# bundle id. Newest file wins.
PROFILE=""
while IFS= read -r p; do
  security cms -D -i "$p" >/tmp/_order_pp.plist 2>/dev/null || continue
  appid=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:application-identifier" /tmp/_order_pp.plist 2>/dev/null || true)
  case "$appid" in
    *".$BUNDLE_ID") PROFILE="$p"; break ;;
  esac
done < <(ls -t "$HOME"/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
                "$HOME"/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision 2>/dev/null)

if [ -z "$PROFILE" ]; then
  echo "!! No provisioning profile found for $BUNDLE_ID."
  echo "   Open the project in Xcode and Run (⌘R) once on your iPhone to have"
  echo "   Xcode generate one, then re-run this script."
  exit 1
fi
echo "==> Profile: $PROFILE"

IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')
[ -n "$IDENTITY" ] || { echo "!! No 'Apple Development' signing identity in the keychain"; exit 1; }
echo "==> Identity: $IDENTITY"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/Order.app"
cp "$PROFILE" "$STAGE/Payload/Order.app/embedded.mobileprovision"
security cms -D -i "$PROFILE" >"$STAGE/pp.plist"
/usr/libexec/PlistBuddy -x -c "Print :Entitlements" "$STAGE/pp.plist" >"$STAGE/ent.plist"

echo "==> Signing…"
codesign --force --sign "$IDENTITY" --entitlements "$STAGE/ent.plist" --generate-entitlement-der "$STAGE/Payload/Order.app"
codesign --verify --strict "$STAGE/Payload/Order.app"

IPA="src-tauri/gen/apple/build/arm64/Order-signed.ipa"
mkdir -p "$(dirname "$IPA")"; rm -f "$IPA"
( cd "$STAGE" && zip -qr "$OLDPWD/$IPA" Payload )
echo "==> Signed IPA: $IPA"

DEVICE="${1:-}"
if [ -z "$DEVICE" ]; then
  # Any paired iPhone (state may read "connected" OR "available (paired)").
  # `|| true` so a no-match doesn't trip `set -e` before the guard below.
  DEVICE=$(xcrun devicectl list devices 2>/dev/null \
    | grep -iE 'iphone' \
    | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -1 || true)
fi
[ -n "$DEVICE" ] || { echo "!! No connected iPhone found. Pass a device id, or connect the phone."; exit 1; }
echo "==> Installing to device $DEVICE…"
xcrun devicectl device install app --device "$DEVICE" "$IPA"
echo "==> Done — Order is on your phone."
