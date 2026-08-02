//! The agent loop + its Tauri commands. Rust owns the whole turn: it builds the
//! request, calls the model, executes tool calls against the vault, pauses for a
//! single batched write-approval when needed, feeds results back, and repeats
//! until the model stops calling tools. Progress streams to the UI as
//! `agent-stream` events; the UI never sees a filesystem path it constructed.

use super::chat;
use super::provider::{Anthropic, Block, CompletionRequest, Msg, ModelProvider, DEFAULT_MODEL, MAX_TOKENS};
use super::tools;
use crate::vault_fs::VaultState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");
/// How far back to pull sibling chats for context. One knob, easy to change.
const CHAT_WINDOW_DAYS: i64 = 14;
/// Ceiling on model↔tool round-trips in a single turn.
const MAX_ITERS: usize = 12;
/// How long to wait for the user to answer a write-approval before giving up.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy)]
enum Decision { Once, All, Reject }

#[derive(Default)]
pub struct AgentState {
    approval: Mutex<Option<SyncSender<Decision>>>,
    auto_approve: AtomicBool,
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<VaultState>();
    let guard = state.root.lock().map_err(|e| e.to_string())?;
    guard.as_ref().cloned().ok_or_else(|| "vault root not set".into())
}

fn emit(app: &AppHandle, chat_path: &str, payload: serde_json::Value) {
    let mut obj = payload;
    obj["chatPath"] = serde_json::Value::String(chat_path.to_string());
    let _ = app.emit("agent-stream", obj);
}

/// Rebuild this chat's prior turns as plain text messages (tool records stay as
/// readable text — exact tool_use/tool_result blocks only matter within a live
/// turn, which we keep in memory). Missing/new chats yield no history.
fn reconstruct_history(root: &Path, chat_rel: &str) -> Vec<Msg> {
    let abs = match super::fs_tools::resolve_in_vault(root, chat_rel) { Ok(p) => p, Err(_) => return vec![] };
    let raw = match std::fs::read_to_string(&abs) { Ok(s) => s, Err(_) => return vec![] };
    // Drop YAML front matter.
    let body = if let Some(rest) = raw.strip_prefix("---\n") {
        rest.find("\n---\n").map(|i| &rest[i + 5..]).unwrap_or(rest)
    } else { &raw };

    let mut msgs = Vec::new();
    let mut role: Option<&str> = None;
    let mut buf = String::new();
    let mut flush = |role: Option<&str>, buf: &mut String, msgs: &mut Vec<Msg>| {
        if let Some(r) = role {
            let t = buf.trim();
            if !t.is_empty() {
                msgs.push(Msg { role: r.to_string(), content: vec![Block::Text { text: t.to_string() }] });
            }
        }
        buf.clear();
    };
    for line in body.lines() {
        match line.trim() {
            "## You" => { flush(role, &mut buf, &mut msgs); role = Some("user"); }
            "## Agent" => { flush(role, &mut buf, &mut msgs); role = Some("assistant"); }
            _ => { buf.push_str(line); buf.push('\n'); }
        }
    }
    flush(role, &mut buf, &mut msgs);
    msgs
}

/// Build the initial-context block: an index of the folder's non-chat files
/// (names only) + the recent sibling chats (within CHAT_WINDOW_DAYS). Returns
/// the context text and the list of chat filenames actually loaded (so the UI
/// can show exactly which past chats informed this turn).
fn gather_context(root: &Path, dir_rel: &str, current_chat: &str) -> (String, Vec<String>) {
    let dir_abs = match super::fs_tools::resolve_in_vault(root, dir_rel) { Ok(p) => p, Err(_) => return (String::new(), vec![]) };
    let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(CHAT_WINDOW_DAYS);
    let current_name = Path::new(current_chat).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    let mut files = Vec::new();
    let mut chats: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir_abs) {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            if name.ends_with(".chat.md") {
                if name == current_name { continue; }
                // date-prefixed filename → cheap window check
                let in_window = name.get(0..10)
                    .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                    .map(|d| d >= cutoff)
                    .unwrap_or(true);
                if in_window { chats.push((name, e.path())); }
            } else {
                files.push(name);
            }
        }
    }
    files.sort();
    chats.sort_by(|a, b| b.0.cmp(&a.0)); // newest first

    let mut ctx = format!("You are working in the notable folder `{}`.\n\n", if dir_rel.is_empty() { "(vault root)" } else { dir_rel });
    if !files.is_empty() {
        ctx.push_str("Files in this folder (names only — read them if useful):\n");
        for f in &files { ctx.push_str(&format!("  - {f}\n")); }
        ctx.push('\n');
    }
    let mut loaded = Vec::new();
    if !chats.is_empty() {
        ctx.push_str(&format!("Recent chats in this folder (last {CHAT_WINDOW_DAYS} days), for continuity:\n\n"));
        for (name, path) in chats.iter().take(8) {
            if let Ok(body) = std::fs::read_to_string(path) {
                ctx.push_str(&format!("--- chat: {name} ---\n{}\n\n", body.trim()));
                loaded.push(name.clone());
            }
        }
    }
    (ctx, loaded)
}

#[derive(Serialize)]
pub struct TurnResult {
    pub chat_path: String,
    pub text: String,
}

fn request_approval(app: &AppHandle, state: &AgentState, chat_rel: &str, items: &[tools::ApprovalItem]) -> Decision {
    let (tx, rx) = sync_channel::<Decision>(1);
    *state.approval.lock().unwrap() = Some(tx);
    emit(app, chat_rel, serde_json::json!({ "kind": "approval", "items": items }));
    let d = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or(Decision::Reject);
    *state.approval.lock().unwrap() = None;
    d
}

/// Run one full turn (may involve several model↔tool round-trips).
fn run_turn(
    app: &AppHandle,
    provider: &dyn ModelProvider,
    root: &Path,
    chat_rel: &str,
    dir_rel: &str,
    user_text: &str,
) -> Result<String, String> {
    let (context, loaded) = gather_context(root, dir_rel, chat_rel);
    emit(app, chat_rel, serde_json::json!({ "kind": "context", "loadedChats": loaded }));
    let system = format!("{SYSTEM_PROMPT}\n\n---\n\n{context}");

    let mut messages = reconstruct_history(root, chat_rel);
    // Persist the user's turn immediately (crash safety), then include it.
    chat::append_user(root, chat_rel, user_text)?;
    messages.push(Msg::user_text(user_text));

    let tool_defs = tools::tool_defs();
    let mut agent_text_parts: Vec<String> = Vec::new();
    let mut tool_lines: Vec<String> = Vec::new();
    let mut total_in = 0u32;
    let mut total_out = 0u32;
    let mut total_cache_read = 0u32;
    let mut total_cache_write = 0u32;

    for iter in 0..MAX_ITERS {
        let req = CompletionRequest { system: &system, messages: &messages, tools: &tool_defs, model: DEFAULT_MODEL, max_tokens: MAX_TOKENS };
        let mut on_text = |t: &str| emit(app, chat_rel, serde_json::json!({ "kind": "text", "text": t }));
        let (blocks, usage) = provider.stream(&req, &mut on_text)?;
        total_in += usage.input_tokens;
        total_out += usage.output_tokens;
        total_cache_read += usage.cache_read_tokens;
        total_cache_write += usage.cache_write_tokens;

        let text: String = blocks.iter().filter_map(|b| if let Block::Text { text } = b { Some(text.as_str()) } else { None })
            .collect::<Vec<_>>().join("\n");
        if !text.trim().is_empty() { agent_text_parts.push(text.trim().to_string()); }

        let tool_uses: Vec<(&String, &String, &serde_json::Value)> = blocks.iter().filter_map(|b| {
            if let Block::ToolUse { id, name, input } = b { Some((id, name, input)) } else { None }
        }).collect();

        if tool_uses.is_empty() {
            break; // model is done for this turn
        }

        messages.push(Msg { role: "assistant".into(), content: blocks.clone() });
        let mut results: Vec<Block> = Vec::new();

        // Reads run freely, narrated.
        for (id, name, input) in tool_uses.iter().filter(|(_, n, _)| !tools::is_write(n)) {
            let desc = tools::describe(name, input);
            emit(app, chat_rel, serde_json::json!({ "kind": "tool", "line": desc }));
            let (content, is_error) = match tools::dispatch(root, name, input) { Ok(s) => (s, false), Err(e) => (e, true) };
            tool_lines.push(format!("{desc} → {}", if is_error { "error" } else { "ok" }));
            results.push(Block::ToolResult { tool_use_id: (*id).clone(), content, is_error });
        }

        // Writes are batched behind a single approval.
        let writes: Vec<_> = tool_uses.iter().filter(|(_, n, _)| tools::is_write(n)).collect();
        if !writes.is_empty() {
            let items: Vec<tools::ApprovalItem> = writes.iter().map(|(_, n, i)| tools::preview(root, n, i)).collect();
            let decision = if self_auto(app) { Decision::Once } else { request_approval(app, app.state::<AgentState>().inner(), chat_rel, &items) };
            match decision {
                Decision::Reject => {
                    for (id, name, input) in &writes {
                        let desc = tools::describe(name, input);
                        tool_lines.push(format!("{desc} → declined"));
                        emit(app, chat_rel, serde_json::json!({ "kind": "tool", "line": format!("{desc} — declined") }));
                        results.push(Block::ToolResult { tool_use_id: (*id).clone(), content: "The user declined this change.".into(), is_error: true });
                    }
                }
                Decision::Once | Decision::All => {
                    if matches!(decision, Decision::All) { app.state::<AgentState>().auto_approve.store(true, Ordering::Relaxed); }
                    for (id, name, input) in &writes {
                        let desc = tools::describe(name, input);
                        emit(app, chat_rel, serde_json::json!({ "kind": "tool", "line": desc }));
                        let (content, is_error) = match tools::dispatch(root, name, input) { Ok(s) => (s, false), Err(e) => (e, true) };
                        tool_lines.push(format!("{desc} → {}", if is_error { "error" } else { "ok" }));
                        results.push(Block::ToolResult { tool_use_id: (*id).clone(), content, is_error });
                    }
                }
            }
        }

        messages.push(Msg { role: "user".into(), content: results });

        if iter + 1 >= MAX_ITERS {
            let note = "Reached the tool-step limit for this turn; stopping.";
            emit(app, chat_rel, serde_json::json!({ "kind": "note", "text": note }));
            chat::append_note(root, chat_rel, note)?;
            break;
        }
    }

    let final_text = agent_text_parts.join("\n\n");
    chat::append_agent(root, chat_rel, &final_text, &tool_lines)?;
    emit(app, chat_rel, serde_json::json!({
        "kind": "final", "text": final_text,
        "usage": {
            "inputTokens": total_in, "outputTokens": total_out,
            "cacheReadTokens": total_cache_read, "cacheWriteTokens": total_cache_write,
            "model": DEFAULT_MODEL,
        },
    }));
    Ok(final_text)
}

fn self_auto(app: &AppHandle) -> bool {
    app.state::<AgentState>().auto_approve.load(Ordering::Relaxed)
}

// ---- commands --------------------------------------------------------------

/// Run one agent turn. Creates the chat file on the first message (when
/// `chat_path` is None), then appends to it. Streams progress via `agent-stream`.
#[tauri::command]
pub async fn agent_turn(
    app: AppHandle,
    api_key: String,
    chat_path: Option<String>,
    create_dir: Option<String>,
    title: Option<String>,
    user_text: String,
) -> Result<TurnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = vault_root(&app)?;
        // New chat → create the file and reset "approve all" for the fresh chat.
        let chat_rel = match chat_path {
            Some(p) => p,
            None => {
                app.state::<AgentState>().auto_approve.store(false, Ordering::Relaxed);
                let dir = create_dir.clone().unwrap_or_default();
                let rel = chat::create_chat(&root, &dir, title.as_deref().unwrap_or("Chat"))?;
                emit(&app, &rel, serde_json::json!({ "kind": "created", "chatPath": rel }));
                rel
            }
        };
        let dir_rel = Path::new(&chat_rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let provider = Anthropic::new(api_key);
        let text = match run_turn(&app, &provider, &root, &chat_rel, &dir_rel, &user_text) {
            Ok(t) => t,
            Err(e) => { emit(&app, &chat_rel, serde_json::json!({ "kind": "error", "message": e.clone() })); return Err(e); }
        };
        Ok(TurnResult { chat_path: chat_rel, text })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create an empty chat file in `dir_rel` (vault-relative) and return its
/// vault-relative path. The dock's "new chat" button calls this so the chat
/// appears as an ordinary card immediately; the filename format lives in Rust,
/// so React never constructs it.
#[tauri::command]
pub fn agent_new_chat(app: AppHandle, dir_rel: Option<String>, title: Option<String>) -> Result<String, String> {
    let root = vault_root(&app)?;
    app.state::<AgentState>().auto_approve.store(false, Ordering::Relaxed);
    chat::create_chat(&root, dir_rel.as_deref().unwrap_or(""), title.as_deref().unwrap_or("Chat"))
}

/// Answer a pending write-approval: "once" | "all" | "reject".
#[tauri::command]
pub fn agent_approve(app: AppHandle, decision: String) -> Result<(), String> {
    let d = match decision.as_str() { "all" => Decision::All, "reject" => Decision::Reject, _ => Decision::Once };
    if let Some(tx) = app.state::<AgentState>().approval.lock().unwrap().take() {
        let _ = tx.send(d);
    }
    Ok(())
}
