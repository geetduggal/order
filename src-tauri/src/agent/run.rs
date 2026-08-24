//! The agent loop + its Tauri commands. Rust owns the whole turn: it builds the
//! request, calls the model, executes tool calls against the vault, pauses for a
//! single batched write-approval when needed, feeds results back, and repeats
//! until the model stops calling tools. Progress streams to the UI as
//! `agent-stream` events; the UI never sees a filesystem path it constructed.

use super::chat;
use super::provider::{make_provider, Block, CompletionRequest, Msg, ModelProvider, DEFAULT_MODEL, MAX_TOKENS};
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

/// Defense-in-depth against the system/developer prompt leaking into a reply that
/// gets saved and spoken aloud. The prompt itself now forbids disclosure (see
/// system_prompt.md), but if the model ever echoes it verbatim anyway, drop any
/// output line that reproduces a DISTINCTIVE line of the system prompt (long
/// enough that a match is regurgitation, not coincidence). Returns the cleaned
/// text (trimmed).
fn scrub_prompt_leak(text: &str) -> String {
    use std::collections::HashSet;
    let distinctive: HashSet<&str> = SYSTEM_PROMPT
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.len() >= 40)
        .collect();
    if distinctive.is_empty() { return text.trim().to_string(); }
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !distinctive.contains(l.trim()))
        .collect();
    kept.join("\n").trim().to_string()
}

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
    /// Set by `agent_cancel` (voice barge-in) to stop the turn between
    /// model↔tool round-trips. Reset at the start of every new turn.
    cancel: AtomicBool,
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

    // A lightweight index of the non-chat files in THIS folder (names only).
    let mut files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir_abs) {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.ends_with(".chat.md") { continue; }
            files.push(name);
        }
    }
    files.sort();

    // Recent chats from the WHOLE vault (not just this folder), so a hands-free
    // session has cross-folder continuity. Hidden dirs (.order-legacy/trash,
    // .git, …) are pruned. Keyed by the date-prefixed filename for the window
    // check + newest-first ordering; the vault-relative dir is shown for context.
    let mut chats: Vec<(String, String, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".chat.md") || name == current_name { continue; }
        let in_window = name.get(0..10)
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .map(|d| d >= cutoff)
            .unwrap_or(true);
        if !in_window { continue; }
        let rel_dir = entry.path().parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        chats.push((name, rel_dir, entry.path().to_path_buf()));
    }
    chats.sort_by(|a, b| b.0.cmp(&a.0)); // newest first (date-prefixed name)

    let mut ctx = format!(
        "The current date and time is {}.\nYou are working in the notable folder `{}`.\n\n",
        chrono::Local::now().format("%A, %B %-d, %Y at %-I:%M %p"),
        if dir_rel.is_empty() { "(vault root)" } else { dir_rel },
    );
    if !files.is_empty() {
        ctx.push_str("Files in this folder (names only — read them if useful):\n");
        for f in &files { ctx.push_str(&format!("  - {f}\n")); }
        ctx.push('\n');
    }
    let mut loaded = Vec::new();
    if !chats.is_empty() {
        ctx.push_str(&format!("Recent chats across the vault (last {CHAT_WINDOW_DAYS} days), newest first, for continuity:\n\n"));
        for (name, rel_dir, path) in chats.iter().take(8) {
            if let Ok(body) = std::fs::read_to_string(path) {
                let loc = if rel_dir.is_empty() { String::new() } else { format!(" (in {rel_dir})") };
                ctx.push_str(&format!("--- chat: {name}{loc} ---\n{}\n\n", body.trim()));
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
    model: &str,
    root: &Path,
    chat_rel: &str,
    dir_rel: &str,
    user_text: &str,
    record_user: bool,
) -> Result<String, String> {
    let (context, loaded) = gather_context(root, dir_rel, chat_rel);
    emit(app, chat_rel, serde_json::json!({ "kind": "context", "loadedChats": loaded }));
    let system = format!("{SYSTEM_PROMPT}\n\n---\n\n{context}");

    let mut messages = reconstruct_history(root, chat_rel);
    if record_user {
        // Persist the user's turn immediately (crash safety), then include it.
        chat::append_user(root, chat_rel, user_text)?;
        messages.push(Msg::user_text(user_text));
    } else if !matches!(messages.last(), Some(m) if m.role == "user") {
        // The utterance was already captured to the record before this turn ran
        // (voice capture-first), so reconstruct_history normally read it back as the
        // final user turn and we must NOT duplicate it. But if the history does NOT
        // end on a user turn — the record didn't land in time, or the last thing on
        // disk is an agent reply — include the text anyway. Anthropic rejects a
        // request that ends on an assistant message ("must end with a user
        // message"), and this also guarantees the model actually sees what was said.
        messages.push(Msg::user_text(user_text));
    }

    let tool_defs = tools::tool_defs();
    let mut agent_text_parts: Vec<String> = Vec::new();
    let mut tool_lines: Vec<String> = Vec::new();
    let mut total_in = 0u32;
    let mut total_out = 0u32;
    let mut total_cache_read = 0u32;
    let mut total_cache_write = 0u32;

    for iter in 0..MAX_ITERS {
        // Barge-in: the user started a new utterance, so abandon this turn between
        // round-trips rather than keep spending tool calls on a superseded reply.
        if app.state::<AgentState>().cancel.load(Ordering::Relaxed) {
            emit(app, chat_rel, serde_json::json!({ "kind": "cancelled" }));
            break;
        }
        let req = CompletionRequest { system: &system, messages: &messages, tools: &tool_defs, model, max_tokens: MAX_TOKENS };
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

    // Scrub any verbatim system-prompt leak from the reply before it is saved and
    // (in Lock Mode) spoken. The record must never contain the internal prompt.
    let final_text = scrub_prompt_leak(&agent_text_parts.join("\n\n"));
    // Only write an agent turn if it actually produced something. A barged-in /
    // cancelled turn yields no text and no tools — writing an empty "## Agent"
    // then pollutes the record AND leaves the file ending on an assistant turn,
    // which makes the next request fail Anthropic's "must end with a user message".
    if !final_text.trim().is_empty() || !tool_lines.is_empty() {
        chat::append_agent(root, chat_rel, &final_text, &tool_lines)?;
    }
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
    // Auto-approve when the user has chosen "approve all", OR when the app is
    // backgrounded (locked hands-free voice): there's no UI to approve against,
    // and the user is actively talking to their own vault, so writes proceed
    // rather than stalling on an approval that can never arrive.
    app.state::<AgentState>().auto_approve.load(Ordering::Relaxed) || !crate::stt::is_foreground()
}

/// Run one agent turn synchronously (already on a blocking thread) against an
/// existing chat, returning the assistant's text. Used by the Rust-driven voice
/// loop when the app is backgrounded and JS can't invoke `agent_turn`. Streams
/// the same `agent-stream` events and persists to the chat file, so the UI is
/// consistent once it wakes.
pub fn run_turn_for(
    app: &AppHandle,
    api_key: &str,
    chat_rel: &str,
    user_text: &str,
    provider_kind: Option<&str>,
    base_url: Option<String>,
    model: Option<&str>,
) -> Result<String, String> {
    app.state::<AgentState>().cancel.store(false, Ordering::Relaxed);
    let root = vault_root(app)?;
    let dir_rel = Path::new(chat_rel)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let model = model.map(|m| m.trim()).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL).to_string();
    let provider = make_provider(provider_kind, api_key.to_string(), base_url);
    run_turn(app, provider.as_ref(), &model, &root, chat_rel, &dir_rel, user_text, true)
}

/// Capture a user utterance into the chat record WITHOUT running a turn. Used in
/// Lock Mode as a guarantee: whatever the user says is saved even when a full turn
/// can't run (no API key, no armed conversation). A running turn records the user
/// itself (see `run_turn`), so this is only for those no-turn paths — calling it
/// there won't duplicate.
pub fn record_user_utterance(app: &AppHandle, chat_rel: &str, user_text: &str) -> Result<(), String> {
    let root = vault_root(app)?;
    chat::append_user(&root, chat_rel, user_text)
}

/// Record a spoken utterance into the chat record WITHOUT running a turn. The
/// voice loop calls this for EVERY finalized utterance so nothing said is ever
/// lost, even when we choose not to reply (echo of the agent, mid-reply, or a
/// transient state). When a reply DOES follow, that turn passes `record_user:
/// false` so the same utterance isn't written twice.
#[tauri::command]
pub async fn agent_record_user(
    app: AppHandle,
    chat_path: String,
    user_text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || record_user_utterance(&app, &chat_path, &user_text))
        .await
        .map_err(|e| e.to_string())?
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
    // Whether this turn should write the user's message to the record. Voice
    // capture-first records the utterance the moment it's spoken and passes false
    // here so it isn't duplicated; typed input (and the default) pass true.
    record_user: Option<bool>,
    // Model provider selection (from Settings): "anthropic" (default), "openai",
    // "grok", "local". base_url overrides the provider's default endpoint; model
    // names the exact model. Absent → Anthropic + DEFAULT_MODEL.
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<TurnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Fresh turn: clear any stale barge-in cancel from a previous turn.
        app.state::<AgentState>().cancel.store(false, Ordering::Relaxed);
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
        let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let provider = make_provider(provider.as_deref(), api_key, base_url);
        let text = match run_turn(&app, provider.as_ref(), &model, &root, &chat_rel, &dir_rel, &user_text, record_user.unwrap_or(true)) {
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

/// Suggest a short, filesystem-friendly title summarising a chat, via one cheap
/// model call. Returns `Ok(None)` when there isn't enough conversation to name,
/// or the model declines. Never renames anything itself — the caller decides
/// whether the chat is eligible (a user-set title is never touched) and does the
/// rename + spacetime update. `api_key` comes from the frontend, same as
/// `agent_turn`, so no keychain plumbing lives here.
#[tauri::command]
pub async fn agent_chat_title(
    app: AppHandle,
    api_key: String,
    chat_path: String,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if api_key.trim().is_empty() {
            return Ok(None);
        }
        let root = vault_root(&app)?;
        let abs = super::fs_tools::resolve_in_vault(&root, &chat_path)?;
        let raw = std::fs::read_to_string(&abs).map_err(|e| format!("read chat: {e}"))?;
        let convo = chat::conversation_text(&raw);
        // Need a real exchange before a title means anything.
        if convo.chars().filter(|c| !c.is_whitespace()).count() < 120 {
            return Ok(None);
        }
        let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let provider = make_provider(provider.as_deref(), api_key, base_url);
        suggest_title(provider.as_ref(), &model, &convo)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One-shot title generation. The topic is almost always set early, so we cap
/// the transcript to bound cost; `max_tokens` is tiny.
fn suggest_title(provider: &dyn ModelProvider, model: &str, convo: &str) -> Result<Option<String>, String> {
    let snippet: String = convo.chars().take(8000).collect();
    let system = "You name a saved conversation with a short file title. \
Reply with ONLY the title: 2 to 6 words, Title Case, no quotes, no punctuation, \
no emoji, no trailing period. Name the concrete topic, task, or decision. \
If there is no clear topic, reply with the single word NONE.";
    let messages = [Msg::user_text(format!("Conversation transcript:\n\n{snippet}"))];
    let req = CompletionRequest {
        system,
        messages: &messages,
        tools: &[],
        model,
        max_tokens: 24,
    };
    let (blocks, _usage) = provider.stream(&req, &mut |_| {})?;
    let mut text = String::new();
    for b in &blocks {
        if let Block::Text { text: t } = b {
            text.push_str(t);
        }
    }
    let raw = text.trim();
    if raw.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    let cleaned = chat::sanitize(raw);
    if cleaned.is_empty() || cleaned.eq_ignore_ascii_case("chat") || cleaned.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    Ok(Some(cleaned))
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

/// Ask the current turn to stop (voice barge-in). Sets the cancel flag the run
/// loop checks between round-trips, and unblocks a pending approval by rejecting
/// it so the turn can wind down instead of waiting out the approval timeout.
#[tauri::command]
pub fn agent_cancel(app: AppHandle) -> Result<(), String> {
    app.state::<AgentState>().cancel.store(true, Ordering::Relaxed);
    if let Some(tx) = app.state::<AgentState>().approval.lock().unwrap().take() {
        let _ = tx.send(Decision::Reject);
    }
    Ok(())
}
