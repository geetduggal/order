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
/// Output-token ceiling per turn. This must comfortably fit a full-file
/// `write_file` (path + entire content as JSON) PLUS any reasoning the model
/// emits before it — 4096 was too low, so writing a large note (e.g. a multi-KB
/// doc) truncated the tool call mid-arguments, which parsed to `{}` and produced
/// an empty write that the model retried forever. It's a cap, not a target: the
/// model only generates what it needs, so a generous ceiling costs nothing on
/// normal turns and simply stops large writes from being cut off.
pub const MAX_TOKENS: u32 = 16384;

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
                    match serde_json::from_str(&a.json) {
                        Ok(v) => v,
                        // Non-empty but INVALID JSON means the tool arguments were
                        // cut off before they finished streaming — almost always the
                        // response hit the output-token limit mid tool-call. Flag it
                        // so dispatch returns a clear "truncated" error instead of
                        // silently running the tool with empty args (an empty
                        // write_file the model then retries forever).
                        Err(_) => serde_json::json!({ "__truncated__": true }),
                    }
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

// ---- OpenAI-compatible provider (OpenAI, xAI Grok, local Ollama/LM Studio) ----
// One impl covers them all: they speak the same /chat/completions API with
// function tool-calling. Only base_url + api_key + model differ. It maps the
// shared Block/Msg representation to OpenAI's message shape and back, so the
// agent loop and tools are untouched — full tool-use parity with Anthropic.

pub struct OpenAiCompat {
    api_key: String,
    base_url: String, // e.g. https://api.openai.com/v1 (no trailing slash)
}

impl OpenAiCompat {
    pub fn new(api_key: String, base_url: String) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        OpenAiCompat { api_key, base_url }
    }
}

/// Map the shared Msg/Block history to OpenAI chat messages. Anthropic keeps
/// tool_result blocks inside a user message; OpenAI wants them as separate
/// `tool` role messages that follow the assistant's tool_calls — so we split
/// them out, preserving order.
fn to_openai_messages(system: &str, msgs: &[Msg]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if !system.is_empty() {
        out.push(serde_json::json!({ "role": "system", "content": system }));
    }
    for m in msgs {
        if m.role == "assistant" {
            let mut text = String::new();
            let mut tool_calls: Vec<serde_json::Value> = Vec::new();
            for b in &m.content {
                match b {
                    Block::Text { text: t } => text.push_str(t),
                    Block::ToolUse { id, name, input } => {
                        tool_calls.push(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": input.to_string() }
                        }));
                    }
                    Block::ToolResult { .. } => {}
                }
            }
            let mut msg = serde_json::json!({ "role": "assistant" });
            // OpenAI requires content to be present (may be null when tool_calls exist).
            msg["content"] = if text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(text) };
            if !tool_calls.is_empty() {
                msg["tool_calls"] = serde_json::Value::Array(tool_calls);
            }
            out.push(msg);
        } else {
            // user (or system-ish) — Text becomes a user message; ToolResult
            // blocks become `tool` messages (they follow the assistant call).
            let mut text = String::new();
            for b in &m.content {
                match b {
                    Block::ToolResult { tool_use_id, content, .. } => {
                        out.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content,
                        }));
                    }
                    Block::Text { text: t } => {
                        if !text.is_empty() { text.push('\n'); }
                        text.push_str(t);
                    }
                    Block::ToolUse { .. } => {}
                }
            }
            if !text.is_empty() {
                out.push(serde_json::json!({ "role": "user", "content": text }));
            }
        }
    }
    out
}

impl ModelProvider for OpenAiCompat {
    fn stream(
        &self,
        req: &CompletionRequest,
        on_text: &mut dyn FnMut(&str),
    ) -> Result<(Vec<Block>, Usage), String> {
        let messages = to_openai_messages(req.system, req.messages);
        let tools: Vec<serde_json::Value> = req
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools);
        }
        let url = format!("{}/chat/completions", self.base_url);
        let mut rb = agent_http()
            .post(&url)
            .set("content-type", "application/json");
        // Local servers (Ollama / LM Studio) need no key; only send one if set.
        if !self.api_key.trim().is_empty() {
            rb = rb.set("authorization", &format!("Bearer {}", self.api_key));
        }
        let resp = rb.send_json(body);
        let reader = match resp {
            Ok(r) => r.into_reader(),
            Err(ureq::Error::Status(code, r)) => {
                let b = r.into_string().unwrap_or_default();
                return Err(format!("model API {code}: {}", extract_error(&b)));
            }
            Err(e) => return Err(format!("model request failed: {e}")),
        };
        parse_openai_sse(BufReader::new(reader), on_text)
    }
}

/// Accumulate an OpenAI streaming chat completion. Content deltas forward live;
/// tool_call fragments accumulate by their `index` (id + name arrive on the
/// first fragment, arguments stream as string pieces).
fn parse_openai_sse(
    reader: impl BufRead,
    on_text: &mut dyn FnMut(&str),
) -> Result<(Vec<Block>, Usage), String> {
    struct TC { id: String, name: String, args: String }
    let mut text = String::new();
    let mut calls: Vec<TC> = Vec::new();
    let mut usage = Usage::default();

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(e) => return Err(format!("stream read: {e}")) };
        let data = match line.strip_prefix("data: ") { Some(d) => d.trim(), None => continue };
        if data.is_empty() { continue; }
        if data == "[DONE]" { break; }
        let v: serde_json::Value = match serde_json::from_str(data) { Ok(v) => v, Err(_) => continue };
        if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
            usage.input_tokens = u.get("prompt_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
            usage.output_tokens = u.get("completion_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
        }
        let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) else { continue };
        if let Some(msg) = choice.get("error").and_then(|e| e.as_str()) {
            return Err(format!("model stream error: {msg}"));
        }
        let Some(delta) = choice.get("delta") else { continue };
        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
            if !c.is_empty() { text.push_str(c); on_text(c); }
        }
        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                while calls.len() <= idx { calls.push(TC { id: String::new(), name: String::new(), args: String::new() }); }
                let slot = &mut calls[idx];
                if let Some(id) = tc.get("id").and_then(|s| s.as_str()) {
                    if !id.is_empty() { slot.id = id.to_string(); }
                }
                if let Some(f) = tc.get("function") {
                    if let Some(n) = f.get("name").and_then(|s| s.as_str()) {
                        if !n.is_empty() { slot.name.push_str(n); }
                    }
                    if let Some(a) = f.get("arguments").and_then(|s| s.as_str()) {
                        slot.args.push_str(a);
                    }
                }
            }
        }
    }

    let mut blocks = Vec::new();
    if !text.is_empty() { blocks.push(Block::Text { text }); }
    for (i, c) in calls.into_iter().enumerate() {
        if c.name.is_empty() { continue; }
        let input: serde_json::Value = if c.args.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&c.args).unwrap_or_else(|_| serde_json::json!({ "__truncated__": true }))
        };
        // Some local servers omit tool-call ids; synthesize a stable one so the
        // tool_result can reference it.
        let id = if c.id.is_empty() { format!("call_{i}") } else { c.id };
        blocks.push(Block::ToolUse { id, name: c.name, input });
    }
    Ok((blocks, usage))
}

/// Pick a provider from a config string. "anthropic" (default) → Anthropic;
/// "openai" / "grok" / "local" (and any other) → OpenAI-compatible with the
/// matching default base URL when none is supplied.
pub fn make_provider(
    provider: Option<&str>,
    api_key: String,
    base_url: Option<String>,
) -> Box<dyn ModelProvider> {
    match provider.unwrap_or("anthropic") {
        "anthropic" => Box::new(Anthropic::new(api_key)),
        kind => {
            let default_base = match kind {
                "grok" | "xai" => "https://api.x.ai/v1",
                "local" => "http://localhost:11434/v1",
                _ => "https://api.openai.com/v1", // "openai" and anything else
            };
            let base = base_url
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| default_base.to_string());
            Box::new(OpenAiCompat::new(api_key, base))
        }
    }
}
