# GCal Sync — Plan 2: Desktop OAuth + Account Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user connect one or more Google accounts on **macOS desktop** via OAuth (PKCE loopback), store refresh tokens in the system Keychain, and manage the connected accounts (list, default, disconnect) from a Settings "Google Accounts" section. This is the auth foundation that Push (Plan 3) and Import (Plan 4) consume.

**Architecture:** A new Rust module `src-tauri/src/gcal.rs` owns the OAuth flow (PKCE, a throwaway loopback `TcpListener` redirect, `ureq` token exchange/refresh) and Keychain storage (`keyring` crate). A small JSON config in the app config dir tracks which accounts are connected and which is default. Tauri commands expose `gcal_connect_account`, `gcal_list_accounts`, `gcal_set_default`, `gcal_disconnect`, and `gcal_access_token`. A `src/lib/gcal-accounts.ts` TS bridge + a Settings section drive it. Pure logic (PKCE, auth-URL, token-response parsing, config) is unit-tested with `cargo test`; the live browser flow is manually verified.

**Tech Stack:** Rust (Tauri v2 commands, `ureq` + `native-tls`, `serde_json`, new deps `sha2` + `getrandom` + `keyring`), React/TS Settings UI. Rust unit tests via `cargo test` (the repo already has `#[cfg(test)]` modules in `vault_fs.rs`). TS bridge has no new test framework.

## Global Constraints

- **Desktop (macOS) only** in this plan. No iOS code — iOS deep-link OAuth is Plan 2b. Guard any desktop-only command so it returns a clear error on non-desktop rather than crashing.
- **PKCE** (Authorization Code + S256). Scope exactly `https://www.googleapis.com/auth/calendar.events`.
- **Refresh tokens live in the macOS Keychain** (`keyring` crate), keyed by account email. Never written to the vault or to plaintext config.
- The OAuth **client_id + client_secret** are the user's own (from their Google Cloud project), entered in Settings and stored in the app config dir (not the vault). For Google "Desktop app" clients the secret is non-confidential by design (bundled in installed apps), so storing it locally is acceptable.
- Account list + default are stored in `<app-config-dir>/gcal-accounts.json` (NOT the vault, NOT spacetime.mw).
- No Claude/AI git authorship trailers — plain commits, the given subject lines only.
- Consumes Plan 1 only conceptually (account emails feed `resolveRecipients` later); no code dependency on Plan 1 here.

---

### Task 1: Google Cloud setup (MANUAL — user-performed prerequisite)

**This task writes no code and makes no commit.** It produces the OAuth client credentials without which nothing else in this plan can be tested. The implementer (or controller) must confirm with the user that these exist before proceeding to Task 5's live verification; Tasks 2–4 (pure logic) can proceed in parallel.

- [ ] **Step 1: Create the Google Cloud project + enable the API**
  1. Go to https://console.cloud.google.com/ → create a project (e.g. "Order Calendar").
  2. APIs & Services → Library → enable **Google Calendar API**.

- [ ] **Step 2: Configure the OAuth consent screen**
  1. APIs & Services → OAuth consent screen → **External** → fill app name + your email.
  2. Scopes: add `…/auth/calendar.events`.
  3. **Test users:** add the Google account(s) you'll connect. (Testing mode needs no Google verification for personal use.)

- [ ] **Step 3: Create the OAuth client**
  1. APIs & Services → Credentials → Create Credentials → **OAuth client ID** → Application type **Desktop app**.
  2. Copy the **Client ID** and **Client secret**.

- [ ] **Step 4: Record the credentials for entry in Settings later**

Keep the Client ID + Client secret handy. In Task 7 they are pasted into Order's Settings → Google Accounts. Until then they're only needed for the Task 5 live test.

---

### Task 2: PKCE + authorization-URL helpers (Rust, cargo-TDD)

**Files:**
- Create: `src-tauri/src/gcal.rs`
- Modify: `src-tauri/Cargo.toml` (add `sha2`, `getrandom`)
- Modify: `src-tauri/src/lib.rs:7` (add `mod gcal;` after `mod terminal;`)

**Interfaces:**
- Produces: `pub fn pkce_pair() -> (String, String)` returns `(verifier, challenge)` where `challenge = base64url_nopad(sha256(verifier))` and `verifier` is 64 url-safe chars; `pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String` builds the Google consent URL with scope `https://www.googleapis.com/auth/calendar.events`, `access_type=offline`, `prompt=consent`.

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
sha2 = "0.10"
getrandom = "0.2"
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, after line 7 (`mod terminal;`), add:

```rust
mod gcal;
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/src/gcal.rs` with ONLY the test module first (so it fails to compile → RED):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(verifier.len(), 64, "verifier length");
        // Recompute S256 independently.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(verifier.as_bytes());
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(digest);
        use base64::Engine;
        assert_eq!(challenge, expected, "challenge must be base64url(sha256(verifier))");
        assert!(!challenge.contains('='), "no padding");
        assert!(!challenge.contains('+') && !challenge.contains('/'), "url-safe alphabet");
    }

    #[test]
    fn pkce_pairs_are_unique() {
        let (a, _) = pkce_pair();
        let (b, _) = pkce_pair();
        assert_ne!(a, b, "verifiers must be random");
    }

    #[test]
    fn auth_url_has_required_params() {
        let url = auth_url("CID.apps.googleusercontent.com", "http://127.0.0.1:5599/cb", "CHAL", "STATE");
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("client_id=CID.apps.googleusercontent.com"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        // redirect + scope are percent-encoded
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5599%2Fcb"));
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events"));
    }
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function pkce_pair` / `auth_url` (compile error).

- [ ] **Step 5: Implement the helpers**

At the TOP of `src-tauri/src/gcal.rs` (above the test module), add:

```rust
// Google Calendar OAuth (desktop, PKCE loopback) + Keychain token storage.
// Desktop (macOS) only in this plan; iOS is a separate plan.
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";

/// (verifier, challenge). verifier is 64 url-safe chars; challenge is
/// base64url(sha256(verifier)) with no padding (PKCE "S256").
pub fn pkce_pair() -> (String, String) {
    let mut raw = [0u8; 48];
    getrandom::getrandom(&mut raw).expect("getrandom");
    // 48 bytes → 64 url-safe base64 chars (no padding).
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

/// Build the Google authorization-code consent URL (PKCE S256, offline access).
pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_ENDPOINT}?response_type=code&client_id={cid}&redirect_uri={ru}\
         &scope={scope}&code_challenge={chal}&code_challenge_method=S256\
         &state={state}&access_type=offline&prompt=consent",
        cid = enc(client_id),
        ru = enc(redirect_uri),
        scope = enc(SCOPE),
        chal = enc(challenge),
        state = enc(state),
    )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/gcal.rs
git commit -m "feat: gcal PKCE + authorization-url helpers (desktop OAuth)"
```

---

### Task 3: Token-response parsing (Rust, cargo-TDD)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (add a `TokenResponse` struct + parser; extend the test module)

**Interfaces:**
- Produces: `pub struct TokenResponse { pub access_token: String, pub refresh_token: Option<String>, pub expires_in: i64 }` and `pub fn parse_token_response(body: &str) -> Result<TokenResponse, String>` — parses Google's token JSON; returns a clear error string on malformed input or an OAuth `error` field.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `src-tauri/src/gcal.rs`:

```rust
    #[test]
    fn parse_token_response_ok() {
        let body = r#"{"access_token":"ya29.abc","expires_in":3599,"refresh_token":"1//rt","scope":"x","token_type":"Bearer"}"#;
        let t = parse_token_response(body).expect("ok");
        assert_eq!(t.access_token, "ya29.abc");
        assert_eq!(t.refresh_token.as_deref(), Some("1//rt"));
        assert_eq!(t.expires_in, 3599);
    }

    #[test]
    fn parse_token_response_no_refresh() {
        // Refresh endpoint responses omit refresh_token.
        let body = r#"{"access_token":"ya29.def","expires_in":3599,"token_type":"Bearer"}"#;
        let t = parse_token_response(body).expect("ok");
        assert_eq!(t.refresh_token, None);
    }

    #[test]
    fn parse_token_response_error() {
        let body = r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#;
        let err = parse_token_response(body).unwrap_err();
        assert!(err.contains("invalid_grant"), "surfaces the OAuth error: {err}");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function parse_token_response`.

- [ ] **Step 3: Implement the parser**

Add to `src-tauri/src/gcal.rs` (above the test module):

```rust
#[derive(Debug, Clone)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

/// Parse Google's token endpoint JSON. Returns the OAuth error verbatim when
/// the response carries an `error` field (e.g. invalid_grant on a revoked
/// refresh token), so callers can surface "reconnect" to the user.
pub fn parse_token_response(body: &str) -> Result<TokenResponse, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("token json: {e}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let desc = v.get("error_description").and_then(|d| d.as_str()).unwrap_or("");
        return Err(format!("oauth error: {err} {desc}").trim().to_string());
    }
    let access_token = v.get("access_token").and_then(|a| a.as_str())
        .ok_or("token response missing access_token")?.to_string();
    let refresh_token = v.get("refresh_token").and_then(|r| r.as_str()).map(|s| s.to_string());
    let expires_in = v.get("expires_in").and_then(|e| e.as_i64()).unwrap_or(3600);
    Ok(TokenResponse { access_token, refresh_token, expires_in })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: all gcal tests pass (now 6).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/gcal.rs
git commit -m "feat: gcal token-response parser"
```

---

### Task 4: Account config + Keychain storage (Rust)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `keyring`)
- Modify: `src-tauri/src/gcal.rs` (config read/write + keychain helpers; extend tests for config only)

**Interfaces:**
- Produces:
  - `pub struct AccountsConfig { pub accounts: Vec<String>, pub default: Option<String>, pub client_id: String, pub client_secret: String }` (serde) with `pub fn load_config(dir: &std::path::Path) -> AccountsConfig` (missing file → empty default) and `pub fn save_config(dir: &std::path::Path, cfg: &AccountsConfig) -> Result<(), String>` writing `<dir>/gcal-accounts.json`.
  - `pub fn store_refresh_token(email: &str, token: &str) -> Result<(), String>`, `pub fn load_refresh_token(email: &str) -> Result<String, String>`, `pub fn delete_refresh_token(email: &str) -> Result<(), String>` — all via the macOS Keychain (`keyring`), service `"com.geetduggal.order.gcal"`, account = email.

- [ ] **Step 1: Add the keyring dependency**

In `src-tauri/Cargo.toml` `[dependencies]`, add:

```toml
keyring = "2"
```

- [ ] **Step 2: Write the failing config test**

Add to the `mod tests` block:

```rust
    #[test]
    fn config_round_trips_via_disk() {
        let dir = std::env::temp_dir().join(format!("order-gcal-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Missing file → empty default.
        let empty = load_config(&dir);
        assert!(empty.accounts.is_empty() && empty.default.is_none());
        // Save then load.
        let cfg = AccountsConfig {
            accounts: vec!["a@x.com".into(), "b@y.com".into()],
            default: Some("a@x.com".into()),
            client_id: "CID".into(),
            client_secret: "SEC".into(),
        };
        save_config(&dir, &cfg).unwrap();
        let back = load_config(&dir);
        assert_eq!(back.accounts, vec!["a@x.com".to_string(), "b@y.com".to_string()]);
        assert_eq!(back.default.as_deref(), Some("a@x.com"));
        assert_eq!(back.client_id, "CID");
        std::fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find type AccountsConfig` / `load_config`.

- [ ] **Step 4: Implement config + keychain**

Add to `src-tauri/src/gcal.rs` (above the test module). Add `use serde::{Deserialize, Serialize};` to the top `use` block.

```rust
const KEYRING_SERVICE: &str = "com.geetduggal.order.gcal";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountsConfig {
    #[serde(default)]
    pub accounts: Vec<String>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
}

fn config_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("gcal-accounts.json")
}

/// Load the accounts config; a missing/invalid file yields an empty default
/// (so first run just works).
pub fn load_config(dir: &std::path::Path) -> AccountsConfig {
    match std::fs::read_to_string(config_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AccountsConfig::default(),
    }
}

pub fn save_config(dir: &std::path::Path, cfg: &AccountsConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    std::fs::write(config_path(dir), s).map_err(|e| format!("config write: {e}"))
}

pub fn store_refresh_token(email: &str, token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, email)
        .and_then(|e| e.set_password(token))
        .map_err(|e| format!("keychain store: {e}"))
}

pub fn load_refresh_token(email: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, email)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("keychain load: {e}"))
}

pub fn delete_refresh_token(email: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, email)
        .and_then(|e| e.delete_password())
        .map_err(|e| format!("keychain delete: {e}"))
}
```

- [ ] **Step 5: Run the config test to verify it passes**

Run: `cd src-tauri && cargo test gcal::tests::config_round_trips_via_disk 2>&1 | tail -20`
Expected: PASS. (The keychain functions are exercised live in Task 5; not unit-tested here to avoid touching the real Keychain in CI.)

- [ ] **Step 6: Build-check + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -5` → compiles (warnings OK).

```bash
git add src-tauri/Cargo.toml src-tauri/src/gcal.rs
git commit -m "feat: gcal accounts config + Keychain token storage"
```

---

### Task 5: Loopback OAuth flow + token helpers + connect command (Rust)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (loopback flow, token exchange/refresh over `ureq`, `gcal_connect_account` command)
- Modify: `src-tauri/src/lib.rs:105+` (register `gcal::gcal_connect_account` in `generate_handler!`)

**Interfaces:**
- Consumes: `pkce_pair`, `auth_url`, `parse_token_response`, config + keychain helpers.
- Produces: Tauri command `gcal_connect_account(app: tauri::AppHandle) -> Result<String, String>` — runs the full flow and returns the connected account email; and `pub fn fetch_access_token(cfg: &AccountsConfig, email: &str) -> Result<String, String>` (refreshes via the stored refresh token), used by Plans 3–4.

- [ ] **Step 1: Implement the loopback flow + commands**

Add to `src-tauri/src/gcal.rs` (above the test module). Add `use std::io::{Read, Write};` and `use std::net::TcpListener;` to the top `use` block.

```rust
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://openidconnect.googleapis.com/v1/userinfo";

fn agent() -> ureq::Agent {
    let connector = native_tls::TlsConnector::new().expect("tls");
    ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .build()
}

/// Bind a throwaway loopback listener, return (listener, redirect_uri).
fn bind_loopback() -> Result<(TcpListener, String), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("addr: {e}"))?.port();
    Ok((listener, format!("http://127.0.0.1:{port}/cb")))
}

/// Block until the browser redirects back, then return the `code` query param.
/// Serves a tiny "you can close this tab" page. Validates `state`.
fn await_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    let (mut stream, _) = listener.accept().map_err(|e| format!("accept: {e}"))?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).map_err(|e| format!("read: {e}"))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    // First line: `GET /cb?code=...&state=... HTTP/1.1`
    let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for kv in query.split('&') {
        let mut it = kv.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => code = Some(v.to_string()),
            (Some("state"), Some(v)) => state = Some(v.to_string()),
            _ => {}
        }
    }
    let body = "<html><body style='font-family:sans-serif'>Order is connected. You can close this tab.</body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type:text/html\r\nContent-Length:{}\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes());
    if state.as_deref() != Some(expected_state) {
        return Err("oauth state mismatch (possible CSRF) — aborted".into());
    }
    code.ok_or_else(|| "no authorization code in redirect".into())
}

fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let resp = agent().post(TOKEN_ENDPOINT).send_form(form);
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("token body: {e}"))?,
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(e) => return Err(format!("token transport: {e}")),
    };
    parse_token_response(&body)
}

/// Exchange an auth code for tokens (PKCE).
fn exchange_code(cfg: &AccountsConfig, code: &str, verifier: &str, redirect_uri: &str) -> Result<TokenResponse, String> {
    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ])
}

/// Refresh an access token from the stored refresh token. Used by push/import.
pub fn fetch_access_token(cfg: &AccountsConfig, email: &str) -> Result<String, String> {
    let refresh = load_refresh_token(email)?;
    let t = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
    ])?;
    Ok(t.access_token)
}

/// Fetch the account's email via the userinfo endpoint (so we key tokens by
/// the real account, not user input).
fn fetch_email(access_token: &str) -> Result<String, String> {
    let resp = agent().get(USERINFO_ENDPOINT)
        .set("Authorization", &format!("Bearer {access_token}"))
        .call();
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("userinfo body: {e}"))?,
        Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(e) => return Err(format!("userinfo transport: {e}")),
    };
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("userinfo json: {e}"))?;
    v.get("email").and_then(|e| e.as_str()).map(|s| s.to_lowercase())
        .ok_or_else(|| "userinfo had no email".into())
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_config_dir().map_err(|e| format!("config dir: {e}"))
}

/// Run the full desktop OAuth flow: build PKCE, open the browser, capture the
/// code on a loopback listener, exchange it, store the refresh token in the
/// Keychain, and register the account in config. Returns the account email.
#[tauri::command]
pub async fn gcal_connect_account(app: tauri::AppHandle) -> Result<String, String> {
    let dir = config_dir(&app)?;
    let cfg = load_config(&dir);
    if cfg.client_id.is_empty() || cfg.client_secret.is_empty() {
        return Err("Set your Google OAuth Client ID and Secret in Settings first.".into());
    }
    let (listener, redirect_uri) = bind_loopback()?;
    let (verifier, challenge) = pkce_pair();
    let state = {
        let (s, _) = pkce_pair();
        s
    };
    let url = auth_url(&cfg.client_id, &redirect_uri, &challenge, &state);
    tauri::async_runtime::spawn_blocking({
        let url = url.clone();
        move || { let _ = open::that(url); }
    });
    // Block on the loopback accept in a blocking task.
    let code = tauri::async_runtime::spawn_blocking(move || await_code(&listener, &state))
        .await.map_err(|e| format!("join: {e}"))??;
    let tokens = exchange_code(&cfg, &code, &verifier, &redirect_uri)?;
    let refresh = tokens.refresh_token.clone()
        .ok_or("Google returned no refresh token — revoke Order's access in your Google account and reconnect.")?;
    let email = fetch_email(&tokens.access_token)?;
    store_refresh_token(&email, &refresh)?;
    let mut cfg = load_config(&dir);
    if !cfg.accounts.iter().any(|a| a == &email) {
        cfg.accounts.push(email.clone());
    }
    if cfg.default.is_none() {
        cfg.default = Some(email.clone());
    }
    save_config(&dir, &cfg)?;
    Ok(email)
}
```

- [ ] **Step 2: Add the `open` dependency for launching the browser**

In `src-tauri/Cargo.toml` `[dependencies]`, add:

```toml
open = "5"
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, inside `generate_handler![ ... ]` (after `publish::publish_site,` ~line 138), add:

```rust
            gcal::gcal_connect_account,
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo build 2>&1 | tail -8`
Expected: compiles (warnings OK). Fix any compile error before proceeding.

- [ ] **Step 5: Manual live verification (REQUIRES Task 1 credentials)**

This flow cannot be unit-tested (it opens a browser + calls Google). Verify manually once Task 7's Settings UI exists, OR temporarily via a scratch button. Defer the actual click-through to Task 7's verification. For now, confirm the build is clean and the command is registered.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/gcal.rs src-tauri/src/lib.rs
git commit -m "feat: gcal desktop loopback OAuth flow + connect command"
```

---

### Task 6: Account-management commands + TS bridge (Rust + TS)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (commands: list, set-default, disconnect, set-credentials)
- Modify: `src-tauri/src/lib.rs` (register the new commands)
- Create: `src/lib/gcal-accounts.ts`

**Interfaces:**
- Produces (Rust commands): `gcal_list_accounts(app) -> Result<AccountsView, String>` where `AccountsView { accounts: Vec<String>, default: Option<String>, has_credentials: bool }`; `gcal_set_default(app, email) -> Result<(), String>`; `gcal_disconnect(app, email) -> Result<(), String>` (removes from config + deletes the Keychain token); `gcal_set_credentials(app, client_id, client_secret) -> Result<(), String>`.
- Produces (TS): `src/lib/gcal-accounts.ts` exporting `listAccounts()`, `connectAccount()`, `setDefault(email)`, `disconnect(email)`, `setCredentials(id, secret)` — thin `invoke` wrappers, and the `AccountsView` type.

- [ ] **Step 1: Implement the management commands (Rust)**

Add to `src-tauri/src/gcal.rs` (above the test module):

```rust
#[derive(Debug, Clone, Serialize)]
pub struct AccountsView {
    pub accounts: Vec<String>,
    pub default: Option<String>,
    pub has_credentials: bool,
}

#[tauri::command]
pub async fn gcal_list_accounts(app: tauri::AppHandle) -> Result<AccountsView, String> {
    let cfg = load_config(&config_dir(&app)?);
    Ok(AccountsView {
        accounts: cfg.accounts,
        default: cfg.default,
        has_credentials: !cfg.client_id.is_empty() && !cfg.client_secret.is_empty(),
    })
}

#[tauri::command]
pub async fn gcal_set_default(app: tauri::AppHandle, email: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    if !cfg.accounts.iter().any(|a| a == &email) {
        return Err(format!("{email} is not a connected account"));
    }
    cfg.default = Some(email);
    save_config(&dir, &cfg)
}

#[tauri::command]
pub async fn gcal_disconnect(app: tauri::AppHandle, email: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    cfg.accounts.retain(|a| a != &email);
    if cfg.default.as_deref() == Some(email.as_str()) {
        cfg.default = cfg.accounts.first().cloned();
    }
    let _ = delete_refresh_token(&email); // best-effort; token may already be gone
    save_config(&dir, &cfg)
}

#[tauri::command]
pub async fn gcal_set_credentials(app: tauri::AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    cfg.client_id = client_id.trim().to_string();
    cfg.client_secret = client_secret.trim().to_string();
    save_config(&dir, &cfg)
}
```

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs` `generate_handler!`, after `gcal::gcal_connect_account,`, add:

```rust
            gcal::gcal_list_accounts,
            gcal::gcal_set_default,
            gcal::gcal_disconnect,
            gcal::gcal_set_credentials,
```

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo build 2>&1 | tail -6` → compiles.

- [ ] **Step 4: Create the TS bridge**

Create `src/lib/gcal-accounts.ts`:

```ts
// Thin bridge to the Rust gcal account commands (desktop OAuth, Plan 2).
import { invoke } from "@tauri-apps/api/core";

export interface AccountsView {
  accounts: string[];
  default: string | null;
  has_credentials: boolean;
}

export const listAccounts = () => invoke<AccountsView>("gcal_list_accounts");
export const connectAccount = () => invoke<string>("gcal_connect_account");
export const setDefault = (email: string) => invoke<void>("gcal_set_default", { email });
export const disconnect = (email: string) => invoke<void>("gcal_disconnect", { email });
export const setCredentials = (clientId: string, clientSecret: string) =>
  invoke<void>("gcal_set_credentials", { clientId, clientSecret });
```

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src-tauri/src/gcal.rs src-tauri/src/lib.rs src/lib/gcal-accounts.ts
git commit -m "feat: gcal account-management commands + TS bridge"
```

---

### Task 7: Settings — Google Accounts section (React)

**Files:**
- Modify: `src/components/SettingsPanel.tsx` (add a Google Accounts `settings-row` after the Todo.txt row ~line 168)

**Interfaces:**
- Consumes: `src/lib/gcal-accounts.ts` (`listAccounts`, `connectAccount`, `setDefault`, `disconnect`, `setCredentials`, `AccountsView`).

- [ ] **Step 1: Add state + load on mount**

Near the other `useState` hooks in `SettingsPanel`, add:

```tsx
  const [gcal, setGcal] = useState<import("../lib/gcal-accounts").AccountsView>({ accounts: [], default: null, has_credentials: false });
  const [gcalId, setGcalId] = useState("");
  const [gcalSecret, setGcalSecret] = useState("");
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const refreshGcal = useCallback(async () => {
    try { setGcal(await import("../lib/gcal-accounts").then((m) => m.listAccounts())); }
    catch (e) { setGcalError(String(e)); }
  }, []);
  useEffect(() => { void refreshGcal(); }, [refreshGcal]);
```

(If `useCallback`/`useEffect`/`useState` aren't imported in this file, add them to the existing `react` import.)

- [ ] **Step 2: Add the Settings row**

After the Todo.txt `</div>` that closes its `settings-row` (~line 168, just before the final `</div>` that closes the settings body), insert:

```tsx
        <div className="settings-row">
          <span className="settings-label">Google Calendar</span>
          {gcalError && <span className="settings-hint" style={{ color: "#d9534f" }}>{gcalError}</span>}
          <span className="settings-value">
            <input type="text" className="settings-input" placeholder="OAuth Client ID"
              value={gcalId} onChange={(e) => setGcalId(e.target.value)} />
            <input type="password" className="settings-input" placeholder="OAuth Client Secret"
              value={gcalSecret} onChange={(e) => setGcalSecret(e.target.value)} />
            <button type="button" className="settings-btn" disabled={gcalBusy || !gcalId || !gcalSecret}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.setCredentials(gcalId, gcalSecret); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>Save credentials</button>
          </span>
          <span className="settings-value">
            <button type="button" className="settings-btn" disabled={gcalBusy || !gcal.has_credentials}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.connectAccount(); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>{gcalBusy ? "Connecting…" : "Connect Google account"}</button>
          </span>
          <ul className="gcal-account-list">
            {gcal.accounts.map((a) => (
              <li key={a} className="gcal-account-row">
                <label className="settings-toggle">
                  <input type="radio" name="gcal-default" checked={gcal.default === a}
                    onChange={async () => { const m = await import("../lib/gcal-accounts"); await m.setDefault(a); await refreshGcal(); }} />
                  <span>{a}{gcal.default === a ? " (default)" : ""}</span>
                </label>
                <button type="button" className="settings-btn is-danger"
                  onClick={async () => { const m = await import("../lib/gcal-accounts"); await m.disconnect(a); await refreshGcal(); }}>Disconnect</button>
              </li>
            ))}
          </ul>
          <span className="settings-hint">
            Connect a Google account to sync curated events. Credentials come from your own
            Google Cloud project (OAuth "Desktop app" client). The default account hosts
            events that don't name one. Desktop only for now.
          </span>
        </div>
```

- [ ] **Step 3: Add minimal styles**

Append to `src/styles.css`:

```css
.gcal-account-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.gcal-account-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

- [ ] **Step 5: Manual live verification (REQUIRES Task 1 credentials)**

`pnpm tauri dev`, open Settings → Google Calendar:
1. Paste Client ID + Secret → Save credentials → "Connect Google account" enables.
2. Connect → browser opens Google consent → approve → tab shows "Order is connected" → the account appears in the list, marked default.
3. Connect a second account → both listed; switch default via the radio.
4. Disconnect → it leaves the list (and its Keychain token is removed).
5. Confirm `<app-config-dir>/gcal-accounts.json` has the accounts/default/credentials and that no token is in it (tokens are in Keychain).

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx src/styles.css
git commit -m "feat: Settings — Google Accounts section (connect/list/default/disconnect)"
```

---

## Self-review notes
- Spec coverage: this plan implements the spec's "OAuth & authentication" (desktop loopback + PKCE + Keychain + `calendar.events` scope) and "Settings UI" (Google Accounts section). `fetch_access_token` is the seam Plans 3–4 consume. iOS deep-link, push, and import are out of scope here (later plans).
- Unit-tested (cargo): PKCE, auth-URL, token-response parse, config round-trip. Manually verified: the live browser flow + Keychain (Tasks 5/7) — they require the user's Google credentials and can't run in CI.
- The OAuth client secret for a Desktop client is non-confidential per Google's installed-app model; storing it in the app config dir (not the vault) is intentional and documented.

## Notes for the implementer
- Tasks 2–4 are pure/cargo-testable and can be implemented and reviewed without any Google account. Tasks 5–7 add the live flow; their click-through verification needs Task 1's credentials, so coordinate with the user for that step.
- Keep `fetch_access_token`, `AccountsConfig`, `AccountsView`, and the command names exactly as written — Plans 3–4 and the TS bridge depend on them.
- Do not add iOS code. Do not write tokens anywhere but the Keychain.
