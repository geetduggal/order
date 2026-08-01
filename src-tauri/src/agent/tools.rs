//! Tool definitions (sent to the model), read/write classification, execution
//! dispatch, and the write-approval previews. The model only ever *names* a tool
//! and supplies JSON input; this module is what actually runs it against the
//! vault via `fs_tools`.

use super::fs_tools;
use super::provider::Tool;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

/// The tools the model is permitted to call.
pub fn tool_defs() -> Vec<Tool> {
    let s = |p: Value| p; // brevity
    vec![
        Tool { name: "list_directory".into(),
            description: "List the entries (files and subfolders) of a vault-relative directory. Use \"\" for the vault root.".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string","description":"vault-relative directory path"}},"required":["path"]})) },
        Tool { name: "read_file".into(),
            description: "Read a UTF-8 text file at a vault-relative path.".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})) },
        Tool { name: "search_files".into(),
            description: "Find files by name/glob (e.g. \"*.md\", \"**/todo*.md\"). Matches the vault-relative path or basename.".into(),
            input_schema: s(json!({"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]})) },
        Tool { name: "search_content".into(),
            description: "Case-insensitive text search across files, returning path + matching lines with context. Optional path_glob to limit which files are searched.".into(),
            input_schema: s(json!({"type":"object","properties":{"query":{"type":"string"},"path_glob":{"type":"string"}},"required":["query"]})) },
        Tool { name: "write_file".into(),
            description: "Create a file, or overwrite an existing one, with the given content. Overwriting an existing file is destructive.".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]})) },
        Tool { name: "edit_file".into(),
            description: "Replace one exact occurrence of old_string with new_string in a file. Fails if old_string is missing or not unique — include enough surrounding context to make it unique.".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]})) },
        Tool { name: "create_directory".into(),
            description: "Create a directory (and any missing parents).".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})) },
        Tool { name: "move_file".into(),
            description: "Move or rename a file/folder. Destructive.".into(),
            input_schema: s(json!({"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}},"required":["from","to"]})) },
        Tool { name: "delete_file".into(),
            description: "Delete a file (or a folder, recursively). Destructive.".into(),
            input_schema: s(json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})) },
    ]
}

/// Whether a tool mutates the vault (requires approval) vs a free read.
pub fn is_write(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file" | "create_directory" | "move_file" | "delete_file")
}

fn get<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// A one-line human description of a tool call (for narration + transcript).
pub fn describe(name: &str, input: &Value) -> String {
    match name {
        "list_directory" => format!("list_directory({})", get(input, "path")),
        "read_file" => format!("read_file({})", get(input, "path")),
        "search_files" => format!("search_files({})", get(input, "pattern")),
        "search_content" => format!("search_content({})", get(input, "query")),
        "write_file" => format!("write_file({})", get(input, "path")),
        "edit_file" => format!("edit_file({})", get(input, "path")),
        "create_directory" => format!("create_directory({})", get(input, "path")),
        "move_file" => format!("move_file({} → {})", get(input, "from"), get(input, "to")),
        "delete_file" => format!("delete_file({})", get(input, "path")),
        other => format!("{other}(?)"),
    }
}

/// Execute a tool call against the vault. Returns readable output or a
/// recoverable error string.
pub fn dispatch(root: &Path, name: &str, input: &Value) -> Result<String, String> {
    match name {
        "list_directory" => fs_tools::list_directory(root, get(input, "path")),
        "read_file" => fs_tools::read_file(root, get(input, "path")),
        "search_files" => fs_tools::search_files(root, get(input, "pattern")),
        "search_content" => fs_tools::search_content(root, get(input, "query"),
            input.get("path_glob").and_then(|v| v.as_str())),
        "write_file" => fs_tools::write_file(root, get(input, "path"), get(input, "content")),
        "edit_file" => fs_tools::edit_file(root, get(input, "path"), get(input, "old_string"), get(input, "new_string")),
        "create_directory" => fs_tools::create_directory(root, get(input, "path")),
        "move_file" => fs_tools::move_file(root, get(input, "from"), get(input, "to")),
        "delete_file" => fs_tools::delete_file(root, get(input, "path")),
        other => Err(format!("unknown tool: {other}")),
    }
}

/// A single item in a write-approval batch, with a preview the UI can render.
#[derive(Serialize, Clone)]
pub struct ApprovalItem {
    pub tool: String,
    pub summary: String,
    pub path: String,
    pub destructive: bool,
    /// For edits/overwrites: the before/after text so the UI can show a diff.
    pub old: Option<String>,
    pub new: Option<String>,
}

/// Build the approval preview for a write tool call (reads current file state).
pub fn preview(root: &Path, name: &str, input: &Value) -> ApprovalItem {
    match name {
        "write_file" => {
            let path = get(input, "path").to_string();
            let content = get(input, "content").to_string();
            let existing = fs_tools::resolve_in_vault(root, &path).ok()
                .filter(|p| p.is_file())
                .and_then(|p| std::fs::read_to_string(&p).ok());
            let overwrite = existing.is_some();
            ApprovalItem {
                tool: name.into(),
                summary: if overwrite { format!("Overwrite {path}") } else { format!("Create {path}") },
                path, destructive: overwrite, old: existing, new: Some(content),
            }
        }
        "edit_file" => {
            let path = get(input, "path").to_string();
            ApprovalItem { tool: name.into(), summary: format!("Edit {path}"), path,
                destructive: false, old: Some(get(input, "old_string").into()), new: Some(get(input, "new_string").into()) }
        }
        "create_directory" => {
            let path = get(input, "path").to_string();
            ApprovalItem { tool: name.into(), summary: format!("Create folder {path}"), path, destructive: false, old: None, new: None }
        }
        "move_file" => {
            let from = get(input, "from").to_string();
            let to = get(input, "to").to_string();
            ApprovalItem { tool: name.into(), summary: format!("Move {from} → {to}"), path: from, destructive: true, old: None, new: None }
        }
        "delete_file" => {
            let path = get(input, "path").to_string();
            ApprovalItem { tool: name.into(), summary: format!("Delete {path}"), path, destructive: true, old: None, new: None }
        }
        _ => ApprovalItem { tool: name.into(), summary: describe(name, input), path: String::new(), destructive: false, old: None, new: None },
    }
}
