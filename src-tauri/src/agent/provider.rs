//! Model provider: the seam between the agent loop and the LLM API. One
//! implementation ships (Anthropic); a second could be added without touching
//! the loop or the tools. The provider is a *planner* — it turns a request into
//! assistant blocks (text + tool_use). It never executes anything.
//!
//! Streaming: the Anthropic impl reads Server-Sent Events over ureq (the same
//! blocking HTTP stack the voice/calendar features use — works on macOS + iOS),
//! forwarding text deltas to `on_text` as they arrive and returning the fully
//! assembled assistant blocks when the turn's message is complete.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};

/// A default agent model — capable at tool use, cost-effective for a loop.
/// One clearly-named constant so it's trivial to change.
pub const DEFAULT_MODEL: &str = "claude-sonnet-5";
pub const MAX_TOKENS: u32 = 4096;

/// A content block, shared across provider + loop + transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text { text: String },
    ToolUse { id: String, name: String, input: serde_json::Value },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String, // "user" | "assistant"
    pub content: Vec<Block>,
}

impl Msg {
    pub fn user_text(text: impl Into<String>) -> Self {
        Msg { role: "user".into(), content: vec![Block::Text { text: text.into() }] }
    }
}

/// A tool definition sent to the model (name + description + JSON schema).
#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

pub struct CompletionRequest<'a> {
    pub system: &'a str,
    pub messages: &'a [Msg],
    pub tools: &'a [Tool],
    pub model: &'a str,
    pub max_tokens: u32,
}

/// Token usage reported by the model for one message, for cost accounting.
/// Cache reads/writes are split out because they're priced very differently
/// (a cache read is ~1/10 the price of fresh input; a write ~1.25×).
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_write_tokens: u32,
}

/// The pluggable seam. `stream` returns the assistant's blocks for this message
/// (text + any tool_use) plus the token usage, after streaming text to `on_text`.
pub trait ModelProvider: Send + Sync {
    fn stream(
        &self,
        req: &CompletionRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<(Vec<Block>, Usage), String>;
}

pub struct Anthropic {
    api_key: String,
}

impl Anthropic {
    pub fn new(api_key: String) -> Self {
        Anthropic { api_key }
    }
}

fn agent_http() -> ureq::Agent {
    let connector = native_tls::TlsConnector::new().expect("tls");
    ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        // Agent turns can be long; don't let a slow tool-heavy response time out.
        .timeout_read(std::time::Duration::from_secs(300))
        .build()
}

impl ModelProvider for Anthropic {
    fn stream(
        &self,
        req: &CompletionRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<(Vec<Block>, Usage), String> {
        if self.api_key.trim().is_empty() {
            return Err("no Anthropic API key set (add one in Settings)".into());
        }
        // Prompt caching: mark the two big *stable* prefixes — the system prompt
        // (system_prompt.md + the folder context) and the tool definitions — with
        // a cache breakpoint. On every turn after the first (and every tool-loop
        // iteration within a turn) Anthropic replays that prefix from cache: much
        // faster time-to-first-token and ~1/10 the input cost. Requires system +
        // the last tool to be block-form with `cache_control`.
        let system_blocks = serde_json::json!([
            { "type": "text", "text": req.system, "cache_control": { "type": "ephemeral" } }
        ]);
        let mut tools_json = serde_json::to_value(req.tools).unwrap_or(serde_json::json!([]));
        if let Some(arr) = tools_json.as_array_mut() {
            // Anthropic's server-side web search — meaningful research handled on
            // their side; the model calls it and the results come back inline.
            arr.push(serde_json::json!({ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }));
            if let Some(last) = arr.last_mut() {
                last["cache_control"] = serde_json::json!({ "type": "ephemeral" });
            }
        }
        let body = serde_json::json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": system_blocks,
            "messages": req.messages,
            "tools": tools_json,
            "stream": true,
        });
        let resp = agent_http()
            .post("https://api.anthropic.com/v1/messages")
            .set("x-api-key", &self.api_key)
            .set("anthropic-version", "2023-06-01")
            .set("content-type", "application/json")
            .send_json(body);
        let reader = match resp {
            Ok(r) => r.into_reader(),
            Err(ureq::Error::Status(code, r)) => {
                let b = r.into_string().unwrap_or_default();
                return Err(format!("Anthropic API {code}: {}", extract_error(&b)));
            }
            Err(e) => return Err(format!("Anthropic request failed: {e}")),
        };
        parse_sse(BufReader::new(reader), on_text)
    }
}

/// Accumulate content blocks from an Anthropic SSE stream. Text deltas are
/// forwarded live; tool_use inputs arrive as `input_json_delta` fragments that
/// we concatenate and parse at the block's stop.
fn parse_sse(
    reader: impl BufRead,
    on_text: &mut dyn FnMut(&str),
) -> Result<(Vec<Block>, Usage), String> {
    // Per-index accumulation: (kind, text_or_id, name, json_buf).
    struct Acc { kind: String, id: String, name: String, text: String, json: String }
    let mut accs: Vec<Acc> = Vec::new();
    let mut err: Option<String> = None;
    let mut usage = Usage::default();

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(e) => return Err(format!("stream read: {e}")) };
        let data = match line.strip_prefix("data: ") { Some(d) => d.trim(), None => continue };
        if data.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(data) { Ok(v) => v, Err(_) => continue };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "content_block_start" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let cb = v.get("content_block").cloned().unwrap_or_default();
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("text").to_string();
                let acc = Acc {
                    kind,
                    id: cb.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    name: cb.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    text: String::new(),
                    json: String::new(),
                };
                while accs.len() <= idx { accs.push(Acc { kind: "text".into(), id: String::new(), name: String::new(), text: String::new(), json: String::new() }); }
                accs[idx] = acc;
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                if let Some(d) = v.get("delta") {
                    match d.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "text_delta" => {
                            if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                                if let Some(a) = accs.get_mut(idx) { a.text.push_str(t); }
                                on_text(t);
                            }
                        }
                        "input_json_delta" => {
                            if let Some(pj) = d.get("partial_json").and_then(|t| t.as_str()) {
                                if let Some(a) = accs.get_mut(idx) { a.json.push_str(pj); }
                            }
                        }
                        _ => {}
                    }
                }
            }
            "message_start" => {
                // Input + cache read/write tokens are known up front; keep them
                // separate so cost accounting can price the cache correctly.
                if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                    let g = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0) as u32;
                    usage.input_tokens = g("input_tokens");
                    usage.cache_write_tokens = g("cache_creation_input_tokens");
                    usage.cache_read_tokens = g("cache_read_input_tokens");
                    usage.output_tokens = g("output_tokens");
                }
            }
            "message_delta" => {
                // output_tokens on the delta is cumulative for the message.
                if let Some(o) = v.get("usage").and_then(|u| u.get("output_tokens")).and_then(|n| n.as_u64()) {
                    usage.output_tokens = o as u32;
                }
            }
            "error" => {
                err = Some(v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("stream error").to_string());
            }
            "message_stop" => break,
            _ => {}
        }
    }
    if let Some(e) = err { return Err(format!("Anthropic stream error: {e}")); }

    let mut blocks = Vec::new();
    for a in accs {
        match a.kind.as_str() {
            "tool_use" => {
                let input: serde_json::Value = if a.json.trim().is_empty() {
                    serde_json::json!({})
                } else {
                    serde_json::from_str(&a.json).unwrap_or(serde_json::json!({}))
                };
                blocks.push(Block::ToolUse { id: a.id, name: a.name, input });
            }
            _ => {
                if !a.text.is_empty() {
                    blocks.push(Block::Text { text: a.text });
                }
            }
        }
    }
    Ok((blocks, usage))
}

fn extract_error(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect())
}
