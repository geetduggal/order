use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Vault<R>> {
  Ok(Vault(app.clone()))
}

/// Access to the vault APIs.
pub struct Vault<R: Runtime>(AppHandle<R>);

// On desktop the vault folder is chosen via the dialog plugin + absolute
// paths, so these are no-ops; the frontend never calls them off iOS.
impl<R: Runtime> Vault<R> {
  pub fn pick_folder(&self) -> crate::Result<VaultFolder> {
    Ok(VaultFolder::default())
  }

  pub fn restore(&self) -> crate::Result<VaultFolder> {
    Ok(VaultFolder::default())
  }

  /// Desktop never calls the plugin path — the main vault::open_url
  /// command spawns `open` / `xdg-open` / `cmd /C start` directly —
  /// but the API has to exist for the trait to compile across
  /// platforms.
  pub fn open_url(&self, _url: String) -> crate::Result<()> {
    Ok(())
  }
}
