use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Vault;
#[cfg(mobile)]
use mobile::Vault;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the vault APIs.
pub trait VaultExt<R: Runtime> {
  fn vault(&self) -> &Vault<R>;
}

impl<R: Runtime, T: Manager<R>> crate::VaultExt<R> for T {
  fn vault(&self) -> &Vault<R> {
    self.state::<Vault<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("vault")
    .invoke_handler(tauri::generate_handler![commands::pick_folder, commands::restore])
    .setup(|app, api| {
      #[cfg(mobile)]
      let vault = mobile::init(app, api)?;
      #[cfg(desktop)]
      let vault = desktop::init(app, api)?;
      app.manage(vault);
      Ok(())
    })
    .build()
}
