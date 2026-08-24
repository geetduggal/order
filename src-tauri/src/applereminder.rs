//! System Reminders (iOS / macOS) via EventKit — the sibling of applecal.rs.
//!
//! An Order event with `reminder: true` in its note frontmatter is mirrored to
//! the user's default Reminders list: a real EKReminder with a due date + an
//! alarm so the system notifies. The reminder's calendarItemIdentifier is stored
//! back in the note (`reminderId`) so toggling off / editing can update or remove
//! the exact item. Non-Apple hosts get stubs so the crate still builds.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReminderInput {
    pub title: String,
    pub date: String,          // YYYY-MM-DD
    pub time: Option<String>,  // HH:MM; None = all-day (due 09:00)
    #[serde(default)]
    pub notes: String,
    /// Existing calendarItemIdentifier to update in place (None = create).
    pub id: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::SaveReminderInput;
    use block2::RcBlock;
    use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2_event_kit::{EKAlarm, EKAuthorizationStatus, EKEntityType, EKEventStore, EKReminder};
    use objc2_foundation::{NSCalendar, NSCalendarUnit, NSDate, NSError, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    fn nsstr(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    fn store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::new() }
    }

    fn to_nsdate(date: &str, time: Option<&str>) -> Option<Retained<NSDate>> {
        let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
        let t = match time {
            Some(t) => NaiveTime::parse_from_str(t, "%H:%M").ok()?,
            None => NaiveTime::from_hms_opt(9, 0, 0)?, // all-day reminders default to 9am
        };
        let dt = Local
            .from_local_datetime(&NaiveDateTime::new(d, t))
            .single()?;
        Some(NSDate::dateWithTimeIntervalSince1970(dt.timestamp() as f64))
    }

    pub fn access_status() -> String {
        let s = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Reminder) };
        match s {
            EKAuthorizationStatus::NotDetermined => "notDetermined",
            EKAuthorizationStatus::Restricted => "restricted",
            EKAuthorizationStatus::Denied => "denied",
            EKAuthorizationStatus::FullAccess => "authorized",
            EKAuthorizationStatus::WriteOnly => "writeOnly",
            _ => "unknown",
        }
        .to_string()
    }

    #[allow(deprecated)]
    pub fn request_access() -> Result<bool, String> {
        let st = store();
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
            if st.respondsToSelector(objc2::sel!(requestFullAccessToRemindersWithCompletion:)) {
                st.requestFullAccessToRemindersWithCompletion(completion);
            } else {
                st.requestAccessToEntityType_completion(EKEntityType::Reminder, completion);
            }
        }
        let (granted, err_msg) = rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "reminders access request timed out (macOS never responded)".to_string())?;
        drop(handler);
        if granted {
            return Ok(true);
        }
        let status = access_status();
        if status == "denied" {
            return Err("Reminders access was denied. Enable Order under System Settings → Privacy & Security → Reminders.".into());
        }
        if let Some(m) = err_msg {
            return Err(format!("macOS declined the reminders request: {m} (status: {status})"));
        }
        Err(format!(
            "macOS did not present the reminders prompt (status: {status}). On a managed Mac an MDM policy may be blocking the prompt for this (non-notarized) app."
        ))
    }

    /// Fetch an existing EKReminder by its calendarItemIdentifier.
    fn find_by_id(st: &EKEventStore, id: &str) -> Option<Retained<EKReminder>> {
        if id.is_empty() {
            return None;
        }
        let item = unsafe { st.calendarItemWithIdentifier(&nsstr(id)) }?;
        item.downcast::<EKReminder>().ok()
    }

    pub fn save_reminder(input: SaveReminderInput) -> Result<String, String> {
        let st = store();
        let cal = unsafe { st.defaultCalendarForNewReminders() }
            .ok_or("no default Reminders list — open the Reminders app once to create one")?;
        let rem = input
            .id
            .as_deref()
            .and_then(|id| find_by_id(&st, id))
            .unwrap_or_else(|| unsafe { EKReminder::reminderWithEventStore(&st) });

        let due = to_nsdate(&input.date, input.time.as_deref()).ok_or("bad due date")?;
        let comps = NSCalendar::currentCalendar().components_fromDate(
            NSCalendarUnit::Year
                | NSCalendarUnit::Month
                | NSCalendarUnit::Day
                | NSCalendarUnit::Hour
                | NSCalendarUnit::Minute,
            &due,
        );
        unsafe {
            rem.setTitle(Some(&nsstr(&input.title)));
            rem.setCalendar(Some(&cal));
            rem.setNotes(Some(&nsstr(&input.notes)));
            rem.setDueDateComponents(Some(&comps));
            // A fresh alarm at the due time so the system actually notifies.
            rem.setAlarms(None);
            rem.addAlarm(&EKAlarm::alarmWithAbsoluteDate(&due));
        }
        unsafe { st.saveReminder_commit_error(&rem, true) }
            .map_err(|e| e.localizedDescription().to_string())?;
        Ok(unsafe { rem.calendarItemIdentifier() }.to_string())
    }

    pub fn delete_reminder(id: String) -> Result<String, String> {
        let st = store();
        match find_by_id(&st, &id) {
            Some(rem) => {
                unsafe { st.removeReminder_commit_error(&rem, true) }
                    .map_err(|e| e.localizedDescription().to_string())?;
                Ok("deleted".into())
            }
            None => Ok("absent".into()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::SaveReminderInput;
    pub fn access_status() -> String {
        "unsupported".into()
    }
    pub fn request_access() -> Result<bool, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
    pub fn save_reminder(_input: SaveReminderInput) -> Result<String, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
    pub fn delete_reminder(_id: String) -> Result<String, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
}

#[tauri::command]
pub async fn reminder_access_status() -> String {
    imp::access_status()
}

#[tauri::command]
pub async fn reminder_request_access() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(imp::request_access)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn reminder_save(input: SaveReminderInput) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || imp::save_reminder(input))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn reminder_delete(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || imp::delete_reminder(id))
        .await
        .map_err(|e| format!("join: {e}"))?
}
