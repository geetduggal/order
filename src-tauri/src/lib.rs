mod vault;
mod vault_fs;
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
        .manage(vault_fs::VaultState::default())
        // Serve attachment images from the vault via vaultasset://localhost/<rel>.
        // Resolves through the same VaultState as the FS bridge, so it works for
        // an absolute desktop root or a bookmarked iOS folder alike.
        .register_uri_scheme_protocol("vaultasset", |ctx, request| {
            use tauri::Manager;
            let rel = percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
                .decode_utf8_lossy()
                .to_string();
            let state = ctx.app_handle().state::<vault_fs::VaultState>();
            match vault_fs::read_asset(&state, &rel) {
                Ok(bytes) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", vault_fs::mime_for(&rel))
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault::set_vault,
            vault_fs::vault_set_root,
            vault_fs::vault_read_text,
            vault_fs::vault_write_text,
            vault_fs::vault_write_binary,
            vault_fs::vault_read_dir,
            vault_fs::vault_exists,
            vault_fs::vault_stat,
            vault_fs::vault_rename,
            vault_fs::vault_remove,
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
            vault::delete_file,
            vault::open_path,
            watcher::start_watcher,
            publish::publish_site,
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
