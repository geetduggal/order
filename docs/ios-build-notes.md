# iOS build notes

`src-tauri/gen/apple/` is gitignored (Tauri regenerates it). `tauri ios init`
rewrites `gen/apple/project.yml` from a template, which **overwrites** the
edits below. After any re-init (or fresh clone + init), re-apply these to
`gen/apple/project.yml`, then run `xcodegen generate` in `gen/apple/` (or just
`pnpm tauri ios dev`, which runs xcodegen).

## ⚠️ Never overlap `tauri dev` (desktop) with `tauri ios build`

Symptom: the installed iOS app launches to **`asset not found: index.html`** (a
white/blank error screen) even though `dist/` is fresh and the build/install
"succeeds".

Cause: on iOS the frontend is compiled *into* the Rust binary by
`generate_context!`, but only when the `custom-protocol` feature is active
(`tauri-macros`: `dev = cfg!(not(feature = "custom-protocol"))`). `tauri dev`
compiles the shared **`tauri-macros` proc-macro WITHOUT `custom-protocol`**
(dev mode → empty asset map, expects a live dev server). A later `tauri ios
build` sharing `src-tauri/target/` can **reuse that cached dev-mode proc-macro**,
so the iOS binary ships an empty asset map → nothing to serve on-device.

Rules:
- Don't run `cetl 1` (desktop `tauri dev`) and `cetl 2` (`tauri ios build`) in
  overlapping sessions against the same `src-tauri/target/`.
- If you did, `cd src-tauri && cargo clean` before the iOS build. `cargo clean
  -p order` is **not** enough — the poisoned crate is `tauri-macros`.
- Verify the binary actually embedded the frontend (not just that the build
  "succeeded"):
  ```sh
  unzip -p src-tauri/gen/apple/build/arm64/Order.ipa Payload/Order.app/Order \
    | strings | grep -cE 'assets/index-[A-Za-z0-9]+\.(js|css)'   # must be > 0
  ```

## 1. PATH for the build script

Xcode runs build scripts with a minimal PATH that lacks Homebrew and Cargo, so
`pnpm`/`node`/`cargo` aren't found. In `project.yml`, the `Build Rust Code`
preBuildScript must prepend them:

```yaml
    preBuildScripts:
      - script: |
          export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
          pnpm tauri ios xcode-script -v --platform ${PLATFORM_DISPLAY_NAME:?} ...
```

## 2. Signing (free personal team)

No paid Apple Developer account needed. Add the Apple ID in Xcode → Settings →
Accounts. In `project.yml` under the target `settings.base`:

```yaml
        DEVELOPMENT_TEAM: 93AB46Q3G7
        CODE_SIGN_STYLE: Automatic
```

`93AB46Q3G7` is the **account/team id** of "Geet Duggal (Personal Team)" — the
team Xcode → Settings → Accounts is signed into, and the one that matches
`tauri.conf.json` `iOS.developmentTeam`. Get it from the certificate's **OU**,
not its name: `security find-certificate -c "Apple Development: geetduggal@gmail.com" -p | openssl x509 -noout -subject`
shows `OU=93AB46Q3G7`. The `(59TJ84BVPY)` inside the cert's Common Name is NOT
the team — setting `DEVELOPMENT_TEAM` to it makes Xcode show a red
"Unknown Name (59TJ84BVPY)" / "No Account for Team" and every build fails.

Free-team caveats: app expires ~7 days (re-run to refresh); trust the cert on
the phone (Settings → General → VPN & Device Management); device + Mac on the
same Wi-Fi for `tauri ios dev`.

### Headless signing — `scripts/sideload-ios.sh` (IMPORTANT)

**Command-line `xcodebuild` cannot do automatic signing with a free personal
team.** `scripts/build-ios.sh` / `tauri ios build` pass `-allowProvisioningUpdates`,
which phones home to the account to mint a profile — but free-team accounts live
only in the Xcode GUI's TCC-protected container (`group.com.apple.dt.Xcode.SecureSettingsContainer`),
so any headless build fails with `error: No Accounts` / `No profiles found`,
even when you're fully signed in and running as yourself. This is an Apple
limitation, not a project bug. Paid Developer Program accounts can sign from the
CLI; personal teams can't.

Two ways to get a build onto the phone:

1. **Xcode GUI:** select the `order_iOS` scheme + your iPhone, press ⌘R. The GUI
   has the account access the CLI lacks. Simplest; it also (re)generates the
   provisioning profile on disk.

2. **`scripts/sideload-ios.sh`** (fully headless, no account needed): builds the
   app UNSIGNED with `tauri ios build --no-sign` (Tauri still hosts the RPC the
   Rust build phase needs, but the "No Accounts" signing step is skipped), then
   **codesigns the `.app` offline** with the Xcode-managed provisioning profile
   already on disk + the Apple Development cert, packages the IPA, and installs
   via `devicectl`. Offline signing needs no live account, so it works from any
   shell — including CI/automation. It needs a profile to already exist on disk,
   which option 1 creates (and refreshes every ~7 days).

Do NOT try to "fix" a headless `build-ios.sh` signing failure by fiddling with
`DEVELOPMENT_TEAM`, manual profiles, or `CODE_SIGN_IDENTITY` — the managed
profile can't be used with manual signing, and the team is already correct. Use
`sideload-ios.sh`.

## 3. Bundle identifier

A free personal team can't register the generic `com.order.app`. The id is
`com.geetduggal.order`, set in three places that must agree:

- `src-tauri/tauri.conf.json` → `identifier` (tracked; also the desktop app id
  and the dev-server-addr file name).
- `project.yml` → `options.bundleIdPrefix: com.geetduggal`
- `project.yml` → `settingGroups.app.base.PRODUCT_BUNDLE_IDENTIFIER: com.geetduggal.order`

## 4. Calendar (EventKit) usage strings

The Apple/system-calendar feature needs `NSCalendarsFullAccessUsageDescription`
(+ legacy `NSCalendarsUsageDescription`) in the bundle Info.plist, or the
permission prompt crashes. The durable source is the tracked
`src-tauri/Info.plist`, which Tauri merges into both bundles.

`gen/apple/order_iOS/Info.plist` is regenerated by `tauri ios init`. If a fresh
init drops the keys, re-add them (or re-copy from `src-tauri/Info.plist`):

```xml
<key>NSCalendarsFullAccessUsageDescription</key>
<string>Order reads events from your selected calendars to import your day, and creates events you assign to a calendar. Invitations are sent through Google, not Apple.</string>
<key>NSCalendarsUsageDescription</key>
<string>Order reads events from your selected calendars to import your day, and creates events you assign to a calendar.</string>
```

## 5. `gen/apple/assets` must be a symlink to `dist`

The iOS app bundles its web frontend from `gen/apple/assets/` (a `resources`
folder reference in `project.yml`, copied to `Order.app/assets/`). `tauri ios
init` seeds this as a **one-time copy** of `dist/` and does **not** re-sync it on
later `tauri ios build`s. If it stays a stale copy, the app ships an old
frontend whose `index.html` references chunk hashes that no longer match — the
webview then fails with **`asset not found: index.html`** on launch.

Fix / keep it: make `assets` a symlink to the live `dist/` so every build
bundles the current frontend:

```sh
cd src-tauri/gen/apple
rm -rf assets && ln -s ../../../dist assets   # assets → <repo>/dist
```

Re-apply after any `tauri ios init`. Verify a build embedded the fresh frontend:

```sh
unzip -p src-tauri/gen/apple/build/arm64/Order.ipa \
  Payload/Order.app/assets/index.html | grep -oE 'index-[A-Za-z0-9]+\.js'
# → must match `grep … dist/index.html`
```

## Run

`pnpm tauri ios dev` (not Xcode's Run button — dev mode needs the CLI to start
the vite dev server and write the `<identifier>-server-addr` file).
