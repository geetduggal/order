use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::VaultExt;

#[command]
pub(crate) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<VaultFolder> {
    app.vault().pick_folder()
}

#[command]
pub(crate) async fn restore<R: Runtime>(app: AppHandle<R>) -> Result<VaultFolder> {
    app.vault().restore()
}
