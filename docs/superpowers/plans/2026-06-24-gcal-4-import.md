# GCal Sync — Plan 4: Import (Google → Order)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pull a day's Google Calendar events into spacetime via a per-day import icon in the Day/Week calendar → pick which events to accept and a target folder → curated events become spacetime events.

**Architecture:** A Rust command `gcal_list_day_events` fetches a day's primary-calendar events for an account and returns a normalized list (pure `parse_day_events` does the JSON→struct, unit-tested). TS `classifyImports` (pure, tested) marks each fetched event "new" or "already have" by natural key against current spacetime events. A per-day import icon in CalendarView's `dayHeaderContent` calls back to CardGrid, which fetches, classifies, shows a review modal (checkboxes + target-folder picker), and applies accepted events via `mwAddEvent` (each tagged with the source account email + folder), creating a backing note whose body is the imported description.

**Tech Stack:** Rust (`ureq`, `serde_json`), React/TS, FullCalendar `dayHeaderContent`. Rust unit tests via `cargo test`; TS via standalone `tsx` scripts.

## Global Constraints

- Natural-key identity `(date, time, title)`; no stored Google id. Re-import: events already present (by key) are pre-UNCHECKED; the user curates which to accept. Remotely-deleted events are NOT auto-detected (manual cleanup) — the deliberate no-id tradeoff.
- Imported events carry the **source account's email** on the line (so they're recognized as that calendar's event, host = that account, no invite) and round-trip cleanly. Description → the backing note's body.
- v1 imports the account's **primary** calendar only; recurrence **instances** are imported flat; attendee import is NOT done (just the event onto your calendar).
- Times: Google returns dateTimes in the calendar's timezone with an offset; v1 takes the wall-clock date + HH:MM directly from that string (correct when the calendar's tz is your local tz).
- Desktop-only (rides Plan 2 OAuth). spacetime.mw is the source of truth — import WRITES it (adds events) via `applyMwEdit`/`mwAddEvent`.
- No Claude/AI git authorship trailers.

---

### Task 1: `gcal_list_day_events` + pure `parse_day_events` (Rust, cargo-TDD)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (struct + parser + command; tests)
- Modify: `src-tauri/src/lib.rs` (register `gcal::gcal_list_day_events`)

**Interfaces:**
- Produces:
  - `pub struct ImportedEvent { pub title: String, pub date: String, pub time: Option<String>, pub end_time: Option<String>, pub all_day: bool, pub description: String }` (serde Serialize).
  - `pub fn parse_day_events(list_body: &str) -> Vec<ImportedEvent>` — maps an events.list response: `summary`→title; timed `start.dateTime`→date (chars 0..10) + time (11..16), `end.dateTime`→end_time; all-day `start.date`→date with all_day=true; `description`→description (empty if absent). Items without a usable start are skipped.
  - `#[tauri::command] gcal_list_day_events(app, account: String, date: String) -> Result<Vec<ImportedEvent>, String>` — token via `fetch_access_token`, GET the primary calendar with `singleEvents=true&timeMin&timeMax` for that local day, parse via `parse_day_events`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/gcal.rs`:

```rust
    #[test]
    fn parse_day_events_mixed() {
        let body = r#"{"items":[
          {"summary":"Standup","start":{"dateTime":"2026-06-25T09:00:00-07:00"},"end":{"dateTime":"2026-06-25T09:15:00-07:00"},"description":"daily"},
          {"summary":"Holiday","start":{"date":"2026-06-25"},"end":{"date":"2026-06-26"}},
          {"start":{"dateTime":"2026-06-25T12:00:00-07:00"}}
        ]}"#;
        let v = parse_day_events(body);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].title, "Standup");
        assert_eq!(v[0].date, "2026-06-25");
        assert_eq!(v[0].time.as_deref(), Some("09:00"));
        assert_eq!(v[0].end_time.as_deref(), Some("09:15"));
        assert!(!v[0].all_day);
        assert_eq!(v[0].description, "daily");
        assert_eq!(v[1].title, "Holiday");
        assert!(v[1].all_day);
        assert_eq!(v[1].date, "2026-06-25");
        assert_eq!(v[1].time, None);
        // Missing summary → empty title; still parsed (timed).
        assert_eq!(v[2].title, "");
        assert_eq!(v[2].time.as_deref(), Some("12:00"));
    }

    #[test]
    fn parse_day_events_skips_no_start() {
        let body = r#"{"items":[{"summary":"Cancelled"}]}"#;
        assert!(parse_day_events(body).is_empty());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function parse_day_events` / type `ImportedEvent`.

- [ ] **Step 3: Implement the struct + parser**

Add to `src-tauri/src/gcal.rs` (above the test module):

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]  // end_time→endTime, all_day→allDay for the TS bridge
pub struct ImportedEvent {
    pub title: String,
    pub date: String,
    pub time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
    pub description: String,
}

/// Map a Calendar events.list response into normalized ImportedEvents. Takes
/// the wall-clock date + HH:MM straight from the returned dateTime (which is in
/// the calendar's timezone). Items without a usable start are skipped.
pub fn parse_day_events(list_body: &str) -> Vec<ImportedEvent> {
    let v: serde_json::Value = match serde_json::from_str(list_body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match v.get("items").and_then(|i| i.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for it in items {
        let title = it.get("summary").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let description = it.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
        let start = match it.get("start") { Some(s) => s, None => continue };
        let hhmm = |obj: &serde_json::Value, key: &str| -> Option<String> {
            obj.get(key).and_then(|d| d.as_str()).and_then(|dt| dt.get(11..16).map(|s| s.to_string()))
        };
        if let Some(date) = start.get("date").and_then(|d| d.as_str()) {
            out.push(ImportedEvent { title, date: date.to_string(), time: None, end_time: None, all_day: true, description });
        } else if let Some(dt) = start.get("dateTime").and_then(|d| d.as_str()) {
            let date = dt.get(0..10).unwrap_or("").to_string();
            if date.is_empty() { continue; }
            let time = dt.get(11..16).map(|s| s.to_string());
            let end_time = it.get("end").and_then(|e| hhmm(e, "dateTime"));
            out.push(ImportedEvent { title, date, time, end_time, all_day: false, description });
        }
    }
    out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -20`
Expected: all gcal tests pass (now 12).

- [ ] **Step 5: Implement the command**

Add to `src-tauri/src/gcal.rs` (above the test module). Reuses `local_rfc3339`, `next_day`, `enc`, `agent`, `cal_get`, `fetch_access_token`, `load_config`, `config_dir` (all already present from Plan 3).

```rust
#[tauri::command]
pub async fn gcal_list_day_events(app: tauri::AppHandle, account: String, date: String) -> Result<Vec<ImportedEvent>, String> {
    let cfg = load_config(&config_dir(&app)?);
    let token = fetch_access_token(&cfg, &account)?;
    let tmin = local_rfc3339(&date, "00:00")?;
    let tmax = local_rfc3339(&next_day(&date)?, "00:00")?;
    let url = format!(
        "{CAL_BASE}?singleEvents=true&orderBy=startTime&timeMin={}&timeMax={}",
        enc(&tmin), enc(&tmax)
    );
    let (s, b) = cal_get(&token, &url)?;
    if s >= 400 {
        return Err(format!("calendar list failed ({s}): {b}"));
    }
    Ok(parse_day_events(&b))
}
```

- [ ] **Step 6: Register the command**

In `src-tauri/src/lib.rs` `generate_handler!`, after `gcal::gcal_push_event,`, add:

```rust
            gcal::gcal_list_day_events,
```

- [ ] **Step 7: Compile + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -6` → compiles.
Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -5` → 12 pass.

```bash
git add src-tauri/src/gcal.rs src-tauri/src/lib.rs
git commit -m "feat: gcal_list_day_events + parse_day_events (import fetch)"
```

---

### Task 2: `classifyImports` — pure import diff (TS, TDD)

**Files:**
- Create: `src/lib/gcal-import.ts`
- Create: `src/lib/gcal-import.test.ts`

**Interfaces:**
- Consumes: `SpacetimeEvent` from `../lib/spacetime`.
- Produces: `export interface ImportedEvent { title: string; date: string; time?: string; endTime?: string; allDay: boolean; description: string }` and `export interface ImportRow extends ImportedEvent { isNew: boolean }` and `export function classifyImports(imported: ImportedEvent[], existing: SpacetimeEvent[]): ImportRow[]` — `isNew` is true when no existing event shares the natural key `${date}|${time||""}|${title.toLowerCase()}`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/gcal-import.test.ts`:

```ts
// Run: npx tsx src/lib/gcal-import.test.ts  → "ALL CHECKS PASS"
import { classifyImports, type ImportedEvent } from "./gcal-import";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const existing: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "Standup", time: "09:00" },
  { date: "2026-06-25", title: "Holiday", allDay: true },
];
const imported: ImportedEvent[] = [
  { title: "Standup", date: "2026-06-25", time: "09:00", allDay: false, description: "x" },  // already have
  { title: "New mtg", date: "2026-06-25", time: "11:00", allDay: false, description: "" },     // new
  { title: "Holiday", date: "2026-06-25", allDay: true, description: "" },                      // already have (all-day)
];

assertEq(classifyImports(imported, existing).map((r) => [r.title, r.isNew]), [
  ["Standup", false], ["New mtg", true], ["Holiday", false],
], "classify new vs already-have by natural key");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/gcal-import.test.ts`
Expected: FAIL — `Cannot find module './gcal-import'`.

- [ ] **Step 3: Implement**

Create `src/lib/gcal-import.ts`:

```ts
// Pure classification of fetched Google events against current spacetime
// events by natural key (date|time|title). Drives the import review's
// pre-checked state: new events are checked, already-present ones unchecked.
import type { SpacetimeEvent } from "./spacetime";

export interface ImportedEvent {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  allDay: boolean;
  description: string;
}

export interface ImportRow extends ImportedEvent {
  isNew: boolean;
}

const key = (date: string, time: string | undefined, title: string) =>
  `${date}|${time ?? ""}|${title.toLowerCase()}`;

export function classifyImports(imported: ImportedEvent[], existing: SpacetimeEvent[]): ImportRow[] {
  const have = new Set(existing.map((e) => key(e.date, e.time, e.title)));
  return imported.map((ev) => ({ ...ev, isNew: !have.has(key(ev.date, ev.time, ev.title)) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx src/lib/gcal-import.test.ts`
Expected: one `ok:` line then `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/gcal-import.ts src/lib/gcal-import.test.ts
git commit -m "feat: classifyImports — new-vs-have diff for Google import"
```

---

### Task 3: TS bridge + per-day import icon (CalendarView)

**Files:**
- Modify: `src/lib/gcal-accounts.ts` (add `listDayEvents` bridge + re-export `ImportedEvent`)
- Modify: `src/components/CalendarView.tsx` (an `onImportDay` prop + a `dayHeaderContent` import icon in Day/Week views)

**Interfaces:**
- Consumes: `gcal_list_day_events` (Task 1).
- Produces: `listDayEvents(account, date)` bridge; CalendarView prop `onImportDay?: (dateIso: string) => void`.

- [ ] **Step 1: Add the bridge**

In `src/lib/gcal-accounts.ts`, add:

```ts
import type { ImportedEvent } from "./gcal-import";
export const listDayEvents = (account: string, date: string) =>
  invoke<ImportedEvent[]>("gcal_list_day_events", { account, date });
```

- [ ] **Step 2: Add the `onImportDay` prop**

In `src/components/CalendarView.tsx`, find the props the component destructures (the `props` object — `const { notes, initialView, onMoveEvent ... } = props;` and the matching prop type). Add `onImportDay` to both the type and the destructure:

```ts
  onImportDay?: (dateIso: string) => void;
```

(Add it to the props interface/type near `onEventClick?`, and to the destructuring assignment.)

- [ ] **Step 3: Render a per-day import icon in Day/Week headers**

Add a `dayHeaderContent` render function to the `<FullCalendar>` element (near `eventContent={renderEventContent}`):

```tsx
        dayHeaderContent={(arg) => {
          const iso = arg.date.toISOString().slice(0, 10);
          const isTimeGrid = arg.view.type === "timeGridDay" || arg.view.type === "timeGridWeek";
          return (
            <span className="fc-day-header-inner">
              <span>{arg.text}</span>
              {isTimeGrid && onImportDay && (
                <button
                  type="button"
                  className="fc-day-import-btn"
                  title="Import this day from Google"
                  aria-label="Import this day from Google"
                  onClick={(e) => { e.stopPropagation(); onImportDay(iso); }}
                >
                  <DownloadIcon size={11} strokeWidth={2.2} />
                </button>
              )}
            </span>
          );
        }}
```

Add `import { Download as DownloadIcon } from "lucide-react";` to CalendarView's imports.

- [ ] **Step 4: Add minimal styles**

Append to `src/styles.css`:

```css
.fc-day-header-inner { display: inline-flex; align-items: center; gap: 4px; justify-content: center; }
.fc-day-import-btn { display: inline-flex; align-items: center; justify-content: center; padding: 1px; border: none; background: transparent; color: var(--ink-faint); cursor: pointer; border-radius: 3px; opacity: 0; }
.fc-col-header-cell:hover .fc-day-import-btn { opacity: 1; }
.fc-day-import-btn:hover { color: var(--royal); background: var(--royal-soft); }
```

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output. (CardGrid doesn't pass `onImportDay` yet — that's Task 4; the optional prop keeps this compiling.)

```bash
git add src/lib/gcal-accounts.ts src/components/CalendarView.tsx src/styles.css
git commit -m "feat: per-day Google import icon in Day/Week headers + bridge"
```

---

### Task 4: Import flow + review modal (CardGrid)

**Files:**
- Modify: `src/components/CardGrid.tsx` (import handler, review modal state + JSX, wire `onImportDay` to the `<CalendarView>` renders)

**Interfaces:**
- Consumes: `listDayEvents`, `listAccounts` (Plan 2), `classifyImports` (Task 2), `applyMwEdit` + `mwAddEvent` (Plan 1/existing), `notableFolders`/`homeFolderRef`/`noteDirByRef`/`uniqueWrite`/`basenameForEvent`/`joinFrontmatter`/`vaultRoot` (existing).

- [ ] **Step 1: Add the import state + handler**

In `src/components/CardGrid.tsx`, near the Google push state (the `gcalAccounts`/`gcalPending` block), add the import review state and handlers. `classifyImports`/`ImportRow` are imported statically; `mwAddEvent` is already imported.

```ts
  // Import review modal: the day being imported, the rows (checked = accept),
  // the chosen account, and the target folder.
  const [importReview, setImportReview] = useState<{ date: string; account: string; rows: (import("../lib/gcal-import").ImportRow & { accept: boolean })[]; folder: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const startImport = useCallback(async (dateIso: string) => {
    try {
      const m = await import("../lib/gcal-accounts");
      const acc = await m.listAccounts();
      if (acc.accounts.length === 0) { await tauriMessage("Connect a Google account in Settings first.", { title: "Import" }); return; }
      const account = acc.default ?? acc.accounts[0];
      const fetched = await m.listDayEvents(account, dateIso);
      if (fetched.length === 0) { await tauriMessage(`No Google events on ${dateIso}.`, { title: "Import" }); return; }
      const { classifyImports } = await import("../lib/gcal-import");
      const dayEvents = mwEventsRefForImport.current.filter((e) => e.date === dateIso);
      const rows = classifyImports(fetched, dayEvents).map((r) => ({ ...r, accept: r.isNew }));
      setImportReview({ date: dateIso, account, rows, folder: homeFolderRef.current ?? "" });
    } catch (e) { await tauriMessage(`Import failed: ${String(e)}`, { title: "Import", kind: "error" }); }
  }, []);

  const applyImport = useCallback(async () => {
    const review = importReview;
    if (!review) return;
    setImportBusy(true);
    try {
      const accepted = review.rows.filter((r) => r.accept);
      const root = await vaultRoot();
      const dir = (review.folder && noteDirByRef(review.folder)) || root;
      // Create a backing note (description body) for each accepted event, then
      // add all events to spacetime.mw in one edit (tagged with the source
      // account email so they're recognized as that calendar's events).
      for (const r of accepted) {
        const fm: Frontmatter = {
          date: r.date,
          allDay: r.allDay,
          ...(r.time ? { startTime: r.time } : {}),
          ...(r.endTime ? { endTime: r.endTime } : {}),
          ...(review.folder ? { folder: `[[${review.folder}]]` } : {}),
          title: r.title,
        };
        const body = `# ${r.title}\n${r.description ? `\n${r.description}\n` : ""}`;
        await uniqueWrite(dir, basenameForEvent(r.date, r.title), joinFrontmatter(fm, body));
      }
      await applyMwEdit((mw) => accepted.reduce((acc, r) => mwAddEvent(acc, {
        date: r.date,
        title: r.title,
        ...(r.time ? { time: r.time } : {}),
        ...(r.endTime ? { endTime: r.endTime } : {}),
        ...(r.allDay ? { allDay: true } : {}),
        ...(review.folder ? { folder: review.folder } : {}),
        emails: [review.account],
      }), mw));
      setImportReview(null);
      await tauriMessage(`Imported ${accepted.length} event(s) into ${review.folder || "home"}.`, { title: "Import" });
    } catch (e) { await tauriMessage(`Import apply failed: ${String(e)}`, { title: "Import", kind: "error" }); }
    finally { setImportBusy(false); }
  }, [importReview]);
```

Add a ref so `startImport` reads the latest events (near the `gcalPending` block):

```ts
  const mwEventsRefForImport = useRef<SpacetimeEvent[]>([]);
  mwEventsRefForImport.current = mwEvents;
```

- [ ] **Step 2: Wire `onImportDay` to the CalendarView renders**

Find each `<CalendarView ... />` usage (Day and Week). Add the prop:

```tsx
            onImportDay={(iso) => { void startImport(iso); }}
```

- [ ] **Step 3: Render the import review modal**

Near the other modals (e.g. after the mw review dialog block), add:

```tsx
      {importReview && (
        <div className="settings-overlay" onMouseDown={() => { if (!importBusy) setImportReview(null); }}>
          <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="settings-title">Import {importReview.date} from Google</h2>
            <p className="mw-orphan-hint">From {importReview.account}. New events are pre-checked; events you already have are unchecked. Accepted events are added to spacetime in the chosen folder.</p>
            <div className="settings-row">
              <span className="settings-label">Folder</span>
              <input className="settings-input" list="mw-folder-options" placeholder="home"
                value={importReview.folder}
                onChange={(e) => setImportReview((r) => r ? { ...r, folder: e.target.value } : r)} />
            </div>
            <ul className="gcal-account-list">
              {importReview.rows.map((r, i) => (
                <li key={`${r.date}|${r.time ?? ""}|${r.title}`} className="gcal-account-row">
                  <label className="settings-toggle">
                    <input type="checkbox" checked={r.accept}
                      onChange={(e) => setImportReview((rv) => rv ? { ...rv, rows: rv.rows.map((x, j) => j === i ? { ...x, accept: e.target.checked } : x) } : rv)} />
                    <span>{r.date}{r.time ? ` ${r.time}` : ""} {r.title || "(untitled)"}{r.isNew ? "" : " · already have"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="settings-actions">
              <button type="button" className="settings-btn" disabled={importBusy} onClick={() => setImportReview(null)}>Cancel</button>
              <button type="button" className="settings-btn" disabled={importBusy} onClick={() => { void applyImport(); }}>
                {importBusy ? "Importing…" : `Import ${importReview.rows.filter((r) => r.accept).length}`}
              </button>
            </div>
          </div>
        </div>
      )}
```

(The `mw-folder-options` datalist already exists in the mw review dialog; if not present at this scope, the input still works as a free-text folder name.)

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/components/CardGrid.tsx
git commit -m "feat: Google import — per-day review modal + apply into spacetime"
```

---

### Task 5: Verification (unit + LIVE)

**Files:** none.

- [ ] **Step 1: Unit + build gates**

```
cd src-tauri && cargo test gcal::          # 12 pass
cd /Users/geet.duggal/Development/order
npx tsx src/lib/gcal-import.test.ts        # ALL CHECKS PASS
npx tsc --noEmit                           # clean
pnpm build                                 # ✓ built
```

- [ ] **Step 2: LIVE (requires a connected Google account)**

In `pnpm tauri dev`, Week or Day view:
1. Hover a day header → an import (↓) icon appears → click it.
2. A modal lists that day's Google events; new ones pre-checked, ones you already have unchecked. Pick a target folder.
3. Import → the accepted events appear on the calendar in that folder; their `.md` notes carry the Google description as body.
4. Re-import the same day → previously-imported events show "already have" (unchecked) — no duplicates if you leave them unchecked.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add -A
git commit -m "chore: gcal import verification"
```

---

## Self-review notes
- Spec coverage: implements "Import — Google → Order" (per-day icon, account, review with new/already-have, target folder default home, apply adds spacetime events tagged with the source email + description→note body, natural-key re-import). Remote-delete detection and attendee import are the spec's accepted v1 omissions.
- Unit-tested: `parse_day_events`, `classifyImports`. Manually verified live: the fetch + modal + apply.
- Apply order (note first, then mw event) lets Effect 2's materializer find the existing backing note by date+title and skip re-creating it.

## Notes for the implementer
- Keep `ImportedEvent`/`ImportRow`/`classifyImports`/`listDayEvents`/`gcal_list_day_events` names exactly.
- The TS `ImportedEvent` shape must match the Rust serde output (camelCase): Rust `end_time`/`all_day` serialize to `endTime`/`allDay`? NO — confirm: add `#[serde(rename_all = "camelCase")]` to the Rust `ImportedEvent` struct so `end_time`→`endTime`, `all_day`→`allDay` match the TS interface. (Add this in Task 1 Step 3.)
- Import WRITES spacetime.mw (that's its job) — unlike push which only reads.
