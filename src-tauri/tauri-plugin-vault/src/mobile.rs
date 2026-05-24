use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_vault);

pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Vault<R>> {
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_vault)?;
  Ok(Vault(handle))
}

/// Access to the vault APIs.
pub struct Vault<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Vault<R> {
  /// Present the iOS folder picker; on selection, mint + persist a
  /// security-scoped bookmark and return the resolved path + name.
  pub fn pick_folder(&self) -> crate::Result<VaultFolder> {
    self.0.run_mobile_plugin("pickFolder", ()).map_err(Into::into)
  }

  /// Resolve the persisted bookmark, open scoped access for the session,
  /// and return its path (empty when none/stale).
  pub fn restore(&self) -> crate::Result<VaultFolder> {
    self.0.run_mobile_plugin("restore", ()).map_err(Into::into)
  }
}
