//! App-icon badge (iOS / macOS) — a small count on the Order icon.
//!
//! Used for the optional "events this Saturday in the Week Hub folder" badge.
//! The number is computed in the frontend; this module just requests badge
//! authorization once and writes the count via UNUserNotificationCenter
//! (iOS 16+ / macOS 11+), which is thread-safe (no main-thread hop needed).
//!
//! Commands are `async` so they run on Tauri's worker runtime; each body is
//! fully synchronous, so the non-`Send` objc2 objects never cross threads.

// Force-link UserNotifications so `UNUserNotificationCenter` is available.
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[link(name = "UserNotifications", kind = "framework")]
extern "C" {}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use block2::RcBlock;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSError;
    use std::sync::mpsc;
    use std::time::Duration;

    /// UNAuthorizationOptionBadge is `(1 << 0)` — badge only, no alerts/sounds.
    /// (Not `1 << 3`, which is `UNAuthorizationOptionCarPlay` and never shows a
    /// notification prompt — the cause of "no prompt appears".)
    const UN_AUTH_BADGE: usize = 1 << 0;

    /// A proper `.app` bundle has a bundle identifier; a bare `cargo run` / dev
    /// binary does not. `UNUserNotificationCenter currentNotificationCenter`
    /// hard-crashes (bundleProxyForCurrentProcess is nil) when unbundled, so we
    /// gate on this and return a soft error instead — the frontend ignores it.
    fn is_bundled() -> bool {
        let bundle: *mut AnyObject = unsafe { msg_send![class!(NSBundle), mainBundle] };
        if bundle.is_null() {
            return false;
        }
        let ident: *mut AnyObject = unsafe { msg_send![bundle, bundleIdentifier] };
        !ident.is_null()
    }

    fn center() -> *mut AnyObject {
        unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
    }

    /// Ask for badge authorization (the standard notifications prompt, shown
    /// once). Returns whether it's granted.
    pub fn request_permission() -> Result<bool, String> {
        if !is_bundled() {
            return Err("badge/notifications need a bundled app (unavailable in dev)".into());
        }
        let c = center();
        if c.is_null() {
            return Err("notification center unavailable".into());
        }
        let (tx, rx) = mpsc::channel::<(bool, Option<String>)>();
        let handler = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let msg = if err.is_null() {
                None
            } else {
                let e: &NSError = unsafe { &*err };
                Some(e.localizedDescription().to_string())
            };
            let _ = tx.send((granted.as_bool(), msg));
        });
        let completion = RcBlock::as_ptr(&handler) as *mut _;
        unsafe {
            let _: () = msg_send![c, requestAuthorizationWithOptions: UN_AUTH_BADGE, completionHandler: completion];
        }
        let (granted, err) = rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| "badge permission request timed out".to_string())?;
        drop(handler);
        if granted {
            Ok(true)
        } else {
            Err(err.unwrap_or_else(|| "notifications permission was not granted".into()))
        }
    }

    /// Write the icon badge count (0 clears it).
    pub fn set_badge(count: i64) -> Result<(), String> {
        if !is_bundled() {
            return Err("badge unavailable in an unbundled (dev) binary".into());
        }
        let c = center();
        if c.is_null() {
            return Err("notification center unavailable".into());
        }
        let n = count.max(0) as isize;
        let responds: Bool = unsafe { msg_send![c, respondsToSelector: sel!(setBadgeCount:withCompletionHandler:)] };
        if !responds.as_bool() {
            return Err("setBadgeCount is unavailable (needs iOS 16+ / macOS 11+)".into());
        }
        let nil_completion: *mut AnyObject = std::ptr::null_mut();
        unsafe {
            let _: () = msg_send![c, setBadgeCount: n, withCompletionHandler: nil_completion];
        }
        Ok(())
    }
}

/// Request badge/notification authorization. No-op (returns false) off Apple.
#[tauri::command]
pub async fn badge_request_permission() -> Result<bool, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::request_permission()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(false)
    }
}

/// Set the app-icon badge count (0 clears). No-op off Apple.
#[tauri::command]
pub async fn badge_set(count: i64) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::set_badge(count)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = count;
        Ok(())
    }
}
