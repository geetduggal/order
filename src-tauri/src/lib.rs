mod vault;
mod vault_fs;
mod watcher;
mod publish;
mod publish_ios;

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
        .plugin(tauri_plugin_vault::init())
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
            vault_fs::vault_is_ios,
            vault_fs::vault_walk,
            vault_fs::vault_walk_metadata,
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
            // Replace the default macOS menu (which binds Cmd+W to
            // Close Window — and AppKit consumes Cmd+W before WebKit
            // sees it, so our JS keyboard handler for "go to Week view"
            // never gets to run). Rebuild a sensible default minus the
            // Close item; the red traffic-light X still closes the
            // window, and Cmd+W now reaches our JS handler.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
                let about = AboutMetadataBuilder::new()
                    .name(Some("Order"))
                    .build();
                let app_menu = SubmenuBuilder::new(app, "Order")
                    .item(&PredefinedMenuItem::about(app, Some("About Order"), Some(about))?)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, None)?)
                    .build()?;
                // File: a generic "New" item (no JS hook — Cmd+N is owned
                // by the JS keyboard handler in CardGrid) so the user
                // still has a File menu without the Close Window shortcut.
                let new_item = MenuItemBuilder::with_id("new", "New Note")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Order");
}
