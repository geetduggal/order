//! The `.chat.md` on-disk format + incremental transcript writing. A chat is an
//! ordinary markdown note: YAML front matter marking it a chat, date-prefixed
//! filename, clearly delineated turns, and a compact one-line record per tool
//! call so the prose stays readable. Written turn-by-turn so a crash never loses
//! the session. Everything routes through the vault (fs_tools resolver), so it's
//! identical on macOS + iOS.

use super::fs_tools::resolve_in_vault;
use chrono::Local;
use std::path::Path;

fn sanitize(title: &str) -> String {
    let t = title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim();
    if t.is_empty() { "Chat".into() } else { t.chars().take(60).collect() }
}

/// Create a new chat file in `dir_rel` (vault-relative), returning its vault-
/// relative path. Filename: `YYYY-MM-DD HHMM <title>.chat.md`, disambiguated if
/// it already exists. Writes the front matter only; turns are appended later.
pub fn create_chat(root: &Path, dir_rel: &str, title: &str) -> Result<String, String> {
    let now = Local::now();
    let clean = sanitize(title);
    let base = format!("{} {}", now.format("%Y-%m-%d %H%M"), clean);
    let dir = dir_rel.trim().trim_matches('/');
    let mk = |name: &str| if dir.is_empty() { format!("{name}.chat.md") } else { format!("{dir}/{name}.chat.md") };
    // Ensure the directory exists.
    if !dir.is_empty() {
        let abs = resolve_in_vault(root, dir)?;
        std::fs::create_dir_all(&abs).map_err(|e| format!("create chat dir: {e}"))?;
    }
    let mut rel = mk(&base);
    let mut n = 2;
    while resolve_in_vault(root, &rel)?.exists() {
        rel = mk(&format!("{base} {n}"));
        n += 1;
    }
    let fm = format!(
        "---\ntype: chat\ncreated: {}\ntitle: {}\n---\n\n",
        now.to_rfc3339(),
        clean,
    );
    let abs = resolve_in_vault(root, &rel)?;
    std::fs::write(&abs, fm).map_err(|e| format!("write chat: {e}"))?;
    Ok(rel)
}

fn append(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    let abs = resolve_in_vault(root, rel)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&abs)
        .map_err(|e| format!("open chat for append: {e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("append chat: {e}"))?;
    Ok(())
}

/// Append the user's turn.
pub fn append_user(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    append(root, rel, &format!("## You\n\n{}\n\n", text.trim()))
}

/// Append the agent's turn: its prose, plus a compact record of any tool calls.
/// `tool_lines` are pre-formatted one-liners like `read_file(notes/todo.md) → ok`.
pub fn append_agent(root: &Path, rel: &str, text: &str, tool_lines: &[String]) -> Result<(), String> {
    let mut body = String::from("## Agent\n\n");
    if !tool_lines.is_empty() {
        for l in tool_lines {
            body.push_str(&format!("> 🔧 {l}\n"));
        }
        body.push('\n');
    }
    let t = text.trim();
    if !t.is_empty() {
        body.push_str(t);
        body.push_str("\n\n");
    }
    append(root, rel, &body)
}

/// A note when a turn hit the tool-iteration ceiling.
pub fn append_note(root: &Path, rel: &str, note: &str) -> Result<(), String> {
    append(root, rel, &format!("> _{}_\n\n", note))
}
