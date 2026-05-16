mod vault;
mod watcher;
mod publish;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub vault_path: Mutex<Option<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { vault_path: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            vault::set_vault,
            vault::scan_vault,
            vault::refresh_note,
            vault::read_note,
            vault::save_note,
            vault::set_frontmatter,
            vault::delete_note,
            vault::read_text,
            vault::write_text,
            vault::write_binary,
            vault::rename_file,
            watcher::start_watcher,
            publish::publish_public,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Order");
}
