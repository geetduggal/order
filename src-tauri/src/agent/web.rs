//! Web tools for the agent. `fetch_url` pulls a page's full readable content;
//! search is handled by Anthropic's server-side web_search tool (see provider).
//! Uses the same blocking ureq + native-tls stack as the rest — works on macOS
//! and iOS, and (like every tool) runs entirely in the Rust core.

use std::sync::{Arc, OnceLock};

const MAX_TEXT: usize = 100_000;

fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let connector = native_tls::TlsConnector::new().expect("tls");
            ureq::AgentBuilder::new()
                .tls_connector(Arc::new(connector))
                .timeout_read(std::time::Duration::from_secs(45))
                .redirects(5)
                .build()
        })
        .clone()
}

/// Fetch a web page and return its readable text (scripts/styles/tags stripped),
/// capped at ~100 KB. The whole page's content, so the agent can actually read it.
pub fn fetch_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL must start with http:// or https://".into());
    }
    match agent()
        .get(url)
        .set("User-Agent", "Mozilla/5.0 (compatible; OrderAgent/1.0)")
        .set("Accept", "text/html,application/xhtml+xml,text/plain,*/*")
        .call()
    {
        Ok(r) => {
            let ctype = r.header("Content-Type").unwrap_or("").to_ascii_lowercase();
            let body = r.into_string().map_err(|e| format!("read page: {e}"))?;
            if ctype.contains("html") || body.trim_start().starts_with('<') {
                Ok(cap(&html_to_text(&body)))
            } else {
                Ok(cap(&body))
            }
        }
        Err(ureq::Error::Status(s, r)) => {
            let snip: String = r.into_string().unwrap_or_default().chars().take(200).collect();
            Err(format!("fetch {url} → HTTP {s}: {snip}"))
        }
        Err(e) => Err(format!("fetch {url}: {e}")),
    }
}

fn cap(s: &str) -> String {
    if s.len() > MAX_TEXT {
        format!("{}\n\n[… truncated at {} KB …]", s.chars().take(MAX_TEXT).collect::<String>(), MAX_TEXT / 1000)
    } else {
        s.to_string()
    }
}

/// Very small HTML → text: drop script/style, turn block-closers into line
/// breaks, strip remaining tags, decode a few entities, tidy whitespace.
fn html_to_text(html: &str) -> String {
    let mut s = strip_block(html, "script");
    s = strip_block(&s, "style");
    s = strip_block(&s, "noscript");
    for tag in [
        "</p>", "<br>", "<br/>", "<br />", "</div>", "</li>", "</tr>", "</h1>",
        "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</section>", "</article>", "</header>",
    ] {
        s = s.replace(tag, "\n").replace(&tag.to_uppercase(), "\n");
    }
    // Strip remaining tags.
    let mut out = String::with_capacity(s.len() / 2);
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = decode_entities(&out);
    let lines: Vec<String> = out
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

/// Remove `<tag …> … </tag>` sections case-insensitively.
fn strip_block(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if let Some(start) = lower[i..].find(&open) {
            let abs = i + start;
            out.push_str(&html[i..abs]);
            if let Some(end) = lower[abs..].find(&close) {
                i = abs + end + close.len();
            } else {
                break; // no close — drop the rest
            }
        } else {
            out.push_str(&html[i..]);
            break;
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&rsquo;", "'")
        .replace("&lsquo;", "'")
        .replace("&ldquo;", "\"")
        .replace("&rdquo;", "\"")
}
