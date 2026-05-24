# iOS build notes

`src-tauri/gen/apple/` is gitignored (Tauri regenerates it). `tauri ios init`
rewrites `gen/apple/project.yml` from a template, which **overwrites** the
edits below. After any re-init (or fresh clone + init), re-apply these to
`gen/apple/project.yml`, then run `xcodegen generate` in `gen/apple/` (or just
`pnpm tauri ios dev`, which runs xcodegen).

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
        DEVELOPMENT_TEAM: 59TJ84BVPY
        CODE_SIGN_STYLE: Automatic
```

(`59TJ84BVPY` is the team id from the "Apple Development: geetduggal@gmail.com"
codesigning identity — `security find-identity -v -p codesigning`.)

Free-team caveats: app expires ~7 days (re-run to refresh); trust the cert on
the phone (Settings → General → VPN & Device Management); device + Mac on the
same Wi-Fi for `tauri ios dev`.

## 3. Bundle identifier

A free personal team can't register the generic `com.order.app`. The id is
`com.geetduggal.order`, set in three places that must agree:

- `src-tauri/tauri.conf.json` → `identifier` (tracked; also the desktop app id
  and the dev-server-addr file name).
- `project.yml` → `options.bundleIdPrefix: com.geetduggal`
- `project.yml` → `settingGroups.app.base.PRODUCT_BUNDLE_IDENTIFIER: com.geetduggal.order`

## Run

`pnpm tauri ios dev` (not Xcode's Run button — dev mode needs the CLI to start
the vite dev server and write the `<identifier>-server-addr` file).
