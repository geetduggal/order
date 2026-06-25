# GCal Sync — Plan 2b: iOS OAuth (deep-link)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the iOS app connect a Google account via a custom-scheme (deep-link) OAuth flow, so push (Plan 3) and import (Plan 4) work from the phone — reusing the entire Rust token/push/import stack with only a secret-less exchange and a deep-link redirect capture added.

**Architecture:** iOS uses a Google **iOS OAuth client** (no client secret; redirect = the reversed-client-id custom scheme). `gcal_connect_account` on iOS opens the system browser, and `tauri-plugin-deep-link`'s `on_open_url` delivers the `com.googleusercontent.apps.…` redirect back to a waiting connect routine (matched by `state` through a managed `PendingAuth` channel). The token exchange omits `client_secret`; everything downstream (refresh, push, import) is unchanged. Pure helpers (secret-optional token form, reversed-client-id redirect derivation, redirect parsing) are unit-tested on desktop; the deep-link/opener wiring is cross-platform so it **compiles on desktop**; only the live redirect delivery + Keychain-in-sandbox are device-verified.

**Tech Stack:** Rust (`ureq`, `serde`, `percent-encoding`), `tauri-plugin-deep-link` 2, `tauri-plugin-opener` 2, React/TS. Rust unit tests via `cargo test`.

## Global Constraints

- iOS OAuth client has **NO client secret** (public client; security via PKCE S256). Desktop keeps id+secret. Redirect = reversed client id custom scheme `com.googleusercontent.apps.<id>:/oauth2redirect`.
- Reuse the existing `pkce_pair`, `auth_url`, `parse_token_response`, `fetch_email`, `store_refresh_token`, `AccountsConfig`, and ALL of push/import — do not fork them.
- Refresh tokens stay in the Keychain only (never config/vault/logs). `state` validated before accepting any redirect (CSRF).
- The iOS client id is non-secret and is entered in Settings on the phone (`client_id_ios`); the matching custom **scheme is build-time** in `tauri.conf.json` (the user pastes their reversed client id there once).
- Desktop behavior is unchanged: `#[cfg(not(target_os="ios"))]` keeps the loopback flow.
- No Claude/AI git authorship trailers.

## Testability note for the executor

Most of this plan compiles and is testable on **desktop** (`cargo build`, `cargo test`, `tsc`) because the deep-link and opener plugins are cross-platform and the iOS-specific code is small. The bar for each task is stated explicitly. The genuine **on-device** verification (does iOS deliver the redirect; does the Keychain work in the app sandbox) is Task 6 and is run by the human on a real device/simulator with `pnpm tauri ios dev`. Do not claim on-device verification from a desktop machine.

---

### Task 1: Secret-optional token exchange + `client_id_ios` config (Rust, cargo-TDD)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (`AccountsConfig`, form builders, `exchange_code`, `fetch_access_token`, `oauth_client`; tests)

**Interfaces:**
- Produces:
  - `AccountsConfig` gains `pub client_id_ios: String` (`#[serde(default)]`).
  - `pub fn auth_code_form<'a>(code: &'a str, client_id: &'a str, secret: Option<&'a str>, verifier: &'a str, redirect_uri: &'a str) -> Vec<(&'a str, &'a str)>` — includes `("client_secret", s)` only when `secret` is `Some`.
  - `pub fn refresh_form<'a>(refresh: &'a str, client_id: &'a str, secret: Option<&'a str>) -> Vec<(&'a str, &'a str)>` — same secret-omission rule.
  - `fn oauth_client(cfg: &AccountsConfig) -> (String, Option<String>)` — iOS → `(client_id_ios, None)`; desktop → `(client_id, Some(client_secret))`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/gcal.rs`:

```rust
    #[test]
    fn auth_code_form_omits_secret_when_none() {
        let f = auth_code_form("CODE", "cid", None, "ver", "redir");
        assert!(f.iter().any(|(k, v)| *k == "client_id" && *v == "cid"));
        assert!(f.iter().any(|(k, v)| *k == "code_verifier" && *v == "ver"));
        assert!(!f.iter().any(|(k, _)| *k == "client_secret"), "iOS form must omit client_secret");
    }

    #[test]
    fn auth_code_form_includes_secret_when_some() {
        let f = auth_code_form("CODE", "cid", Some("sec"), "ver", "redir");
        assert!(f.iter().any(|(k, v)| *k == "client_secret" && *v == "sec"));
    }

    #[test]
    fn refresh_form_secret_optional() {
        assert!(!refresh_form("r", "cid", None).iter().any(|(k, _)| *k == "client_secret"));
        assert!(refresh_form("r", "cid", Some("sec")).iter().any(|(k, v)| *k == "client_secret" && *v == "sec"));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function auth_code_form` / `refresh_form`.

- [ ] **Step 3: Implement**

In `src-tauri/src/gcal.rs`, add the `client_id_ios` field to `AccountsConfig` (after `client_secret`):

```rust
    #[serde(default)]
    pub client_id_ios: String,
```

Add the form builders + `oauth_client` (above `exchange_code`):

```rust
/// Build the authorization-code token form; `client_secret` is included only
/// for confidential (desktop) clients. iOS public clients pass `None`.
pub fn auth_code_form<'a>(code: &'a str, client_id: &'a str, secret: Option<&'a str>, verifier: &'a str, redirect_uri: &'a str) -> Vec<(&'a str, &'a str)> {
    let mut f = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(s) = secret { f.push(("client_secret", s)); }
    f
}

/// Build the refresh-token form; same secret-omission rule.
pub fn refresh_form<'a>(refresh: &'a str, client_id: &'a str, secret: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    let mut f = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id),
    ];
    if let Some(s) = secret { f.push(("client_secret", s)); }
    f
}

/// (client_id, optional secret) for the current platform. iOS clients are
/// public (no secret); desktop clients are confidential.
fn oauth_client(cfg: &AccountsConfig) -> (String, Option<String>) {
    #[cfg(target_os = "ios")]
    { (cfg.client_id_ios.clone(), None) }
    #[cfg(not(target_os = "ios"))]
    { (cfg.client_id.clone(), Some(cfg.client_secret.clone())) }
}
```

Rewrite `exchange_code` and `fetch_access_token` to use them:

```rust
/// Exchange an auth code for tokens (PKCE; secret only on desktop).
fn exchange_code(cfg: &AccountsConfig, code: &str, verifier: &str, redirect_uri: &str) -> Result<TokenResponse, String> {
    let (id, secret) = oauth_client(cfg);
    token_request(&auth_code_form(code, &id, secret.as_deref(), verifier, redirect_uri))
}

/// Refresh an access token from the stored refresh token. Used by push/import.
pub fn fetch_access_token(cfg: &AccountsConfig, email: &str) -> Result<String, String> {
    let refresh = load_refresh_token(email)?;
    let (id, secret) = oauth_client(cfg);
    let t = token_request(&refresh_form(&refresh, &id, secret.as_deref()))?;
    Ok(t.access_token)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: all gcal tests pass (now 15).

- [ ] **Step 5: Compile + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -4` → compiles.

```bash
git add src-tauri/src/gcal.rs
git commit -m "feat: secret-optional token exchange + client_id_ios (iOS public client)"
```

---

### Task 2: `ios_redirect_uri` + `parse_redirect_code` (Rust, cargo-TDD)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (two pure helpers + tests)

**Interfaces:**
- Produces:
  - `pub fn ios_redirect_uri(client_id_ios: &str) -> String` — `"123-abc.apps.googleusercontent.com"` → `"com.googleusercontent.apps.123-abc:/oauth2redirect"`.
  - `pub fn parse_redirect_code(url: &str, expected_state: &str) -> Result<String, String>` — pull `code` + `state` from the redirect URL's query (percent-decoded); error on state mismatch or missing code.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block:

```rust
    #[test]
    fn ios_redirect_uri_reverses_client_id() {
        assert_eq!(ios_redirect_uri("123-abc.apps.googleusercontent.com"), "com.googleusercontent.apps.123-abc:/oauth2redirect");
        // already-bare prefix tolerated
        assert_eq!(ios_redirect_uri("123-abc"), "com.googleusercontent.apps.123-abc:/oauth2redirect");
    }

    #[test]
    fn parse_redirect_code_validates_state() {
        let url = "com.googleusercontent.apps.123-abc:/oauth2redirect?state=ST8&code=AUTH%2FCODE";
        assert_eq!(parse_redirect_code(url, "ST8").unwrap(), "AUTH/CODE", "code is percent-decoded");
        assert!(parse_redirect_code(url, "WRONG").is_err(), "state mismatch rejected");
        assert!(parse_redirect_code("com.googleusercontent.apps.123-abc:/oauth2redirect?state=ST8", "ST8").is_err(), "missing code rejected");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function ios_redirect_uri` / `parse_redirect_code`.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/gcal.rs` (above the test module). `percent_decode_str` is already imported at the top.

```rust
/// Reversed-client-id custom-scheme redirect for a Google iOS client.
pub fn ios_redirect_uri(client_id_ios: &str) -> String {
    let prefix = client_id_ios.strip_suffix(".apps.googleusercontent.com").unwrap_or(client_id_ios);
    format!("com.googleusercontent.apps.{prefix}:/oauth2redirect")
}

/// Extract the auth code from a custom-scheme redirect URL after validating
/// `state` (CSRF guard). Query values are percent-decoded.
pub fn parse_redirect_code(url: &str, expected_state: &str) -> Result<String, String> {
    let query = url.split('?').nth(1).ok_or("redirect missing query")?;
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let dec = percent_decode_str(v).decode_utf8_lossy().to_string();
        match k {
            "code" => code = Some(dec),
            "state" => state = Some(dec),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err("authorization state mismatch (possible CSRF) — try again".into());
    }
    code.ok_or_else(|| "authorization redirect carried no code".to_string())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: all gcal tests pass (now 17).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gcal.rs
git commit -m "feat: ios_redirect_uri + parse_redirect_code (custom-scheme OAuth)"
```

---

### Task 3: Deep-link plugin + `PendingAuth` channel + opener (Rust/config, desktop-compiles)

**Files:**
- Modify: `src-tauri/Cargo.toml` (deps)
- Modify: `src-tauri/tauri.conf.json` (deep-link scheme)
- Modify: `src-tauri/src/gcal.rs` (`PendingAuth`/`PendingSlot`)
- Modify: `src-tauri/src/lib.rs` (plugins, manage state, `on_open_url`)

**Interfaces:**
- Produces:
  - `pub struct PendingSlot { pub state: String, pub tx: std::sync::mpsc::Sender<String> }`
  - `#[derive(Default)] pub struct PendingAuth(pub std::sync::Mutex<Option<PendingSlot>>);`
  - The app manages a `gcal::PendingAuth` and routes deep-link redirects (URLs containing `code=`/`state=`) into its slot's `tx`.

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
tauri-plugin-deep-link = "2"
tauri-plugin-opener = "2"
```

- [ ] **Step 2: Configure the custom scheme**

In `src-tauri/tauri.conf.json`, add to the `"plugins"` object (create it if absent, sibling to `"identifier"`/`"bundle"`). **Replace `REVERSED_IOS_CLIENT_ID`** with your reversed iOS client id, e.g. for client `123-abc.apps.googleusercontent.com` use `com.googleusercontent.apps.123-abc`:

```json
    "deep-link": {
      "mobile": [{ "scheme": ["com.googleusercontent.apps.REVERSED_IOS_CLIENT_ID"], "appLink": false }],
      "desktop": { "schemes": ["com.googleusercontent.apps.REVERSED_IOS_CLIENT_ID"] }
    }
```

- [ ] **Step 3: Add the `PendingAuth` state type**

In `src-tauri/src/gcal.rs` (near the other `pub struct`s), add:

```rust
/// One in-flight OAuth attempt: the expected CSRF `state` and a sender the
/// deep-link handler uses to deliver the redirect URL back to the connect call.
pub struct PendingSlot {
    pub state: String,
    pub tx: std::sync::mpsc::Sender<String>,
}

#[derive(Default)]
pub struct PendingAuth(pub std::sync::Mutex<Option<PendingSlot>>);
```

- [ ] **Step 4: Register plugins + state + the redirect handler**

In `src-tauri/src/lib.rs`, add the plugins after the existing `.plugin(...)` lines (around line 22):

```rust
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(gcal::PendingAuth::default())
```

Inside `.setup(|app| { ... })` (after the devtools block, ~line 159), add the redirect router:

```rust
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let u = url.to_string();
                        if !(u.contains("code=") || u.contains("state=")) { continue; }
                        let pending = handle.state::<gcal::PendingAuth>();
                        let mut slot = pending.0.lock().unwrap();
                        if slot.is_some() {
                            let _ = slot.as_ref().unwrap().tx.send(u);
                            *slot = None;
                        }
                    }
                });
            }
```

- [ ] **Step 5: Compile (desktop) + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -8`
Expected: compiles (the deep-link + opener plugins are cross-platform; warnings OK). This compile-checks the wiring even though the live redirect only fires on a device.

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/gcal.rs src-tauri/src/lib.rs
git commit -m "feat: deep-link + opener plugins + PendingAuth redirect channel"
```

---

### Task 4: iOS connect flow + `gcal_set_ios_client_id` (Rust, desktop-compiles)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (`connect_via_deeplink`, iOS `gcal_connect_account`, `gcal_set_ios_client_id`, `AccountsView.client_id_ios`)
- Modify: `src-tauri/src/lib.rs` (register `gcal::gcal_set_ios_client_id`)

**Interfaces:**
- Consumes: `PendingAuth`/`PendingSlot`, `ios_redirect_uri`, `parse_redirect_code`, `exchange_code`, `pkce_pair`, `auth_url`, `fetch_email`, `store_refresh_token`, `load_config`/`save_config`/`config_dir`.
- Produces: `pub async fn connect_via_deeplink(app) -> Result<String, String>`; the iOS `gcal_connect_account`; `#[tauri::command] gcal_set_ios_client_id(app, client_id_ios: String)`; `AccountsView` gains `pub client_id_ios: String`.

- [ ] **Step 1: Implement `connect_via_deeplink` (non-cfg, compiles everywhere)**

Add to `src-tauri/src/gcal.rs`:

```rust
/// Custom-scheme OAuth: open the system browser, await the deep-link redirect
/// (matched by state via PendingAuth), exchange (no secret), store, register.
pub async fn connect_via_deeplink(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;  // for app.state(); matches the function-local use in config_dir
    let dir = config_dir(&app)?;
    let cfg = load_config(&dir);
    if cfg.client_id_ios.trim().is_empty() {
        return Err("Set your Google iOS Client ID in Settings first.".into());
    }
    let redirect_uri = ios_redirect_uri(cfg.client_id_ios.trim());
    let (verifier, challenge) = pkce_pair();
    let (state, _) = pkce_pair();
    let url = auth_url(cfg.client_id_ios.trim(), &redirect_uri, &challenge, &state);

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    *app.state::<PendingAuth>().0.lock().unwrap() = Some(PendingSlot { state: state.clone(), tx });

    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        *app.state::<PendingAuth>().0.lock().unwrap() = None;
        return Err(format!("couldn't open the browser: {e}"));
    }

    let redirect = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(300))
    }).await.map_err(|e| format!("join: {e}"))?
        .map_err(|_| "timed out waiting for Google authorization (closed the browser?)".to_string())?;
    *app.state::<PendingAuth>().0.lock().unwrap() = None;

    let code = parse_redirect_code(&redirect, &state)?;
    let tokens = exchange_code(&cfg, &code, &verifier, &redirect_uri)?;
    let refresh = tokens.refresh_token.clone()
        .ok_or("Google returned no refresh token — revoke Order's access in your Google account and reconnect.")?;
    let email = fetch_email(&tokens.access_token)?;
    store_refresh_token(&email, &refresh)?;
    let mut cfg2 = load_config(&dir);
    if !cfg2.accounts.iter().any(|a| a == &email) { cfg2.accounts.push(email.clone()); }
    if cfg2.default.is_none() { cfg2.default = Some(email.clone()); }
    save_config(&dir, &cfg2)?;
    Ok(email)
}
```

- [ ] **Step 2: Point the iOS `gcal_connect_account` at it**

Replace the iOS stub variant of `gcal_connect_account` (the `#[cfg(target_os = "ios")]` one added by the guard commit) with:

```rust
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn gcal_connect_account(app: tauri::AppHandle) -> Result<String, String> {
    connect_via_deeplink(app).await
}
```

(The `#[cfg(not(target_os = "ios"))]` desktop loopback variant is unchanged.)

- [ ] **Step 3: Add `gcal_set_ios_client_id` + reflect in `AccountsView`**

Add the command:

```rust
#[tauri::command]
pub async fn gcal_set_ios_client_id(app: tauri::AppHandle, client_id_ios: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    cfg.client_id_ios = client_id_ios.trim().to_string();
    save_config(&dir, &cfg)
}
```

In `AccountsView`, add `pub client_id_ios: String,` and set it in `gcal_list_accounts` where the struct is built (`client_id_ios: cfg.client_id_ios.clone(),`).

- [ ] **Step 4: Register the command**

In `src-tauri/src/lib.rs` `generate_handler!`, after `gcal::gcal_list_day_events,`, add:

```rust
            gcal::gcal_set_ios_client_id,
```

- [ ] **Step 5: Compile (desktop) + tests + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -8` → compiles.
Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -5` → 17 pass.

```bash
git add src-tauri/src/gcal.rs src-tauri/src/lib.rs
git commit -m "feat: iOS deep-link connect flow + gcal_set_ios_client_id"
```

---

### Task 5: Settings — iOS-only Client ID field + helper + bridge (TS)

**Files:**
- Modify: `src/lib/gcal-accounts.ts` (`AccountsView.client_id_ios`, `setIosClientId` bridge)
- Modify: `src/components/SettingsPanel.tsx` (iOS-only field + helper, gated by `isIosSync()`)

**Interfaces:**
- Consumes: `gcal_set_ios_client_id`; `isIosSync` from `../lib/vault`.
- Produces: `setIosClientId(clientId)` bridge; an iOS-only field that saves the iOS client id.

- [ ] **Step 1: Bridge + type**

In `src/lib/gcal-accounts.ts`, add `client_id_ios: string;` to `AccountsView`, and:

```ts
export const setIosClientId = (clientId: string) => invoke<void>("gcal_set_ios_client_id", { clientIdIos: clientId });
```

- [ ] **Step 2: iOS-only field in Settings**

In `src/components/SettingsPanel.tsx`, import `isIosSync` from `../lib/vault` (if not already). In the Google Accounts section, render an iOS-only block (use the existing `gcal` state + a new `iosId` state seeded from `gcal.client_id_ios`):

```tsx
{isIosSync() && (
  <div className="settings-subsection">
    <label className="settings-label">Google iOS Client ID</label>
    <p className="settings-hint">
      iOS uses a separate Google credential. In Google Cloud → Credentials, create an
      OAuth client of type <strong>iOS</strong> (bundle id <code>com.geetduggal.order</code>),
      and paste its Client ID here. The reversed form must also be set as the app's URL scheme
      at build time. {gcal.client_id_ios ? "✓ iOS Client ID saved on this device." : ""}
    </p>
    <input
      className="settings-input"
      placeholder="123-abc.apps.googleusercontent.com"
      value={iosId}
      onChange={(e) => setIosId(e.target.value)}
    />
    <button
      type="button"
      className="settings-btn"
      disabled={!iosId.trim()}
      onClick={async () => {
        try { await setIosClientId(iosId.trim()); await refreshGcal(); }
        catch (e) { setGcalError(String(e)); }
      }}
    >Save iOS Client ID</button>
  </div>
)}
```

Add the state near the other gcal state: `const [iosId, setIosId] = useState("");` and an effect to seed it: `useEffect(() => { if (gcal.client_id_ios && !iosId) setIosId(gcal.client_id_ios); }, [gcal.client_id_ios, iosId]);`. Ensure `setIosClientId` is imported from `../lib/gcal-accounts`.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/gcal-accounts.ts src/components/SettingsPanel.tsx
git commit -m "feat: Settings — iOS Google Client ID field (iOS-only)"
```

---

### Task 6: Verification (desktop unit/compile + ON-DEVICE)

**Files:** none.

- [ ] **Step 1: Desktop gates**

```
cd src-tauri && cargo test gcal::     # 17 pass
cd src-tauri && cargo build           # compiles (deep-link/opener wiring included)
cd /Users/geet.duggal/Development/order
npx tsc --noEmit                      # clean
pnpm build                            # ✓ built
```

- [ ] **Step 2: ON-DEVICE (human, real device or simulator)**

Prerequisites (human):
1. In Google Cloud → Credentials, create an **iOS** OAuth client (bundle id `com.geetduggal.order`). Note its Client ID.
2. In `src-tauri/tauri.conf.json`, set the deep-link scheme to the reversed client id (`com.googleusercontent.apps.<id>`), then rebuild the iOS app so Info.plist picks it up.
3. Add the same account as a Test user (Audience), as on desktop.

Then in `pnpm tauri ios dev` on the device:
1. Settings → paste the iOS Client ID → Save.
2. Tap "Connect Google account" → Safari opens Google consent → approve → the app re-foregrounds and the account appears (default).
3. Verify the bottom-left "spacetime · N pending" surfaces Google-syncable events and a push from the phone lands on Google Calendar.
4. Verify a per-day import on the phone pulls events in.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add -A
git commit -m "chore: iOS OAuth on-device verification"
```

---

## Self-review notes
- Spec coverage (the 2b design doc): deep-link redirect mechanism (Decision 1a), iOS Settings field for the client id (Decision 2a), no-secret exchange, reuse of push/import. ASWebAuthenticationSession (1b) is explicitly out of scope.
- Unit-tested on desktop: `auth_code_form`/`refresh_form` secret omission, `ios_redirect_uri`, `parse_redirect_code`. Compile-verified on desktop: the deep-link/opener wiring + connect flow. Device-verified by the human: live redirect delivery, Keychain-in-sandbox, push/import from phone.
- Open risk to watch on device: `keyring` under the iOS app sandbox (entitlements). If `store_refresh_token`/`load_refresh_token` fail on device, that's the likely cause — fall back to a Tauri secure-storage plugin keyed the same way.

## Notes for the implementer
- Keep names exact: `auth_code_form`, `refresh_form`, `oauth_client`, `ios_redirect_uri`, `parse_redirect_code`, `PendingAuth`, `PendingSlot`, `connect_via_deeplink`, `gcal_set_ios_client_id`, `client_id_ios` (Rust) / `clientIdIos` (the invoke arg, camelCase).
- Do NOT alter the desktop loopback flow or the push/import code.
- `REVERSED_IOS_CLIENT_ID` in `tauri.conf.json` is a real user credential the human fills in — leave it as the placeholder string with the instruction; do not invent a value.
