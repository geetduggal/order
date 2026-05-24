const COMMANDS: &[&str] = &["pick_folder", "restore"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .ios_path("ios")
    .build();
}
