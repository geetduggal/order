# Google Calendar curated sync

Order lets you push hand-picked spacetime events to Google Calendar (with
invites) and pull events from Google back into your spacetime — all without
storing any Google IDs in your vault. The integration is **opt-in per event**:
an event syncs only when you write an email address on its line.

---

## The email-recipient model

Email addresses written at the end of a `spacetime.mw` event line are the
trigger and the instruction for sync. The format:

```
2026-06-26 09:00-09:30 : Standup              #[Acme] you@example.com
2026-06-26 14:00-15:00 : Planning             #[Acme] you@example.com dana@example.com sam@example.com
2026-06-27             : Product offsite       #[Acme] you@example.com
```

Emails come after the folder tag, space-separated. An event with **no emails
is an ordinary Order event** — the sync feature never touches it.

### Host vs. invitee rule

Order looks at the emails on the line and compares them to the Google accounts
you have connected in Settings:

- An email that **matches a connected account** → that account's calendar
  **hosts** the event. It is not sent an invite (it's you).
- An email that **matches no connected account** → an **invitee**. Google sends
  them an invitation.
- If **no** email matches any connected account → the **default account** hosts
  the event, and every email on the line is an invitee.

Example. Connected accounts: `you@example.com` (default), `you-personal@example.com`.

| Event line | Host | Invitees |
|---|---|---|
| `… you@example.com dana@example.com` | `you@example.com` | `dana@example.com` |
| `… dana@example.com sam@example.com` | `you@example.com` (default) | `dana@example.com`, `sam@example.com` |
| `… you-personal@example.com dana@example.com` | `you-personal@example.com` | `dana@example.com` |

### Natural-key identity — no stored IDs

Order identifies a Google event by its **date + time + title** — the same key
it uses for local dedup. No Google event ID is stored anywhere in your vault.
This means your files stay plain text and portable, at one deliberate cost: if
you edit an event's time or title in `spacetime.mw`, Order can no longer match
it to the previously pushed Google event. The review dialog surfaces this as a
new **Create** proposal; the stale Google event is yours to delete. Re-pushing
an **unchanged** event is always a no-op.

---

## Connecting an account

### Prerequisites: your own Google Cloud OAuth client

Order uses **your own** Google Cloud OAuth client credentials — the app is not
registered with Google's public consent screen. One-time setup:

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a
   project, and enable the **Google Calendar API**.
2. Configure an OAuth consent screen (Internal or External/Testing; add your
   Google accounts as Test Users while the app is in Testing mode).
3. Create an OAuth client ID:
   - **Desktop:** choose **"Desktop app"** as the application type.
   - **iOS:** choose **"iOS"** and enter `com.geetduggal.order` as the bundle ID.
4. Note the Client ID and, for desktop, the Client Secret.

### Entering credentials

Open **Settings → Google Calendar**. Order shows a credentials helper:

- **Desktop:** paste in your OAuth Client ID and Client Secret, then click
  **Save credentials**.
- **iOS:** paste in your iOS Client ID (no secret — iOS clients are public).

Credentials are saved in the app config directory, not in your vault.

### Connecting

With credentials saved, click **Connect Google account**:

- **Desktop (macOS):** Order opens a browser tab with the Google consent screen
  and starts a local loopback listener. Authorize in the browser; the tab closes
  automatically and the account appears in the connected list.
- **iOS:** Order opens the system browser for consent, then captures the
  authorization code via a custom URL scheme redirect
  (`com.geetduggal.order://oauth`). No embedded webview.

The resulting **refresh token is stored only in the OS Keychain** — never in
your vault files. You can connect multiple accounts; one is the default.

### Managing accounts

In **Settings → Google Calendar** you can:

- **Set default** — the account used when no connected-account email appears on
  an event line.
- **Disconnect** — removes the account from the connected list and deletes its
  token from the Keychain.

---

## Push — Order → Google Calendar

Spacetime events that carry at least one email are **Google-synced events**.
When you create or edit one, it surfaces in the bottom-left
**"spacetime · N pending"** reconciliation indicator the next time you pause.
Click the indicator to open the review dialog.

The review dialog has a **"Sync to Google"** section listing each Google-synced
event as a row:

- **Create** — the event has no match on Google (by natural key).
- **Update** — the event already exists on Google but its attendee list or
  description (note body) has changed.

Each row shows the host account and the invitee list. Check the rows you want to
push and click **Sync to Google**. Order calls the Google Calendar API
(`events.insert` or `events.patch` with `sendUpdates=all`) so invitees receive
email notifications.

The backing note's body becomes the Google event's **description**. Push again
after editing the note body to update the description.

---

## Import — Google Calendar → Order

A per-day import icon appears in the **Day** and **Week** calendar header for
each day. Clicking it lets you pull events from any connected Google account into
your spacetime.

**Flow:**

1. Click the download icon on a day header → select which connected account to
   pull from.
2. Order fetches that account's primary calendar events for the day.
3. A **review modal** lists the events:
   - **New events** (no natural-key match in spacetime) are pre-checked.
   - **Already present** events are pre-unchecked.
4. Pick a **target folder** (defaults to your home folder; any Notable Folder is
   selectable).
5. Click **Import selected**. Accepted events are written to `spacetime.mw` in
   the target folder, tagged with:
   - The **source account email** (so a future push identifies the correct host).
   - **Attendee emails** (guests from the Google event, resource rooms excluded).
   - The Google event's **description** becomes the backing note's body.

Recurring events are imported as flat standalone instances — no series modeling.

**Re-import** runs the same flow: already-present events are pre-unchecked, so
re-running is safe. A remotely edited event appears as a new row (the natural key
changed); a remotely deleted event is not flagged — it stays in spacetime until
you remove it. These are the accepted trade-offs of the no-ID model; every import
is human-reviewed before anything changes.

---

## iOS

Push and import work on iPhone once you have connected an account using the iOS
OAuth flow (system browser + custom URL scheme). Set your Google iOS Client ID in
**Settings → Google Calendar → Google iOS Client ID** before connecting.

---

## Testing-mode caveat

While your Google Cloud app is in **Testing** publishing mode (the default for
personal use), Google refresh tokens expire approximately weekly. When a token
expires you will see a "reconnect" prompt in Settings. Add your Google accounts
as **Test Users** on the OAuth consent screen to keep the flow working without
requesting Google verification.
