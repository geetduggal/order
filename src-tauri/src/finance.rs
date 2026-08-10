//! OSuite Finance (built into Order for now; a separate OSuite app later — see the
//! "OSuite Principles" RFC). This Rust module is the FINANCE CORE / API: it owns
//! all the real logic — Plaid link + fetch, snapshot-CSV writing, and deterministic
//! report generation. The React UI, and later a CLI or voice-agent, are all thin
//! clients of these commands; none is privileged as "the real way" to run it.
//!
//! Principles honored here (from the RFC / MVP prompt):
//! - CSV is the atomic unit of truth. One snapshot CSV per report run (with an
//!   `account` column), never a durable per-account ledger.
//! - Secrets (Plaid client id/secret, per-account access tokens) live OUTSIDE the
//!   vault, in the app config dir — never in a note.
//! - Reports are generated, not maintained: HTML is produced fresh from the CSV.
//! - The code is the computation; AI is only the runner. All math (merchant totals,
//!   trailing-average anomalies, recurring detection) is here, deterministic, and
//!   every report records its own provenance.

use serde::{Deserialize, Serialize};
use std::path::Path;

// ---- config / secrets (outside the vault) ---------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PlaidCreds {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub secret: String,
    /// "sandbox" | "development" | "production". Sandbox by default.
    #[serde(default = "default_env")]
    pub env: String,
}
fn default_env() -> String {
    "sandbox".to_string()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LinkedAccount {
    /// Friendly name the user chose (e.g. "Amex", "Chase Checking").
    pub name: String,
    /// Plaid access token for this Item. Secret — stays in the config dir.
    pub access_token: String,
    #[serde(default)]
    pub item_id: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FinanceConfig {
    #[serde(default)]
    pub plaid: PlaidCreds,
    #[serde(default)]
    pub accounts: Vec<LinkedAccount>,
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().app_config_dir().map_err(|e| format!("config dir: {e}"))
}

/// The current vault root (where snapshot CSVs + reports are written).
fn vault_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let state = app.state::<crate::vault_fs::VaultState>();
    let guard = state.root.lock().map_err(|e| e.to_string())?;
    guard.as_ref().cloned().ok_or_else(|| "vault root not set".into())
}
fn config_path(dir: &Path) -> std::path::PathBuf {
    dir.join("finance.json")
}
pub fn load_config(dir: &Path) -> FinanceConfig {
    match std::fs::read_to_string(config_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => FinanceConfig::default(),
    }
}
pub fn save_config(dir: &Path, cfg: &FinanceConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    std::fs::write(config_path(dir), s).map_err(|e| format!("config write: {e}"))
}

// ---- Plaid REST (via ureq; no SDK, so every call is transparent) -----------

fn agent() -> ureq::Agent {
    let connector = native_tls::TlsConnector::new().expect("tls");
    ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .build()
}

fn plaid_host(env: &str) -> &'static str {
    match env {
        "production" => "https://production.plaid.com",
        "development" => "https://development.plaid.com",
        _ => "https://sandbox.plaid.com",
    }
}

/// One authenticated Plaid POST. `body` is merged with the credentials.
fn plaid_post(creds: &PlaidCreds, path: &str, mut body: serde_json::Value) -> Result<serde_json::Value, String> {
    if creds.client_id.trim().is_empty() || creds.secret.trim().is_empty() {
        return Err("Plaid client ID and secret aren't set. Add them in Settings → Finance.".into());
    }
    if let Some(obj) = body.as_object_mut() {
        obj.insert("client_id".into(), serde_json::json!(creds.client_id));
        obj.insert("secret".into(), serde_json::json!(creds.secret));
    }
    let url = format!("{}{}", plaid_host(&creds.env), path);
    match agent().post(&url).set("Content-Type", "application/json").send_json(body) {
        Ok(r) => r.into_json::<serde_json::Value>().map_err(|e| format!("plaid {path}: bad json: {e}")),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            Err(format!("Plaid {path} error {code}: {text}"))
        }
        Err(e) => Err(format!("Plaid {path}: {e}")),
    }
}

/// Create a Hosted Link token — returns (link_token, hosted_link_url). Hosted Link
/// lets us open a normal browser URL for the user to authenticate with their bank,
/// without embedding Plaid's JS SDK. We poll `/link/token/get` afterwards to pick up
/// the resulting public token.
fn create_hosted_link(creds: &PlaidCreds) -> Result<(String, String), String> {
    let user_id = format!("order-{}", chrono::Utc::now().timestamp());
    let body = serde_json::json!({
        "user": { "client_user_id": user_id },
        "client_name": "Order — OSuite Finance",
        "products": ["transactions"],
        "country_codes": ["US"],
        "language": "en",
        "hosted_link": {}
    });
    let v = plaid_post(creds, "/link/token/create", body)?;
    let link_token = v.get("link_token").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let hosted = v.get("hosted_link_url").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if link_token.is_empty() || hosted.is_empty() {
        return Err(format!("Plaid didn't return a hosted link ({v})"));
    }
    Ok((link_token, hosted))
}

/// Poll `/link/token/get` until the hosted-link session completes and yields a
/// public token, then return it. Times out after ~5 minutes.
fn await_public_token(creds: &PlaidCreds, link_token: &str) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        let v = plaid_post(creds, "/link/token/get", serde_json::json!({ "link_token": link_token }))?;
        // Hosted Link surfaces completed sessions under link_sessions[].results.
        if let Some(sessions) = v.get("link_sessions").and_then(|x| x.as_array()) {
            for s in sessions {
                if let Some(pt) = s
                    .get("results")
                    .and_then(|r| r.get("item_add_results"))
                    .and_then(|r| r.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|r| r.get("public_token"))
                    .and_then(|x| x.as_str())
                {
                    if !pt.is_empty() {
                        return Ok(pt.to_string());
                    }
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("Timed out waiting for the bank connection to finish.".into());
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
}

fn exchange_public_token(creds: &PlaidCreds, public_token: &str) -> Result<(String, String), String> {
    let v = plaid_post(creds, "/item/public_token/exchange", serde_json::json!({ "public_token": public_token }))?;
    let access = v.get("access_token").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let item = v.get("item_id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if access.is_empty() {
        return Err(format!("Plaid exchange returned no access token ({v})"));
    }
    Ok((access, item))
}

// ---- transactions ----------------------------------------------------------

/// A single transaction row — the atomic unit of truth. Mirrors the CSV schema.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Txn {
    pub date: String,
    pub merchant: String,
    /// Sign convention: POSITIVE = money out (spending), NEGATIVE = money in
    /// (deposits, payments). This matches Plaid's own convention for the amount
    /// field, so no re-signing is applied.
    pub amount: f64,
    pub account: String,
    #[serde(default)]
    pub balance: Option<f64>,
    pub plaid_transaction_id: String,
    #[serde(default)]
    pub category: String,
}

fn map_plaid_txn(t: &serde_json::Value, account: &str) -> Txn {
    let merchant = t
        .get("merchant_name")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| t.get("name").and_then(|x| x.as_str()))
        .unwrap_or("Unknown")
        .to_string();
    let category = t
        .get("personal_finance_category")
        .and_then(|c| c.get("primary"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            t.get("category")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    Txn {
        date: t.get("date").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        merchant,
        amount: t.get("amount").and_then(|x| x.as_f64()).unwrap_or(0.0),
        account: account.to_string(),
        balance: None, // per-txn running balance isn't in /transactions/get; balances are a separate endpoint.
        plaid_transaction_id: t.get("transaction_id").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        category,
    }
}

/// Fetch all transactions for one access token over [start, end] (inclusive),
/// paginating through Plaid's offset-based `/transactions/get`.
fn fetch_one(creds: &PlaidCreds, access_token: &str, account: &str, start: &str, end: &str) -> Result<Vec<Txn>, String> {
    let mut out = Vec::new();
    let mut offset = 0u64;
    loop {
        let body = serde_json::json!({
            "access_token": access_token,
            "start_date": start,
            "end_date": end,
            "options": { "count": 500, "offset": offset }
        });
        let v = plaid_post(creds, "/transactions/get", body)?;
        let total = v.get("total_transactions").and_then(|x| x.as_u64()).unwrap_or(0);
        let batch = v.get("transactions").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let got = batch.len() as u64;
        for t in &batch {
            out.push(map_plaid_txn(t, account));
        }
        offset += got;
        if got == 0 || offset >= total {
            break;
        }
    }
    Ok(out)
}

/// The shared FETCH CAPABILITY: pull transactions for the named accounts over a
/// date range. Stateless — it writes nothing itself.
pub fn fetch_transactions(cfg: &FinanceConfig, account_names: &[String], start: &str, end: &str) -> Result<Vec<Txn>, String> {
    let mut all = Vec::new();
    for name in account_names {
        let acct = cfg
            .accounts
            .iter()
            .find(|a| &a.name == name)
            .ok_or_else(|| format!("No linked account named '{name}'."))?;
        let mut rows = fetch_one(&cfg.plaid, &acct.access_token, &acct.name, start, end)?;
        all.append(&mut rows);
    }
    Ok(all)
}

// ---- CSV (parse + write) ---------------------------------------------------

pub const CSV_HEADER: &str = "date,merchant,amount,account,balance,plaid_transaction_id,category";

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn to_csv(txns: &[Txn]) -> String {
    let mut out = String::from(CSV_HEADER);
    out.push('\n');
    for t in txns {
        let bal = t.balance.map(|b| format!("{b}")).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{}\n",
            csv_escape(&t.date),
            csv_escape(&t.merchant),
            t.amount,
            csv_escape(&t.account),
            bal,
            csv_escape(&t.plaid_transaction_id),
            csv_escape(&t.category),
        ));
    }
    out
}

/// Parse one CSV line into fields, honoring RFC-4180 double-quote quoting.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            fields.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    fields.push(cur);
    fields
}

/// Parse a snapshot CSV back into rows (for report-from-existing-CSV). Tolerant of
/// hand edits: unknown columns are ignored, missing ones default.
pub fn parse_csv(text: &str) -> Vec<Txn> {
    let mut lines = text.lines();
    let header = match lines.next() {
        Some(h) => parse_csv_line(h).iter().map(|s| s.trim().to_lowercase()).collect::<Vec<_>>(),
        None => return Vec::new(),
    };
    let idx = |name: &str| header.iter().position(|h| h == name);
    let (di, mi, ai, acci, bi, ti, ci) = (
        idx("date"), idx("merchant"), idx("amount"), idx("account"),
        idx("balance"), idx("plaid_transaction_id"), idx("category"),
    );
    let mut out = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let f = parse_csv_line(line);
        let get = |i: Option<usize>| i.and_then(|i| f.get(i)).map(|s| s.to_string()).unwrap_or_default();
        out.push(Txn {
            date: get(di),
            merchant: get(mi),
            amount: get(ai).parse().unwrap_or(0.0),
            account: get(acci),
            balance: get(bi).parse().ok(),
            plaid_transaction_id: get(ti),
            category: get(ci),
        });
    }
    out
}

// ---- deterministic report core --------------------------------------------

#[derive(Serialize, Clone)]
pub struct MerchantTotal {
    pub merchant: String,
    pub account: String,
    pub total: f64,
    pub count: u32,
}

#[derive(Serialize, Clone)]
pub struct Anomaly {
    pub merchant: String,
    pub account: String,
    pub current: f64,
    pub trailing_avg: f64,
    /// current / trailing_avg (or a large sentinel for brand-new merchants).
    pub ratio: f64,
    pub is_new: bool,
}

#[derive(Serialize, Clone)]
pub struct Recurring {
    pub merchant: String,
    pub account: String,
    /// How many distinct calendar months this merchant charged in.
    pub months: u32,
    pub avg_amount: f64,
    /// True if it only first appears in the current period (a new subscription).
    pub is_new: bool,
}

#[derive(Serialize, Clone)]
pub struct Provenance {
    pub generated_at: String,
    pub script_version: String,
    pub period_start: String,
    pub period_end: String,
    pub accounts: Vec<String>,
    pub fetched_start: String,
    pub fetched_end: String,
    pub row_count: usize,
}

#[derive(Serialize, Clone)]
pub struct ReportData {
    pub by_merchant: Vec<MerchantTotal>,
    pub total_spend: f64,
    pub anomalies: Vec<Anomaly>,
    pub recurring: Vec<Recurring>,
    pub provenance: Provenance,
}

const REPORT_VERSION: &str = "finance-report/0.1.0";
const ANOMALY_RATIO: f64 = 1.5; // "running unusually hot" threshold vs trailing average.

fn month_key(date: &str) -> String {
    // "YYYY-MM-DD" -> "YYYY-MM"
    date.get(0..7).unwrap_or(date).to_string()
}

/// Build a full report from a set of rows and a target period. Deterministic and
/// Plaid-free — works on any CSV matching the schema (fetched or hand-edited). The
/// rows should span the target period PLUS enough trailing history for the baseline.
pub fn compute_report(txns: &[Txn], period_start: &str, period_end: &str, accounts: &[String]) -> ReportData {
    let spend = |t: &&Txn| t.amount > 0.0; // positive = money out
    let in_period = |t: &&Txn| t.date.as_str() >= period_start && t.date.as_str() <= period_end;

    // Current-period totals by merchant+account.
    let mut totals: std::collections::BTreeMap<(String, String), (f64, u32)> = Default::default();
    for t in txns.iter().filter(|t| spend(t)).filter(|t| in_period(t)) {
        let e = totals.entry((t.merchant.clone(), t.account.clone())).or_insert((0.0, 0));
        e.0 += t.amount;
        e.1 += 1;
    }
    let mut by_merchant: Vec<MerchantTotal> = totals
        .iter()
        .map(|((m, a), (tot, c))| MerchantTotal { merchant: m.clone(), account: a.clone(), total: round2(*tot), count: *c })
        .collect();
    by_merchant.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));
    let total_spend = round2(by_merchant.iter().map(|m| m.total).sum());

    // Trailing baseline: months strictly BEFORE the period. Average monthly spend
    // per merchant+account across the trailing months that have any data.
    let mut trailing_by_month: std::collections::BTreeMap<(String, String), std::collections::BTreeMap<String, f64>> = Default::default();
    for t in txns.iter().filter(|t| spend(t)).filter(|t| t.date.as_str() < period_start) {
        *trailing_by_month
            .entry((t.merchant.clone(), t.account.clone()))
            .or_default()
            .entry(month_key(&t.date))
            .or_insert(0.0) += t.amount;
    }
    let trailing_avg = |m: &str, a: &str| -> (f64, u32) {
        match trailing_by_month.get(&(m.to_string(), a.to_string())) {
            Some(months) if !months.is_empty() => {
                let sum: f64 = months.values().sum();
                (sum / months.len() as f64, months.len() as u32)
            }
            _ => (0.0, 0),
        }
    };

    // Anomalies: current period running hot vs trailing average, or brand new.
    let mut anomalies: Vec<Anomaly> = Vec::new();
    for m in &by_merchant {
        let (avg, months) = trailing_avg(&m.merchant, &m.account);
        let is_new = months == 0;
        let ratio = if avg > 0.0 { m.total / avg } else { f64::INFINITY };
        if (is_new && m.total >= 25.0) || (!is_new && ratio >= ANOMALY_RATIO) {
            anomalies.push(Anomaly {
                merchant: m.merchant.clone(),
                account: m.account.clone(),
                current: m.total,
                trailing_avg: round2(avg),
                ratio: if ratio.is_finite() { round2(ratio) } else { ratio },
                is_new,
            });
        }
    }
    anomalies.sort_by(|a, b| b.current.partial_cmp(&a.current).unwrap_or(std::cmp::Ordering::Equal));

    // Recurring: merchants charging across >= 2 distinct months over the WHOLE
    // fetched range. A merchant whose first-ever month is the current period is
    // flagged as a new subscription.
    let mut all_months: std::collections::BTreeMap<(String, String), std::collections::BTreeSet<String>> = Default::default();
    let mut all_amounts: std::collections::BTreeMap<(String, String), (f64, u32)> = Default::default();
    let mut first_month: std::collections::BTreeMap<(String, String), String> = Default::default();
    for t in txns.iter().filter(|t| spend(t)) {
        let key = (t.merchant.clone(), t.account.clone());
        all_months.entry(key.clone()).or_default().insert(month_key(&t.date));
        let amt = all_amounts.entry(key.clone()).or_insert((0.0, 0));
        amt.0 += t.amount;
        amt.1 += 1;
        let fm = first_month.entry(key).or_insert_with(|| month_key(&t.date));
        if month_key(&t.date) < *fm {
            *fm = month_key(&t.date);
        }
    }
    let period_month = month_key(period_start);
    let mut recurring: Vec<Recurring> = Vec::new();
    for (key, months) in &all_months {
        let is_new_sub = first_month.get(key).map(|f| f.as_str() >= period_month.as_str()).unwrap_or(false);
        if months.len() >= 2 || is_new_sub {
            let (sum, cnt) = all_amounts.get(key).copied().unwrap_or((0.0, 0));
            recurring.push(Recurring {
                merchant: key.0.clone(),
                account: key.1.clone(),
                months: months.len() as u32,
                avg_amount: if cnt > 0 { round2(sum / cnt as f64) } else { 0.0 },
                is_new: is_new_sub,
            });
        }
    }
    recurring.sort_by(|a, b| b.months.cmp(&a.months).then(b.avg_amount.partial_cmp(&a.avg_amount).unwrap_or(std::cmp::Ordering::Equal)));

    let (fetched_start, fetched_end) = txns.iter().fold((String::new(), String::new()), |(mn, mx), t| {
        let mn = if mn.is_empty() || t.date < mn { t.date.clone() } else { mn };
        let mx = if t.date > mx { t.date.clone() } else { mx };
        (mn, mx)
    });

    ReportData {
        by_merchant,
        total_spend,
        anomalies,
        recurring,
        provenance: Provenance {
            generated_at: chrono::Utc::now().to_rfc3339(),
            script_version: REPORT_VERSION.to_string(),
            period_start: period_start.to_string(),
            period_end: period_end.to_string(),
            accounts: accounts.to_vec(),
            fetched_start,
            fetched_end,
            row_count: txns.len(),
        },
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Render a self-contained HTML report from computed data. Theme-neutral, no
/// external assets, safe to open in a browser or Order's HTML viewer.
pub fn render_html(r: &ReportData) -> String {
    let money = |x: f64| format!("${:.2}", x);
    let mut rows = String::new();
    for m in &r.by_merchant {
        rows.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td class=n>{}</td><td class=n>{}</td></tr>",
            esc_html(&m.merchant), esc_html(&m.account), money(m.total), m.count
        ));
    }
    let mut anoms = String::new();
    for a in &r.anomalies {
        let note = if a.is_new { "new".to_string() } else { format!("{:.1}× avg {}", a.ratio, money(a.trailing_avg)) };
        anoms.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td class=n>{}</td><td>{}</td></tr>",
            esc_html(&a.merchant), esc_html(&a.account), money(a.current), note
        ));
    }
    if anoms.is_empty() {
        anoms = "<tr><td colspan=4 class=muted>Nothing running unusually hot.</td></tr>".into();
    }
    let mut recur = String::new();
    for rc in &r.recurring {
        let tag = if rc.is_new { " <span class=tag>new</span>" } else { "" };
        recur.push_str(&format!(
            "<tr><td>{}{}</td><td>{}</td><td class=n>{}</td><td class=n>{}</td></tr>",
            esc_html(&rc.merchant), tag, esc_html(&rc.account), rc.months, money(rc.avg_amount)
        ));
    }
    if recur.is_empty() {
        recur = "<tr><td colspan=4 class=muted>No recurring merchants detected.</td></tr>".into();
    }
    let p = &r.provenance;
    format!(
        r#"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Finance report {ps} – {pe}</title>
<style>
:root{{color-scheme:light dark}}
body{{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:820px}}
h1{{font-size:22px;margin:0 0 2px}} h2{{font-size:16px;margin:28px 0 8px}}
.sub{{opacity:.6;font-size:13px}} .total{{font-size:28px;font-weight:700;margin:12px 0}}
table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.25)}}
th{{font-size:12px;text-transform:uppercase;letter-spacing:.04em;opacity:.6}}
td.n,th.n{{text-align:right;font-variant-numeric:tabular-nums}}
.muted{{opacity:.5}} .tag{{font-size:11px;background:rgba(128,128,128,.2);padding:1px 6px;border-radius:6px}}
footer{{margin-top:32px;font-size:11px;opacity:.5;border-top:1px solid rgba(128,128,128,.2);padding-top:10px}}
</style></head><body>
<h1>Finance report</h1>
<div class=sub>{ps} to {pe} · {accts}</div>
<div class=total>{total} <span class=sub>total spend</span></div>
<h2>By merchant</h2>
<table><tr><th>Merchant</th><th>Account</th><th class=n>Spent</th><th class=n>#</th></tr>{rows}</table>
<h2>Running hot</h2>
<table><tr><th>Merchant</th><th>Account</th><th class=n>This period</th><th>vs trailing</th></tr>{anoms}</table>
<h2>Recurring / subscriptions</h2>
<table><tr><th>Merchant</th><th>Account</th><th class=n>Months</th><th class=n>Avg</th></tr>{recur}</table>
<footer>Generated {gen} by {ver} · fetched {fs}–{fe} ({rc} rows). Reproducible from the snapshot CSV beside this file.</footer>
</body></html>"#,
        ps = esc_html(&p.period_start),
        pe = esc_html(&p.period_end),
        accts = esc_html(&p.accounts.join(", ")),
        total = money(r.total_spend),
        rows = rows,
        anoms = anoms,
        recur = recur,
        gen = esc_html(&p.generated_at),
        ver = esc_html(&p.script_version),
        fs = esc_html(&p.fetched_start),
        fe = esc_html(&p.fetched_end),
        rc = p.row_count,
    )
}

// ---- commands (the "API") --------------------------------------------------

#[derive(Serialize)]
pub struct CredsStatus {
    pub configured: bool,
    pub env: String,
    pub accounts: Vec<String>,
}

/// Save Plaid credentials (kept in the config dir, outside the vault).
#[tauri::command]
pub fn finance_set_creds(app: tauri::AppHandle, client_id: String, secret: String, env: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    cfg.plaid = PlaidCreds {
        client_id: client_id.trim().to_string(),
        secret: secret.trim().to_string(),
        env: if env.trim().is_empty() { "sandbox".into() } else { env.trim().to_string() },
    };
    save_config(&dir, &cfg)
}

#[tauri::command]
pub fn finance_creds_status(app: tauri::AppHandle) -> Result<CredsStatus, String> {
    let cfg = load_config(&config_dir(&app)?);
    Ok(CredsStatus {
        configured: !cfg.plaid.client_id.trim().is_empty() && !cfg.plaid.secret.trim().is_empty(),
        env: cfg.plaid.env,
        accounts: cfg.accounts.iter().map(|a| a.name.clone()).collect(),
    })
}

#[tauri::command]
pub fn finance_accounts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load_config(&config_dir(&app)?).accounts.iter().map(|a| a.name.clone()).collect())
}

/// Link a new bank account: open Plaid Hosted Link in the browser, wait for the
/// user to finish, exchange the public token, and store the account under `name`.
#[tauri::command]
pub async fn finance_connect(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the account a name first.".into());
    }
    let dir = config_dir(&app)?;
    let cfg = load_config(&dir);
    let creds = cfg.plaid.clone();
    let (link_token, hosted_url) = tauri::async_runtime::spawn_blocking({
        let creds = creds.clone();
        move || create_hosted_link(&creds)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(hosted_url, None::<&str>).map_err(|e| format!("open browser: {e}"))?;

    let public_token = tauri::async_runtime::spawn_blocking({
        let creds = creds.clone();
        move || await_public_token(&creds, &link_token)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let (access, item) = tauri::async_runtime::spawn_blocking({
        let creds = creds.clone();
        move || exchange_public_token(&creds, &public_token)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let mut cfg2 = load_config(&dir);
    cfg2.accounts.retain(|a| a.name != name);
    cfg2.accounts.push(LinkedAccount { name: name.clone(), access_token: access, item_id: item });
    save_config(&dir, &cfg2)?;
    Ok(name)
}

/// Remove a linked account.
#[tauri::command]
pub fn finance_disconnect(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut cfg = load_config(&dir);
    cfg.accounts.retain(|a| a.name != name);
    save_config(&dir, &cfg)
}

/// Ad-hoc fetch (e.g. a voice request "pull my last month of transactions"):
/// return raw transaction rows for the given accounts + range. Writes nothing.
#[tauri::command]
pub async fn finance_fetch(app: tauri::AppHandle, accounts: Vec<String>, start: String, end: String) -> Result<Vec<Txn>, String> {
    let cfg = load_config(&config_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || fetch_transactions(&cfg, &accounts, &start, &end))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[derive(Serialize)]
pub struct ReportResult {
    pub csv_path: String,
    pub html_path: String,
    pub data: ReportData,
}

/// The REPORT CAPABILITY. Fetches the period plus ~3 months trailing baseline,
/// writes a snapshot CSV (the exact rows used) and an HTML report into `dir_rel`
/// (a vault-relative folder — the Notable Folder the user triggered it from), both
/// ISO-date-prefixed. Returns the paths and the computed data.
#[tauri::command]
pub async fn finance_report(
    app: tauri::AppHandle,
    accounts: Vec<String>,
    start: String,
    end: String,
    dir_rel: String,
) -> Result<ReportResult, String> {
    let cfg = load_config(&config_dir(&app)?);
    let root = vault_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Fetch trailing baseline (~92 days before `start`) through `end`, so the
        // deterministic report can compare the period against recent months.
        let fetch_start = trailing_start(&start, 92);
        let txns = fetch_transactions(&cfg, &accounts, &fetch_start, &end)?;
        write_report(&root, &dir_rel, &txns, &start, &end, &accounts)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Generate a report from an EXISTING snapshot CSV (no Plaid) — the report logic
/// is decoupled from fetching. `csv_rel` is vault-relative.
#[tauri::command]
pub async fn finance_report_from_csv(
    app: tauri::AppHandle,
    csv_rel: String,
    start: String,
    end: String,
    accounts: Vec<String>,
) -> Result<ReportResult, String> {
    let root = vault_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let abs = crate::agent::fs_tools::resolve_in_vault(&root, &csv_rel)?;
        let text = std::fs::read_to_string(&abs).map_err(|e| format!("read csv: {e}"))?;
        let txns = parse_csv(&text);
        let dir_rel = Path::new(&csv_rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        write_report(&root, &dir_rel, &txns, &start, &end, &accounts)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Compute + write the CSV and HTML into a vault folder, returning both paths.
fn write_report(root: &Path, dir_rel: &str, txns: &[Txn], start: &str, end: &str, accounts: &[String]) -> Result<ReportResult, String> {
    let data = compute_report(txns, start, end, accounts);
    let stamp = format!("{start}_{end}");
    let base = format!("{stamp} Finance Report");
    let csv_rel = join_rel(dir_rel, &format!("{base}.csv"));
    let html_rel = join_rel(dir_rel, &format!("{base}.html"));
    let csv_abs = crate::agent::fs_tools::resolve_in_vault(root, &csv_rel)?;
    let html_abs = crate::agent::fs_tools::resolve_in_vault(root, &html_rel)?;
    if let Some(parent) = csv_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&csv_abs, to_csv(txns)).map_err(|e| format!("write csv: {e}"))?;
    std::fs::write(&html_abs, render_html(&data)).map_err(|e| format!("write html: {e}"))?;
    Ok(ReportResult { csv_path: csv_rel, html_path: html_rel, data })
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// `date` (YYYY-MM-DD) minus `days`, as YYYY-MM-DD.
fn trailing_start(date: &str, days: i64) -> String {
    match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(d) => (d - chrono::Duration::days(days)).format("%Y-%m-%d").to_string(),
        Err(_) => date.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(date: &str, merchant: &str, amount: f64, account: &str) -> Txn {
        Txn {
            date: date.into(),
            merchant: merchant.into(),
            amount,
            account: account.into(),
            balance: None,
            plaid_transaction_id: format!("{date}-{merchant}-{amount}"),
            category: String::new(),
        }
    }

    #[test]
    fn merchant_totals_and_csv_roundtrip() {
        let txns = vec![
            t("2026-08-03", "Amazon", 40.0, "Amex"),
            t("2026-08-10", "Amazon", 60.0, "Amex"),
            t("2026-08-05", "Whole Foods", 120.0, "Amex"),
            t("2026-08-06", "Payroll", -3000.0, "Checking"), // income, excluded from spend
        ];
        let r = compute_report(&txns, "2026-08-01", "2026-08-31", &["Amex".into(), "Checking".into()]);
        assert_eq!(r.total_spend, 220.0);
        let amazon = r.by_merchant.iter().find(|m| m.merchant == "Amazon").unwrap();
        assert_eq!(amazon.total, 100.0);
        assert_eq!(amazon.count, 2);
        // CSV round-trips.
        let csv = to_csv(&txns);
        let back = parse_csv(&csv);
        assert_eq!(back.len(), 4);
        assert_eq!(back[0].merchant, "Amazon");
        assert_eq!(back[3].amount, -3000.0);
    }

    #[test]
    fn anomaly_and_recurring() {
        let mut txns = vec![
            // Trailing months: Netflix ~15/mo, Amazon ~50/mo.
            t("2026-05-02", "Netflix", 15.0, "Amex"),
            t("2026-06-02", "Netflix", 15.0, "Amex"),
            t("2026-07-02", "Netflix", 15.0, "Amex"),
            t("2026-05-10", "Amazon", 50.0, "Amex"),
            t("2026-06-10", "Amazon", 50.0, "Amex"),
            t("2026-07-10", "Amazon", 50.0, "Amex"),
        ];
        // Current period: Amazon spikes, a brand-new subscription appears.
        txns.push(t("2026-08-10", "Amazon", 200.0, "Amex"));
        txns.push(t("2026-08-02", "Netflix", 15.0, "Amex"));
        txns.push(t("2026-08-15", "NewSaaS", 99.0, "Amex"));
        let r = compute_report(&txns, "2026-08-01", "2026-08-31", &["Amex".into()]);
        // Amazon is running hot (200 vs ~50 avg).
        assert!(r.anomalies.iter().any(|a| a.merchant == "Amazon" && !a.is_new && a.ratio >= 1.5));
        // NewSaaS is a new merchant with notable spend.
        assert!(r.anomalies.iter().any(|a| a.merchant == "NewSaaS" && a.is_new));
        // Netflix is recurring across >= 2 months.
        assert!(r.recurring.iter().any(|rc| rc.merchant == "Netflix" && rc.months >= 2));
        // NewSaaS flagged as a new recurring/subscription.
        assert!(r.recurring.iter().any(|rc| rc.merchant == "NewSaaS" && rc.is_new));
    }
}
