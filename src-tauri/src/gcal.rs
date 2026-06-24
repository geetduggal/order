// Google Calendar OAuth (desktop, PKCE loopback) + Keychain token storage.
// Desktop (macOS) only in this plan; iOS is a separate plan.
use base64::Engine;
use chrono::{Local, LocalResult, NaiveDate, NaiveTime, TimeZone};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
// `openid email` lets us read the account's email (userinfo) to key the
// connection; `calendar.events` is the actual data scope.
const SCOPE: &str = "openid email https://www.googleapis.com/auth/calendar.events";

// Percent-encode query-value characters that are not unreserved (RFC 3986).
// Unreserved chars (never encoded): A-Z a-z 0-9 - . _ ~
// We encode everything else that could appear in URLs/scopes: : / ? # [ ] @ ! $ & ' ( ) * + , ; = space %
const QUERY_VALUE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'/')
    .add(b':')
    .add(b'?')
    .add(b'@')
    .add(b'!')
    .add(b'$')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b';')
    .add(b'=');

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
    utf8_percent_encode(s, QUERY_VALUE).to_string()
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
    // Finding 3: non-blocking accept with a 5-minute deadline.
    listener.set_nonblocking(true).map_err(|e| format!("nonblocking: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for Google authorization (closed the browser?)".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("accept: {e}")),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();

    // Finding 4: enlarged buffer (4096 → 8192) to avoid truncation.
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| format!("read: {e}"))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    // First line: `GET /cb?code=...&state=... HTTP/1.1`
    let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");

    // Finding 2: percent-decode each parsed value.
    let decode = |v: &str| percent_decode_str(v).decode_utf8_lossy().into_owned();

    let mut code = None;
    let mut state = None;
    for kv in query.split('&') {
        let mut it = kv.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => code = Some(decode(v)),
            (Some("state"), Some(v)) => state = Some(decode(v)),
            _ => {}
        }
    }

    // Finding 1: validate state BEFORE serving the HTTP response.
    if state.as_deref() != Some(expected_state) {
        let err_body = "<html><body style='font-family:sans-serif'>Authorization failed: state mismatch. Please try again.</body></html>";
        let err_resp = format!("HTTP/1.1 400 Bad Request\r\nContent-Type:text/html\r\nContent-Length:{}\r\n\r\n{}", err_body.len(), err_body);
        let _ = stream.write_all(err_resp.as_bytes());
        return Err("oauth state mismatch (possible CSRF) — aborted".into());
    }

    let body = "<html><body style='font-family:sans-serif'>Order is connected. You can close this tab.</body></html>";
    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type:text/html\r\nContent-Length:{}\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(resp.as_bytes());

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

#[derive(Debug, Clone, Serialize)]
pub struct AccountsView {
    pub accounts: Vec<String>,
    pub default: Option<String>,
    pub has_credentials: bool,
    /// The saved OAuth client ID (non-secret) so Settings can reflect it.
    /// The client secret is never returned.
    pub client_id: String,
}

#[tauri::command]
pub async fn gcal_list_accounts(app: tauri::AppHandle) -> Result<AccountsView, String> {
    let cfg = load_config(&config_dir(&app)?);
    Ok(AccountsView {
        has_credentials: !cfg.client_id.is_empty() && !cfg.client_secret.is_empty(),
        client_id: cfg.client_id,
        accounts: cfg.accounts,
        default: cfg.default,
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

#[derive(Debug, Clone)]
pub enum EventTime {
    AllDay { date: String },
    Timed { date_time: String },
}

fn event_time_json(t: &EventTime) -> serde_json::Value {
    match t {
        EventTime::AllDay { date } => serde_json::json!({ "date": date }),
        EventTime::Timed { date_time } => serde_json::json!({ "dateTime": date_time }),
    }
}

/// Build an events.insert/patch request body.
pub fn event_json(
    summary: &str,
    description: &str,
    start: &EventTime,
    end: &EventTime,
    attendees: &[String],
) -> serde_json::Value {
    let attendee_objs: Vec<serde_json::Value> =
        attendees.iter().map(|e| serde_json::json!({ "email": e })).collect();
    serde_json::json!({
        "summary": summary,
        "description": description,
        "start": event_time_json(start),
        "end": event_time_json(end),
        "attendees": attendee_objs,
    })
}

/// Find a Google event id in an events.list response by natural key. `summary`
/// must equal the event title; the start `date` must match `start_date`; when
/// `start_time` is given, the timed start's HH:MM must match too.
pub fn find_event_id(
    list_body: &str,
    summary: &str,
    start_date: &str,
    start_time: Option<&str>,
) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(list_body).ok()?;
    let items = v.get("items")?.as_array()?;
    for it in items {
        if it.get("summary").and_then(|s| s.as_str()) != Some(summary) {
            continue;
        }
        let Some(start) = it.get("start") else { continue };
        match start_time {
            None => {
                if start.get("date").and_then(|d| d.as_str()) == Some(start_date) {
                    return it.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                }
            }
            Some(hhmm) => {
                if let Some(dt) = start.get("dateTime").and_then(|d| d.as_str()) {
                    // dt like "2026-06-25T14:00:00-07:00"
                    if dt.starts_with(start_date) && dt.get(11..16) == Some(hhmm) {
                        return it.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                    }
                }
            }
        }
    }
    None
}

const CAL_BASE: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/// Format a local date+time as an RFC3339 string with the correct local offset
/// for that date (handles DST), e.g. "2026-06-25T14:00:00-07:00".
fn local_rfc3339(date: &str, hhmm: &str) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| format!("date: {e}"))?;
    let t = NaiveTime::parse_from_str(hhmm, "%H:%M").map_err(|e| format!("time: {e}"))?;
    let naive = d.and_time(t);
    let dt = match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(_, _) => return Err(format!("ambiguous local time (DST overlap): {date} {hhmm}")),
        LocalResult::None => return Err(format!("local time does not exist (DST gap): {date} {hhmm}")),
    };
    Ok(dt.to_rfc3339())
}

/// Add one day to an ISO date (exclusive end for all-day events).
fn next_day(date: &str) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| format!("date: {e}"))?;
    Ok((d + chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushEventInput {
    pub host: String,
    pub date: String,
    pub time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub title: String,
    pub description: String,
    pub attendees: Vec<String>,
}

fn cal_get(token: &str, url: &str) -> Result<(u16, String), String> {
    let resp = agent().get(url).set("Authorization", &format!("Bearer {token}")).call();
    match resp {
        Ok(r) => Ok((r.status(), r.into_string().map_err(|e| format!("body: {e}"))?)),
        Err(ureq::Error::Status(s, r)) => Ok((s, r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("transport: {e}")),
    }
}

fn cal_send(token: &str, method: &str, url: &str, body: &serde_json::Value) -> Result<(u16, String), String> {
    let req = agent().request(method, url).set("Authorization", &format!("Bearer {token}"));
    let resp = req.send_json(body.clone());
    match resp {
        Ok(r) => Ok((r.status(), r.into_string().map_err(|e| format!("body: {e}"))?)),
        Err(ureq::Error::Status(s, r)) => Ok((s, r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("transport: {e}")),
    }
}

/// Push one curated event to the host account's primary calendar: find an
/// existing match by natural key, then insert (create) or patch (update), with
/// sendUpdates=all so invitees are notified. Returns "created" or "updated".
#[tauri::command]
pub async fn gcal_push_event(app: tauri::AppHandle, input: PushEventInput) -> Result<String, String> {
    let cfg = load_config(&config_dir(&app)?);
    let token = fetch_access_token(&cfg, &input.host)?;

    let (start, end) = if input.all_day {
        (EventTime::AllDay { date: input.date.clone() },
         EventTime::AllDay { date: next_day(&input.date)? })
    } else {
        let t = input.time.as_deref().ok_or("timed event missing time")?;
        let et = input.end_time.as_deref().unwrap_or(t);
        (EventTime::Timed { date_time: local_rfc3339(&input.date, t)? },
         EventTime::Timed { date_time: local_rfc3339(&input.date, et)? })
    };
    let body = event_json(&input.title, &input.description, &start, &end, &input.attendees);

    // List the day to find an existing natural-key match.
    let (tmin, tmax) = (local_rfc3339(&input.date, "00:00")?, local_rfc3339(&next_day(&input.date)?, "00:00")?);
    let list_url = format!(
        "{CAL_BASE}?singleEvents=true&timeMin={}&timeMax={}",
        enc(&tmin), enc(&tmax)
    );
    let (ls, lb) = cal_get(&token, &list_url)?;
    if ls >= 400 {
        return Err(format!("calendar list failed ({ls}): {lb}"));
    }
    let existing = find_event_id(&lb, &input.title, &input.date, input.time.as_deref());

    let (method, url, action) = match &existing {
        Some(id) => ("PATCH".to_string(), format!("{CAL_BASE}/{id}?sendUpdates=all", id = enc(id)), "updated"),
        None => ("POST".to_string(), format!("{CAL_BASE}?sendUpdates=all"), "created"),
    };
    let (ws, wb) = cal_send(&token, &method, &url, &body)?;
    if ws >= 400 {
        return Err(format!("calendar {action} failed ({ws}): {wb}"));
    }
    Ok(action.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]  // end_time→endTime, all_day→allDay for the TS bridge
pub struct ImportedEvent {
    pub title: String,
    pub date: String,
    pub time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub description: String,
}

/// Map a Calendar events.list response into normalized ImportedEvents. Takes
/// the wall-clock date + HH:MM straight from the returned dateTime (which is in
/// the calendar's timezone). Items without a usable start are skipped.
pub fn parse_day_events(list_body: &str) -> Vec<ImportedEvent> {
    let v: serde_json::Value = match serde_json::from_str(list_body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match v.get("items").and_then(|i| i.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for it in items {
        let title = it.get("summary").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let description = it.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
        let start = match it.get("start") { Some(s) => s, None => continue };
        let hhmm = |obj: &serde_json::Value, key: &str| -> Option<String> {
            obj.get(key).and_then(|d| d.as_str()).and_then(|dt| dt.get(11..16).map(|s| s.to_string()))
        };
        if let Some(date) = start.get("date").and_then(|d| d.as_str()) {
            out.push(ImportedEvent { title, date: date.to_string(), time: None, end_time: None, all_day: true, description });
        } else if let Some(dt) = start.get("dateTime").and_then(|d| d.as_str()) {
            let date = dt.get(0..10).unwrap_or("").to_string();
            if date.is_empty() { continue; }
            let time = dt.get(11..16).map(|s| s.to_string());
            let end_time = it.get("end").and_then(|e| hhmm(e, "dateTime"));
            out.push(ImportedEvent { title, date, time, end_time, all_day: false, description });
        }
    }
    out
}

#[tauri::command]
pub async fn gcal_list_day_events(app: tauri::AppHandle, account: String, date: String) -> Result<Vec<ImportedEvent>, String> {
    let cfg = load_config(&config_dir(&app)?);
    let token = fetch_access_token(&cfg, &account)?;
    let tmin = local_rfc3339(&date, "00:00")?;
    let tmax = local_rfc3339(&next_day(&date)?, "00:00")?;
    let url = format!(
        "{CAL_BASE}?singleEvents=true&orderBy=startTime&timeMin={}&timeMax={}",
        enc(&tmin), enc(&tmax)
    );
    let (s, b) = cal_get(&token, &url)?;
    if s >= 400 {
        return Err(format!("calendar list failed ({s}): {b}"));
    }
    Ok(parse_day_events(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_day_events_mixed() {
        let body = r#"{"items":[
          {"summary":"Standup","start":{"dateTime":"2026-06-25T09:00:00-07:00"},"end":{"dateTime":"2026-06-25T09:15:00-07:00"},"description":"daily"},
          {"summary":"Holiday","start":{"date":"2026-06-25"},"end":{"date":"2026-06-26"}},
          {"start":{"dateTime":"2026-06-25T12:00:00-07:00"}}
        ]}"#;
        let v = parse_day_events(body);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].title, "Standup");
        assert_eq!(v[0].date, "2026-06-25");
        assert_eq!(v[0].time.as_deref(), Some("09:00"));
        assert_eq!(v[0].end_time.as_deref(), Some("09:15"));
        assert!(!v[0].all_day);
        assert_eq!(v[0].description, "daily");
        assert_eq!(v[1].title, "Holiday");
        assert!(v[1].all_day);
        assert_eq!(v[1].date, "2026-06-25");
        assert_eq!(v[1].time, None);
        // Missing summary → empty title; still parsed (timed).
        assert_eq!(v[2].title, "");
        assert_eq!(v[2].time.as_deref(), Some("12:00"));
    }

    #[test]
    fn parse_day_events_skips_no_start() {
        let body = r#"{"items":[{"summary":"Cancelled"}]}"#;
        assert!(parse_day_events(body).is_empty());
    }

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
        assert!(url.contains("scope=openid%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events"));
    }

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

    #[test]
    fn event_json_timed_with_attendees() {
        let v = event_json(
            "Planning", "notes here",
            &EventTime::Timed { date_time: "2026-06-25T14:00:00-07:00".into() },
            &EventTime::Timed { date_time: "2026-06-25T14:30:00-07:00".into() },
            &["rohit@verkada.com".to_string(), "bob@acme.com".to_string()],
        );
        assert_eq!(v["summary"], "Planning");
        assert_eq!(v["description"], "notes here");
        assert_eq!(v["start"]["dateTime"], "2026-06-25T14:00:00-07:00");
        assert_eq!(v["end"]["dateTime"], "2026-06-25T14:30:00-07:00");
        assert_eq!(v["attendees"][0]["email"], "rohit@verkada.com");
        assert_eq!(v["attendees"][1]["email"], "bob@acme.com");
        assert!(v["start"].get("date").is_none(), "timed event has no all-day date");
    }

    #[test]
    fn event_json_all_day_no_attendees() {
        let v = event_json(
            "Holiday", "",
            &EventTime::AllDay { date: "2026-06-25".into() },
            &EventTime::AllDay { date: "2026-06-26".into() },
            &[],
        );
        assert_eq!(v["start"]["date"], "2026-06-25");
        assert_eq!(v["end"]["date"], "2026-06-26");
        assert!(v["start"].get("dateTime").is_none());
        assert!(v["attendees"].as_array().map(|a| a.is_empty()).unwrap_or(true), "no attendees");
    }

    #[test]
    fn find_event_id_matches_natural_key() {
        let body = r#"{"items":[
          {"id":"AAA","summary":"Standup","start":{"dateTime":"2026-06-25T09:00:00-07:00"}},
          {"id":"BBB","summary":"Planning","start":{"dateTime":"2026-06-25T14:00:00-07:00"}},
          {"id":"CCC","summary":"Holiday","start":{"date":"2026-06-25"}}
        ]}"#;
        assert_eq!(find_event_id(body, "Planning", "2026-06-25", Some("14:00")), Some("BBB".to_string()));
        assert_eq!(find_event_id(body, "Holiday", "2026-06-25", None), Some("CCC".to_string()));
        assert_eq!(find_event_id(body, "Standup", "2026-06-25", Some("10:00")), None, "time mismatch → no match");
        assert_eq!(find_event_id(body, "Nope", "2026-06-25", Some("09:00")), None, "title mismatch → no match");
    }

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
}
