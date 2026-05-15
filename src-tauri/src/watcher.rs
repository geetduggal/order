// Filesystem watcher: emits `vault-changed` events to the frontend when files
// change outside the app (git pull, external editor, etc.). The frontend
// debounces these and re-reads affected notes.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use tauri::{AppHandle, Emitter};

static WATCHER: Mutex<Option<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>>> = Mutex::new(None);

#[tauri::command]
pub fn start_watcher(app: AppHandle, path: String) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    let app_handle = app.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(500), None, move |result: notify_debouncer_full::DebounceEventResult| {
        if let Ok(events) = result {
            let paths: Vec<String> = events
                .iter()
                .flat_map(|e| e.event.paths.iter())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if !paths.is_empty() {
                let _ = app_handle.emit("vault-changed", paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    debouncer.watcher().watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *WATCHER.lock().unwrap() = Some(debouncer);
    Ok(())
}
