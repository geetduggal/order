//! Apple EventKit (system calendar) integration — macOS + iOS.
//!
//! Mirrors the Google surface (`gcal.rs`): request permission, list the user's
//! calendars, import a day's events into the shared `ImportedEvent` shape, and
//! create/update events on a chosen calendar. EventKit's `attendees` are
//! READ-ONLY, so invitations stay a Google-only feature — Apple events are
//! created invite-free (see docs/APPLE-CAL.md).
//!
//! The commands are declared `async` so they run on Tauri's worker runtime, not
//! the UI main thread; each body is fully synchronous (no `.await`), so the
//! non-`Send` objc2 objects never cross a thread boundary.

use serde::{Deserialize, Serialize};

/// One calendar the user can include. `id` is the stable EventKit identifier.
#[derive(Debug, Clone, Serialize)]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    pub source: String,
    pub writable: bool,
}

/// Read from a day query — same shape the TS import path already consumes
/// (matches gcal::ImportedEvent field-for-field via camelCase serde).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEvent {
    pub title: String,
    pub date: String,
    pub time: Option<String>,
    pub end_time: Option<String>,
    pub end_date: Option<String>,
    pub all_day: bool,
    pub description: String,
    pub attendees: Vec<String>,
}

/// Create/update input for a single event on a chosen calendar.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEventInput {
    /// Target calendar identifier (from `applecal_list_calendars`).
    pub calendar_id: String,
    pub date: String,
    pub time: Option<String>,
    pub end_time: Option<String>,
    pub end_date: Option<String>,
    pub all_day: bool,
    pub title: String,
    pub description: String,
}

// ---- macOS / iOS: real EventKit ----------------------------------------
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::{CalendarInfo, ImportedEvent, SaveEventInput};
    use block2::RcBlock;
    use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKSpan,
    };
    use objc2_foundation::{NSArray, NSDate, NSError, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    fn nsstr(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    /// Local-day bounds [00:00, next 00:00) as Unix seconds.
    fn day_bounds(date: &str) -> Option<(f64, f64)> {
        let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
        let start = Local
            .from_local_datetime(&d.and_hms_opt(0, 0, 0)?)
            .single()?;
        let end = start + chrono::Duration::days(1);
        Some((start.timestamp() as f64, end.timestamp() as f64))
    }

    fn to_nsdate(date: &str, time: Option<&str>) -> Option<Retained<NSDate>> {
        let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
        let t = match time {
            Some(t) => NaiveTime::parse_from_str(t, "%H:%M").ok()?,
            None => NaiveTime::from_hms_opt(0, 0, 0)?,
        };
        let dt = Local
            .from_local_datetime(&NaiveDateTime::new(d, t))
            .single()?;
        Some(NSDate::dateWithTimeIntervalSince1970(dt.timestamp() as f64))
    }

    /// (YYYY-MM-DD, HH:MM) for an NSDate in local time.
    fn from_nsdate(d: &NSDate) -> Option<(String, String)> {
        let ts = d.timeIntervalSince1970();
        let dt = Local.timestamp_opt(ts as i64, 0).single()?;
        Some((dt.format("%Y-%m-%d").to_string(), dt.format("%H:%M").to_string()))
    }

    fn store() -> Retained<EKEventStore> {
        unsafe { EKEventStore::new() }
    }

    pub fn access_status() -> String {
        let s = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
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
        let (tx, rx) = mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        let completion = RcBlock::as_ptr(&handler) as *mut _;
        // requestFullAccessToEventsWithCompletion is macOS 14 / iOS 17+. On
        // older systems it doesn't exist, so fall back to the (now deprecated)
        // requestAccessToEntityType, which still grants event access there.
        // Without this, an older Mac never prompts and never sees calendars.
        unsafe {
            if st.respondsToSelector(objc2::sel!(requestFullAccessToEventsWithCompletion:)) {
                st.requestFullAccessToEventsWithCompletion(completion);
            } else {
                st.requestAccessToEntityType_completion(EKEntityType::Event, completion);
            }
        }
        // Keep `handler` alive until the completion fires (see recv below).
        let granted = rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "calendar access request timed out".to_string())?;
        drop(handler);
        Ok(granted)
    }

    pub fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
        let st = store();
        let cals = unsafe { st.calendarsForEntityType(EKEntityType::Event) };
        let mut out = Vec::new();
        for cal in cals.iter() {
            let id = unsafe { cal.calendarIdentifier() }.to_string();
            let title = unsafe { cal.title() }.to_string();
            let source = unsafe { cal.source() }
                .map(|s| unsafe { s.title() }.to_string())
                .unwrap_or_default();
            let writable = unsafe { cal.allowsContentModifications() };
            out.push(CalendarInfo { id, title, source, writable });
        }
        Ok(out)
    }

    fn calendars_for_ids(
        st: &EKEventStore,
        ids: &[String],
    ) -> Retained<NSArray<EKCalendar>> {
        let all = unsafe { st.calendarsForEntityType(EKEntityType::Event) };
        if ids.is_empty() {
            return all;
        }
        let picked: Vec<Retained<EKCalendar>> = all
            .iter()
            .filter(|c| {
                let id = unsafe { c.calendarIdentifier() }.to_string();
                ids.iter().any(|w| w == &id)
            })
            .collect();
        NSArray::from_retained_slice(&picked)
    }

    pub fn list_day_events(ids: Vec<String>, date: String) -> Result<Vec<ImportedEvent>, String> {
        let (start, end) = day_bounds(&date).ok_or("bad date")?;
        let st = store();
        let cals = calendars_for_ids(&st, &ids);
        let s = NSDate::dateWithTimeIntervalSince1970(start);
        let e = NSDate::dateWithTimeIntervalSince1970(end);
        let pred = unsafe {
            st.predicateForEventsWithStartDate_endDate_calendars(&s, &e, Some(&cals))
        };
        let events = unsafe { st.eventsMatchingPredicate(&pred) };
        let mut out = Vec::new();
        for ev in events.iter() {
            let title = unsafe { ev.title() }.to_string();
            let description = unsafe { ev.notes() }.map(|n| n.to_string()).unwrap_or_default();
            let all_day = unsafe { ev.isAllDay() };
            let start_date = unsafe { ev.startDate() };
            let (date_s, time_s) = match from_nsdate(&start_date) {
                Some(v) => v,
                None => continue,
            };
            let end_nsdate = unsafe { ev.endDate() };
            let (edate, etime) =
                from_nsdate(&end_nsdate).unwrap_or((date_s.clone(), String::new()));
            let end_date = if edate != date_s { Some(edate) } else { None };
            let end_time = Some(etime);
            let attendees: Vec<String> = unsafe { ev.attendees() }
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| {
                            let url = unsafe { p.URL() };
                            let s = url.absoluteString().map(|a| a.to_string())?;
                            s.strip_prefix("mailto:").map(|m| m.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(ImportedEvent {
                title,
                date: date_s,
                time: if all_day { None } else { Some(time_s) },
                end_time: if all_day { None } else { end_time },
                end_date,
                all_day,
                description,
                attendees,
            });
        }
        Ok(out)
    }

    fn find_calendar(st: &EKEventStore, id: &str) -> Option<Retained<EKCalendar>> {
        unsafe { st.calendarWithIdentifier(&nsstr(id)) }
    }

    /// Existing event in this calendar+day matching (title, HH:MM), for update.
    fn find_existing(
        st: &EKEventStore,
        cal: &EKCalendar,
        date: &str,
        time: Option<&str>,
        title: &str,
    ) -> Option<Retained<EKEvent>> {
        let (start, end) = day_bounds(date)?;
        let s = NSDate::dateWithTimeIntervalSince1970(start);
        let e = NSDate::dateWithTimeIntervalSince1970(end);
        let arr = NSArray::from_slice(&[cal]);
        let pred =
            unsafe { st.predicateForEventsWithStartDate_endDate_calendars(&s, &e, Some(&arr)) };
        let events = unsafe { st.eventsMatchingPredicate(&pred) };
        for ev in events.iter() {
            let etitle = unsafe { ev.title() }.to_string();
            if etitle != title {
                continue;
            }
            let esd = unsafe { ev.startDate() };
            let etime = from_nsdate(&esd).map(|(_, t)| t);
            if time.is_none() || time.map(|t| t.to_string()) == etime {
                return Some(ev);
            }
        }
        None
    }

    pub fn save_event(input: SaveEventInput) -> Result<String, String> {
        let st = store();
        let cal = find_calendar(&st, &input.calendar_id).ok_or("calendar not found")?;
        if !unsafe { cal.allowsContentModifications() } {
            return Err("calendar is read-only".into());
        }
        let ev = find_existing(&st, &cal, &input.date, input.time.as_deref(), &input.title)
            .unwrap_or_else(|| unsafe { EKEvent::eventWithEventStore(&st) });

        let start = to_nsdate(&input.date, input.time.as_deref()).ok_or("bad start")?;
        let end = if input.all_day {
            to_nsdate(input.end_date.as_deref().unwrap_or(&input.date), None).ok_or("bad end")?
        } else {
            to_nsdate(
                input.end_date.as_deref().unwrap_or(&input.date),
                input.end_time.as_deref().or(input.time.as_deref()),
            )
            .ok_or("bad end")?
        };
        unsafe {
            ev.setCalendar(Some(&cal));
            ev.setTitle(Some(&nsstr(&input.title)));
            ev.setAllDay(input.all_day);
            ev.setStartDate(Some(&start));
            ev.setEndDate(Some(&end));
            ev.setNotes(Some(&nsstr(&input.description)));
        }
        unsafe { st.saveEvent_span_error(&ev, EKSpan::ThisEvent) }
            .map_err(|e| e.localizedDescription().to_string())?;
        Ok(unsafe { ev.eventIdentifier() }
            .map(|s| s.to_string())
            .unwrap_or_default())
    }

    pub fn delete_event(
        calendar_id: String,
        date: String,
        time: Option<String>,
        title: String,
    ) -> Result<String, String> {
        let st = store();
        let cal = find_calendar(&st, &calendar_id).ok_or("calendar not found")?;
        match find_existing(&st, &cal, &date, time.as_deref(), &title) {
            Some(ev) => {
                unsafe { st.removeEvent_span_error(&ev, EKSpan::ThisEvent) }
                    .map_err(|e| e.localizedDescription().to_string())?;
                Ok("deleted".into())
            }
            None => Ok("absent".into()),
        }
    }
}

// ---- non-Apple stubs (so the crate builds on any host) -----------------
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::{CalendarInfo, ImportedEvent, SaveEventInput};
    pub fn access_status() -> String {
        "unsupported".into()
    }
    pub fn request_access() -> Result<bool, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
    pub fn list_calendars() -> Result<Vec<CalendarInfo>, String> {
        Ok(Vec::new())
    }
    pub fn list_day_events(_ids: Vec<String>, _date: String) -> Result<Vec<ImportedEvent>, String> {
        Ok(Vec::new())
    }
    pub fn save_event(_input: SaveEventInput) -> Result<String, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
    pub fn delete_event(
        _calendar_id: String,
        _date: String,
        _time: Option<String>,
        _title: String,
    ) -> Result<String, String> {
        Err("EventKit is only available on macOS/iOS".into())
    }
}

// ---- Tauri commands ----------------------------------------------------

#[tauri::command]
pub async fn applecal_access_status() -> String {
    imp::access_status()
}

#[tauri::command]
pub async fn applecal_request_access() -> Result<bool, String> {
    imp::request_access()
}

#[tauri::command]
pub async fn applecal_list_calendars() -> Result<Vec<CalendarInfo>, String> {
    imp::list_calendars()
}

#[tauri::command]
pub async fn applecal_list_day_events(
    calendar_ids: Vec<String>,
    date: String,
) -> Result<Vec<ImportedEvent>, String> {
    imp::list_day_events(calendar_ids, date)
}

#[tauri::command]
pub async fn applecal_save_event(input: SaveEventInput) -> Result<String, String> {
    imp::save_event(input)
}

#[tauri::command]
pub async fn applecal_delete_event(
    calendar_id: String,
    date: String,
    time: Option<String>,
    title: String,
) -> Result<String, String> {
    imp::delete_event(calendar_id, date, time, title)
}
