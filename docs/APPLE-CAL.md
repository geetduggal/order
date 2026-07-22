# Apple / system calendar (EventKit)

Order integrates with the macOS and iOS **system calendars** through Apple's
EventKit: pick which calendars to include, import a day's events into spacetime,
and create events on a calendar you choose — all native, no accounts or OAuth.

This is the Apple counterpart to [Google Calendar sync](GCAL-SYNC.md). The two
work side by side.

---

## Permission

EventKit needs one grant. In **Settings → Apple Calendar**, click **Grant
calendar access**; the OS shows its permission prompt. There are no credentials
to set up — unlike Google, EventKit is built into the OS.

If you deny it, re-enable under **System Settings → Privacy & Security →
Calendars** (macOS) or **Settings → Privacy → Calendars** (iOS), then reopen
Order.

## Choosing calendars

Once access is granted, Settings lists every calendar EventKit sees — iCloud,
a Google account subscribed in the system Calendar app, "On My Mac", etc. Tick
the ones you want Order to read when importing a day. The selection is stored on
this device.

## Importing a day

In the Day or Week calendar, each day header has a small **import from system
calendar** button (next to the Google one). Click it and Order pulls that day's
events from your ticked calendars into the same review modal the Google import
uses: new events are pre-checked, ones you already have are unchecked, and
accepted events are written to `spacetime.md` in the folder you choose.

## Creating events on a calendar

Assign a spacetime event to a system calendar with an `@[Calendar Name]` token
on its line — the Apple counterpart to Google's email trigger:

```
2026-07-25             : Furniture day  #[Living Room Refresh] @[Home]
2026-07-20 09:00-09:30 : Sprint sync    #[Map Pipeline v2]     @[Work]
```

Order creates (or updates) the event on that calendar automatically. Identity is
the natural key `(date, time, title)` — no EventKit IDs are stored, so a device
that hasn't seen the event creates it, and an edit updates the existing one.
Removing the `@[Calendar]` token (or the event) deletes it from the calendar.

The token is order-independent with the folder tag and Google emails; the
canonical written form is `Title #[Folder] @[Calendar] emails…`.

## Invitations are Google-only

Apple's EventKit exposes an event's attendees as **read-only**: Order can *read*
guests when importing, but the API does **not** allow adding invitees when
creating an event (on macOS or iOS). So events Order creates on an Apple calendar
are **invite-free**. To send invitations, use the [Google path](GCAL-SYNC.md) —
put email addresses on the event line and Google hosts + invites. An event can
carry both an `@[Calendar]` token (mirrored to Apple) and emails (invited via
Google) if you want both.

## Under the hood

- Native EventKit via the `objc2-event-kit` crate (`src-tauri/src/applecal.rs`);
  the same code serves macOS and iOS.
- The `NSCalendarsFullAccessUsageDescription` usage string lives in the tracked
  `src-tauri/Info.plist` (see `docs/ios-build-notes.md` for the iOS re-apply
  note after `tauri ios init`).
- TS bridge: `src/lib/apple-cal.ts`; idempotent create record:
  `src/lib/apple-sync-plan.ts`; the `@[Calendar]` convention lives in
  `src/lib/spacetime.ts`.
