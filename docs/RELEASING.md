# Releasing Order

Three scripts, one per artifact. Run them from anywhere; they cd to the
repo root themselves.

## 1. Desktop (.app + .dmg)

```bash
scripts/build-desktop.sh
```

Produces a signed bundle under `src-tauri/target/release/bundle/`.
Signing uses whatever identity `tauri.conf.json` / your keychain
provide; an unsigned build still produces a runnable .app for local
use.

## 2. iOS (.ipa)

```bash
scripts/build-ios.sh              # debugging export — sideload to your device
scripts/build-ios.sh app-store    # App Store export — needs a paid team
```

Sideload the debugging build:

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> src-tauri/gen/apple/build/arm64/Order.ipa
```

Free-team caveats (see `docs/ios-build-notes.md` for the project.yml
details): the app expires after ~7 days, and the cert must be trusted
on-device under Settings → General → VPN & Device Management.

## 3. Update a GitHub release

```bash
scripts/build-desktop.sh && scripts/build-ios.sh
scripts/release.sh v0.1.0
```

`release.sh` force-moves the tag to the current commit, creates the
release if needed, and uploads the .dmg + .ipa with `--clobber` so
re-running replaces stale assets.

## App Store submission

One-time setup:

1. Enroll in the Apple Developer Program (paid — the free personal team
   cannot submit).
2. In App Store Connect, create the app record: bundle id
   `com.geetduggal.order`, name "Order".
3. In `src-tauri/gen/apple/project.yml`, set `DEVELOPMENT_TEAM` to the
   paid team id and re-run `xcodegen generate` in `gen/apple/`
   (re-apply the PATH + signing edits from `docs/ios-build-notes.md`
   if you ever re-init).

Each submission:

```bash
scripts/build-ios.sh app-store
xcrun altool --upload-app -f src-tauri/gen/apple/build/arm64/Order.ipa \
  -t ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

(or open `src-tauri/gen/apple/order.xcodeproj` in Xcode and use
Product → Archive → Distribute App, which handles upload + validation
interactively.)

Then in App Store Connect: attach the build to a version, fill the
privacy questionnaire (Order collects nothing; all data stays in the
user's vault), add screenshots, and submit for review. macOS App Store
follows the same path with `tauri build` + Xcode's notarization flow.
