# GCal Sync — Plan 2b: iOS OAuth (design, for review)

> **Status: DESIGN — needs your approval before implementation.** I can't device-test iOS here (Xcode + a real device/simulator + signing are yours), so this lays out the approach, the forks, and a recommendation. Once you pick the options, it becomes a plan and I implement the parts that aren't device-bound; you run the on-device verification.

## The one product question first

iOS already **sees** your Google events today: you connect on desktop, push/import there, and the synced `spacetime.mw` carries the events to the phone (that's what the new iOS guard message says). So iOS OAuth only buys you one thing:

> **the ability to push to Google / import from Google *from the phone itself*** (curate on the go).

If "connect + sync happens on the desktop, the phone just views" is fine for you, **we should not build 2b at all** — it's real complexity (a new Google client, a native deep-link path, on-device auth testing, weekly-token caveats) for a convenience. My honest recommendation: **only build 2b if you actually want to curate/sync from the phone.** Decision 0 below.

## Why iOS can't reuse the desktop flow

The desktop flow binds a loopback `TcpListener` (`http://127.0.0.1:port`) and has the system browser redirect to it. iOS sandboxes that away — apps can't run a loopback server the browser will reach. Apple/Google's installed-app pattern for iOS is a **custom URL scheme** redirect: the browser redirects to `com.googleusercontent.apps.<id>:/…` and the OS hands that URL back to the app. (Verified against Google's native-app OAuth docs and the Tauri v2 deep-link plugin docs, June 2026.)

## What changes vs. desktop (and what's reused)

**Reused from `gcal.rs` (no change):** `pkce_pair`, `parse_token_response`, `fetch_email`, `store_refresh_token`/`load_refresh_token` (Keychain), `fetch_access_token` (refresh grant), `AccountsConfig`, and **all of push/import** (Plans 3–4) — those run identically once an account is connected, because they only need a stored refresh token.

**New / different for iOS:**
1. **Google client type:** a separate **iOS OAuth client** (the Desktop client won't accept a custom-scheme redirect). It has **no client secret**; redirect = the reversed client ID, e.g. `com.googleusercontent.apps.123-abc:/oauth2redirect`.
2. **Redirect capture:** `tauri-plugin-deep-link` registers the reversed-client-id scheme (auto-writes `CFBundleURLTypes` into Info.plist) and delivers the redirect via `on_open_url`. We pull `code` + `state` from that URL instead of from a loopback request.
3. **Auth URL:** same builder, but `redirect_uri` is the custom scheme and there's no secret.
4. **Token exchange:** post `client_id + code + code_verifier + grant_type + redirect_uri` — **omit `client_secret`** (the only real change to `exchange_code`).
5. **Config:** store the iOS client ID separately (`client_id_ios`). The custom **scheme is build-time** (it goes in `tauri.conf.json` deep-link config + Info.plist), so the iOS client ID is effectively set once at build config and entered/confirmed in Settings at runtime — the two must match.

## The forks (your call)

**Decision 0 — build it at all?**
- (a) **Yes** — I want to push/import from the phone.
- (b) **No / not now** — desktop is where I sync; the iOS guard message is enough. *(Recommended unless you specifically want on-the-go curation.)*

**Decision 1 — redirect mechanism (if building):**
- (a) **`tauri-plugin-deep-link` + system browser** *(Recommended)* — open the auth URL in Safari; the plugin catches the custom-scheme redirect; existing Rust does the exchange. **Minimal native code**, reuses ~everything. Slight UX seam (bounces to Safari and back).
- (b) **`ASWebAuthenticationSession` (a small Swift Tauri plugin)** — Apple's in-app auth sheet, nicer UX and the "blessed" path. Costs a hand-written Swift iOS plugin + its own testing. Good as a *later* polish over (a).

**Decision 2 — iOS client ID entry:**
- (a) **Settings field, iOS-only** *(Recommended)* — a "Google iOS Client ID" field appears on iOS; you paste the iOS client's ID; the build-time scheme in `tauri.conf.json` must be its reversed form. One-time.
- (b) Hard-code the scheme + client ID in config files (simpler, but bakes your client into the repo).

## Recommended path (if Decision 0 = yes)

Decision 1(a) + Decision 2(a): a **deep-link-based iOS connect** that reuses the entire Rust token/push/import stack, adding only: the deep-link plugin + scheme config, an iOS `gcal_connect_account` that opens Safari and awaits the `on_open_url` redirect, a secret-less `exchange_code` path, and an iOS-only Settings field. Everything else (push via reconciliation, per-day import) already works the moment a refresh token lands in the iOS Keychain.

### Rough task shape (becomes the plan on approval)
1. Add `tauri-plugin-deep-link` + scheme config (`tauri.conf.json`, capabilities, Info.plist via plugin). *(build config — you verify on device)*
2. `exchange_code` gains a no-secret iOS variant (pure-ish; unit-testable: assert the token request body omits `client_secret`).
3. iOS `gcal_connect_account`: build PKCE+state, open the auth URL, await `on_open_url`, validate `state`, exchange, store, register. *(device-tested by you)*
4. Settings: iOS-only "Google iOS Client ID" field + helper (mirror the existing credentials helper). *(you verify on device)*
5. Verification: unit (exchange body) + **on-device** (connect on phone → push/import from phone).

## Open risks / things to verify during implementation
- **`keyring` on iOS:** it uses the Security framework on Apple platforms; needs confirming it links/works under the iOS app sandbox (entitlements). If not, fall back to Tauri's secure-storage or the app's protected container.
- **Weekly token expiry:** the Testing-mode 7-day refresh-token expiry applies on iOS too — connecting on the phone would also need periodic reconnect until you publish the Google app.
- **Pre-existing iOS build snag:** a bare `cargo check --target aarch64-apple-ios` currently fails compiling `tauri-plugin-vault`'s Swift (`UTType.folder` wants iOS 14+). The real `tauri ios build` likely sets a deployment target that avoids it — confirm your iOS deployment target is ≥ 14 before adding more native surface.
- **Two Google clients:** you'd maintain both a Desktop client (already set up) and an iOS client in the same Google project.

## Out of scope (this plan)
- ASWebAuthenticationSession polish (Decision 1b) — a later iteration if the deep-link UX feels rough.
- App Check / App Attest hardening.
- Syncing the desktop refresh token to iOS (Keychains are per-device by design; you connect once per device).
