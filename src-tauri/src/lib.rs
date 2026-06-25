mod vault;
mod vault_fs;
mod watcher;
mod publish;
mod publish_ios;
mod fts;
mod terminal;
mod gcal;

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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { vault_path: Mutex::new(None) })
        .manage(gcal::PendingAuth::default())
        .manage(vault_fs::VaultState::default())
        .manage(fts::FtsState::default())
        .manage(terminal::TerminalState::default())
        // Serve attachment images / videos from the vault via
        // vaultasset://localhost/<rel>. Resolves through the same
        // VaultState as the FS bridge so it works for an absolute
        // desktop root or a bookmarked iOS folder alike.
        //
        // HTTP Range support is critical for video playback: without
        // it, WebKit can't seek a multi-MB .mov / .mp4 — every
        // currentTime change triggers a full file re-download that
        // saturates the IPC bridge and freezes the UI. With Range,
        // the WebView fetches small slices on demand and playback
        // streams smoothly.
        .register_uri_scheme_protocol("vaultasset", |ctx, request| {
            use tauri::Manager;
            let rel = percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
                .decode_utf8_lossy()
                .to_string();
            let state = ctx.app_handle().state::<vault_fs::VaultState>();
            let mime = vault_fs::mime_for(&rel);

            // Parse `Range: bytes=START-END` (END optional). Anything
            // else falls through to a full-body response.
            let range_header = request
                .headers()
                .get("Range")
                .or_else(|| request.headers().get("range"))
                .and_then(|v| v.to_str().ok());
            if let Some(range) = range_header.and_then(|r| r.strip_prefix("bytes=")) {
                let parts: Vec<&str> = range.split('-').collect();
                if parts.len() == 2 {
                    if let Ok(total) = vault_fs::asset_size(&state, &rel) {
                        if total > 0 {
                            // Open-ended (`bytes=START-`) gets capped at
                            // a streaming-friendly chunk so we don't tip
                            // the WebView's appetite back into "fetch
                            // everything in one go" territory.
                            const MAX_CHUNK: u64 = 4 * 1024 * 1024; // 4 MiB
                            let start: u64 = parts[0].parse().unwrap_or(0);
                            let end_request: u64 = if parts[1].is_empty() {
                                start + MAX_CHUNK - 1
                            } else {
                                parts[1].parse().unwrap_or(total - 1)
                            };
                            let end = end_request.min(total - 1);
                            if start <= end {
                                if let Ok((bytes, _)) = vault_fs::read_asset_range(&state, &rel, start, end) {
                                    return tauri::http::Response::builder()
                                        .status(206)
                                        .header("Content-Type", mime)
                                        .header("Content-Length", bytes.len().to_string())
                                        .header("Content-Range", format!("bytes {start}-{end}/{total}"))
                                        .header("Accept-Ranges", "bytes")
                                        .body(bytes)
                                        .unwrap();
                                }
                            }
                        }
                    }
                }
            }

            match vault_fs::read_asset(&state, &rel) {
                Ok(bytes) => {
                    let len = bytes.len();
                    tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", len.to_string())
                        // Advertise range support so video elements
                        // know they can seek without re-fetching.
                        .header("Accept-Ranges", "bytes")
                        .body(bytes)
                        .unwrap()
                }
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
            vault_fs::vault_list_dir,
            vault_fs::vault_import_files,
            vault_fs::vault_exists,
            vault_fs::vault_stat,
            vault_fs::vault_rename,
            vault_fs::vault_remove,
            vault_fs::vault_backup,
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
            vault::reveal_path,
            vault::open_terminal,
            vault::open_url,
            watcher::start_watcher,
            publish::publish_site,
            gcal::gcal_connect_account,
            gcal::gcal_list_accounts,
            gcal::gcal_set_default,
            gcal::gcal_disconnect,
            gcal::gcal_set_credentials,
            gcal::gcal_push_event,
            gcal::gcal_delete_event,
            gcal::gcal_list_day_events,
            gcal::gcal_set_ios_client_id,
            fts::fts_build_index,
            fts::fts_load_index,
            fts::fts_search,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let u = url.to_string();
                        if !(u.contains("code=") || u.contains("state=")) { continue; }
                        let pending = handle.state::<gcal::PendingAuth>();
                        let mut slot = pending.0.lock().unwrap();
                        if slot.is_some() {
                            let _ = slot.as_ref().unwrap().tx.send(u);
                            *slot = None;
                        }
                    }
                });
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
