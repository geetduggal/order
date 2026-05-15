fn should_use_external_media_preview_for_appimage(is_linux_appimage: bool) -> bool {
    is_linux_appimage
}

#[cfg(all(desktop, target_os = "linux"))]
fn linux_appimage_running() -> bool {
    crate::linux_appimage::is_running()
}

#[cfg(not(all(desktop, target_os = "linux")))]
fn linux_appimage_running() -> bool {
    false
}

#[tauri::command]
pub fn should_use_external_media_preview() -> bool {
    should_use_external_media_preview_for_appimage(linux_appimage_running())
}

#[cfg(test)]
mod tests {
    use super::should_use_external_media_preview_for_appimage;

    #[test]
    fn external_media_preview_is_limited_to_linux_appimage() {
        assert!(should_use_external_media_preview_for_appimage(true));
        assert!(!should_use_external_media_preview_for_appimage(false));
    }
}
