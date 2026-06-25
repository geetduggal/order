# Google Calendar sync deletes (CRUD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a previously-synced spacetime event is deleted, rescheduled, or has its recipients removed, flag it during Sync and delete it on Google Calendar — completing create/update/delete CRUD over the plain-text, no-stored-ID model.

**Architecture:** Order keeps a per-device "synced record" (localStorage `order.gcal.synced`) mapping each synced event's natural key `(date,time,title)` → `{host, date, time, title, sig}`. A pure `gcalSyncPlan(record, intents, sigOf)` diffs current syncable events against the record into `{pushes, deletes}`: a push is a syncable event whose signature changed/is new; a delete is a record entry whose natural key is no longer syncable. Sync applies both (push via the existing command, delete via a new `gcal_delete_event`) and updates the record. The bottom-left review dialog lists pushes and deletes behind one confirm.

**Tech Stack:** TypeScript/React, Rust (Tauri command, `ureq`). Tests via `tsx` (TS) and `cargo test` (Rust).

## Global Constraints

- No Google event IDs stored anywhere (vault or record); identity is the natural key `(date, time, title)`. The synced record is per-device app state in localStorage, NOT the vault.
- A delete is triggered by: the event removed from `spacetime.mw`, all its recipient emails removed (no longer syncable), or a reschedule (time/title change → old key delete + new key create, the "edit = swap").
- Deletes go to the **host** account's primary calendar, matched by natural key, with `sendUpdates=all` (guests get cancellations). A no-match (already gone) is a graceful no-op success.
- The review dialog shows pushes AND deletes, clearly labeled; per-item errors don't abort the batch.
- No change to import. No Claude/AI git authorship trailers.

---

### Task 1: `gcalSyncPlan` pure diff + synced-record helpers (TS, TDD)

**Files:**
- Create: `src/lib/gcal-sync-plan.ts`
- Create: `src/lib/gcal-sync-plan.test.ts`

**Interfaces:**
- Consumes: `PushIntent` from `./gcal-push` (has `host,date,time?,endTime?,allDay,title,attendees`).
- Produces:
  - `export interface SyncedEntry { host: string; date: string; time?: string; title: string; sig: string }`
  - `export type SyncRecord = Record<string, SyncedEntry>` (keyed by natural key)
  - `export function naturalKey(date: string, time: string | undefined, title: string): string` → `` `${date}|${time ?? ""}|${title.toLowerCase()}` ``
  - `export interface SyncPlan { pushes: PushIntent[]; deletes: SyncedEntry[] }`
  - `export function gcalSyncPlan(record: SyncRecord, intents: PushIntent[], sigOf: (it: PushIntent) => string): SyncPlan`
  - `export function loadSyncRecord(): SyncRecord` and `export function saveSyncRecord(r: SyncRecord): void` (localStorage `order.gcal.synced`, fail-safe).

- [ ] **Step 1: Write the failing test**

Create `src/lib/gcal-sync-plan.test.ts`:

```ts
// Run: npx tsx src/lib/gcal-sync-plan.test.ts  → "ALL CHECKS PASS"
import { gcalSyncPlan, naturalKey, type SyncRecord } from "./gcal-sync-plan";
import type { PushIntent } from "./gcal-push";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

// Simple deterministic signature for the test (host|date|time|title|attendees).
const sig = (it: PushIntent) => [it.host, it.date, it.time ?? "", it.title, [...it.attendees].sort().join(",")].join("|");
const intent = (o: Partial<PushIntent>): PushIntent => ({ host: "you@example.com", date: "2026-06-26", allDay: false, title: "X", attendees: [], ...o });

// Record of two previously-synced events.
const rec: SyncRecord = {
  [naturalKey("2026-06-26", "09:00", "Standup")]: { host: "you@example.com", date: "2026-06-26", time: "09:00", title: "Standup", sig: "you@example.com|2026-06-26|09:00|Standup|" },
  [naturalKey("2026-06-26", "11:00", "Sync")]: { host: "you@example.com", date: "2026-06-26", time: "11:00", title: "Sync", sig: "you@example.com|2026-06-26|11:00|Sync|dana@example.com" },
};

// Current syncable events: Standup unchanged, Sync's attendees changed, plus a new event. "Sync" at 11:00 is gone (deleted).
const intents: PushIntent[] = [
  intent({ time: "09:00", title: "Standup" }),                                  // unchanged → no push
  intent({ time: "14:00", title: "Planning", attendees: ["dana@example.com"] }), // new → push
];

const plan = gcalSyncPlan(rec, intents, sig);
assertEq(plan.pushes.map((p) => p.title), ["Planning"], "push: only the new/changed event");
assertEq(plan.deletes.map((d) => `${d.title}@${d.time}`), ["Sync@11:00"], "delete: synced event no longer present");

// Edit = swap: change Standup's time → old key deletes, new key pushes.
const swapped = gcalSyncPlan(rec, [intent({ time: "09:30", title: "Standup" })], sig);
assertEq(swapped.pushes.map((p) => p.time), ["09:30"], "reschedule pushes the new key");
assertEq(new Set(swapped.deletes.map((d) => `${d.title}@${d.time}`)), new Set(["Standup@09:00", "Sync@11:00"]), "reschedule deletes the old key (+ the removed one)");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/gcal-sync-plan.test.ts`
Expected: FAIL — `Cannot find module './gcal-sync-plan'`.

- [ ] **Step 3: Implement**

Create `src/lib/gcal-sync-plan.ts`:

```ts
// CRUD diff for Google Calendar push: compares the per-device record of what
// Order has synced against the current syncable events, producing the pushes
// (create/update) and deletes. Identity is the natural key (date,time,title);
// no Google event IDs are stored.
import type { PushIntent } from "./gcal-push";

export interface SyncedEntry {
  host: string;
  date: string;
  time?: string;
  title: string;
  /** The push signature the event had when last synced — a push is needed when
   *  the current signature differs (or there's no record entry). */
  sig: string;
}

/** Synced record, keyed by natural key. */
export type SyncRecord = Record<string, SyncedEntry>;

export function naturalKey(date: string, time: string | undefined, title: string): string {
  return `${date}|${time ?? ""}|${title.toLowerCase()}`;
}

export interface SyncPlan {
  pushes: PushIntent[];
  deletes: SyncedEntry[];
}

/** Diff current syncable intents against the synced record. A push: an intent
 *  whose natural key has no record entry, or whose signature changed. A delete:
 *  a record entry whose natural key is no longer among the syncable intents
 *  (event removed, recipients stripped, or rescheduled → its old key). */
export function gcalSyncPlan(record: SyncRecord, intents: PushIntent[], sigOf: (it: PushIntent) => string): SyncPlan {
  const currentKeys = new Set(intents.map((it) => naturalKey(it.date, it.time, it.title)));
  const pushes = intents.filter((it) => record[naturalKey(it.date, it.time, it.title)]?.sig !== sigOf(it));
  const deletes = Object.values(record).filter((e) => !currentKeys.has(naturalKey(e.date, e.time, e.title)));
  return { pushes, deletes };
}

const STORE_KEY = "order.gcal.synced";

export function loadSyncRecord(): SyncRecord {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as SyncRecord) : {};
  } catch { return {}; }
}

export function saveSyncRecord(r: SyncRecord): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch { /* non-fatal */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx src/lib/gcal-sync-plan.test.ts`
Expected: the `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/gcal-sync-plan.ts src/lib/gcal-sync-plan.test.ts
git commit -m "feat: gcalSyncPlan — pushes+deletes diff for Google sync CRUD"
```

---

### Task 2: `gcal_delete_event` command + bridge (Rust + TS)

**Files:**
- Modify: `src-tauri/src/gcal.rs` (the command)
- Modify: `src-tauri/src/lib.rs` (register)
- Modify: `src/lib/gcal-accounts.ts` (bridge)

**Interfaces:**
- Consumes: `fetch_access_token`, `load_config`, `config_dir`, `agent`, `enc`, `local_rfc3339`, `next_day`, `find_event_id`, `CAL_BASE`, `cal_get` (all present from earlier gcal work).
- Produces: `#[tauri::command] gcal_delete_event(app, account: String, date: String, time: Option<String>, title: String) -> Result<String, String>` returning `"deleted"` or `"absent"`; TS `deleteEvent(account, date, time, title)` bridge.

- [ ] **Step 1: Implement the command**

Add to `src-tauri/src/gcal.rs` (near `gcal_push_event`). Reuses `cal_get` (GET) and a small DELETE via `agent()`:

```rust
/// Delete an event from the host account's primary calendar, matched by natural
/// key (date, time, title). Returns "deleted", or "absent" when no match exists
/// (already gone) — a graceful no-op. sendUpdates=all so guests are notified.
#[tauri::command]
pub async fn gcal_delete_event(app: tauri::AppHandle, account: String, date: String, time: Option<String>, title: String) -> Result<String, String> {
    let cfg = load_config(&config_dir(&app)?);
    let token = fetch_access_token(&cfg, &account)?;
    let tmin = local_rfc3339(&date, "00:00")?;
    let tmax = local_rfc3339(&next_day(&date)?, "00:00")?;
    let list_url = format!("{CAL_BASE}?singleEvents=true&timeMin={}&timeMax={}", enc(&tmin), enc(&tmax));
    let (ls, lb) = cal_get(&token, &list_url)?;
    if ls >= 400 {
        return Err(format!("calendar list failed ({ls}): {lb}"));
    }
    let id = match find_event_id(&lb, &title, &date, time.as_deref()) {
        Some(id) => id,
        None => return Ok("absent".to_string()),
    };
    let url = format!("{CAL_BASE}/{}?sendUpdates=all", enc(&id));
    let resp = agent().request("DELETE", &url).set("Authorization", &format!("Bearer {token}")).call();
    match resp {
        Ok(_) => Ok("deleted".to_string()),
        // Google returns 410 Gone if it was already removed — treat as success.
        Err(ureq::Error::Status(410, _)) => Ok("absent".to_string()),
        Err(ureq::Error::Status(s, r)) => Err(format!("calendar delete failed ({s}): {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("transport: {e}")),
    }
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs` `generate_handler!`, after `gcal::gcal_push_event,`, add:

```rust
            gcal::gcal_delete_event,
```

- [ ] **Step 3: Add the TS bridge**

In `src/lib/gcal-accounts.ts`, add:

```ts
export const deleteEvent = (account: string, date: string, time: string | undefined, title: string) =>
  invoke<string>("gcal_delete_event", { account, date, time: time ?? null, title });
```

- [ ] **Step 4: Compile + commit**

Run: `cd src-tauri && cargo build 2>&1 | tail -6` → compiles (warnings OK).
Run: `cd src-tauri && cargo test gcal:: 2>&1 | tail -3` → existing gcal tests still pass.
Run: `npx tsc --noEmit` → no output.

```bash
git add src-tauri/src/gcal.rs src-tauri/src/lib.rs src/lib/gcal-accounts.ts
git commit -m "feat: gcal_delete_event command + bridge (delete by natural key)"
```

---

### Task 3: CardGrid wiring — persisted record, pending deletes, sync applies both

**Files:**
- Modify: `src/components/CardGrid.tsx`

**Interfaces:**
- Consumes: `gcalSyncPlan`, `naturalKey`, `loadSyncRecord`, `saveSyncRecord`, `SyncRecord` (Task 1); `deleteEvent` (Task 2); existing `gcalSig`, `buildPushIntents`, `pushEvent`, `mwEvents`, `gcalAccounts`, the review dialog.

- [ ] **Step 1: Replace the session Set with the persisted record + the sync plan**

Replace the `gcalSyncedSig`/`gcalPending` block (currently ~lines 2470-2481):

```ts
  const [gcalSyncedSig, setGcalSyncedSig] = useState<Set<string>>(new Set());
  const [gcalSyncing, setGcalSyncing] = useState(false);
  const gcalPending = useMemo<PushIntent[]>(() => {
    if (gcalAccounts.accounts.length === 0) return [];
    return buildPushIntents(mwEvents, gcalAccounts.accounts, gcalAccounts.default)
      .filter((it) => !gcalSyncedSig.has(gcalSig(it)));
  }, [mwEvents, gcalAccounts, gcalSyncedSig]);
  const gcalPendingRef = useRef<PushIntent[]>([]);
  gcalPendingRef.current = gcalPending;
```

with the persisted record + full plan (import `gcalSyncPlan`, `naturalKey`, `loadSyncRecord`, `saveSyncRecord`, `type SyncRecord` from `../lib/gcal-sync-plan` at the top of the file):

```ts
  const [gcalSynced, setGcalSynced] = useState<SyncRecord>(loadSyncRecord);
  useEffect(() => { saveSyncRecord(gcalSynced); }, [gcalSynced]);
  const [gcalSyncing, setGcalSyncing] = useState(false);
  const gcalPlan = useMemo(() => {
    if (gcalAccounts.accounts.length === 0) return { pushes: [], deletes: [] };
    const intents = buildPushIntents(mwEvents, gcalAccounts.accounts, gcalAccounts.default);
    return gcalSyncPlan(gcalSynced, intents, gcalSig);
  }, [mwEvents, gcalAccounts, gcalSynced]);
  const gcalPendingCount = gcalPlan.pushes.length + gcalPlan.deletes.length;
  const gcalPlanRef = useRef(gcalPlan);
  gcalPlanRef.current = gcalPlan;
```

- [ ] **Step 2: Update `applyGcalSync` to push AND delete, updating the record**

Replace the `applyGcalSync` body (currently ~lines 2558-2594) with:

```ts
  const applyGcalSync = useCallback(async () => {
    const { pushes, deletes } = gcalPlanRef.current;
    if (pushes.length === 0 && deletes.length === 0) return;
    setGcalSyncing(true);
    try {
      const { pushEvent, deleteEvent } = await import("../lib/gcal-accounts");
      let created = 0, updated = 0, removed = 0; const errors: string[] = [];
      const recAdds: SyncRecord = {}; const recDels: string[] = [];
      for (const it of pushes) {
        const note = notesRef.current?.find((n) =>
          n.title.toLowerCase() === it.title.toLowerCase()
          && toIsoDateValue(n.frontmatter.date) === it.date,
        );
        let description = "";
        if (note) {
          try { description = (await readVault(toVaultRel(note.path))).replace(/^---[\s\S]*?---\n?/, "").trim(); }
          catch { /* leave empty */ }
        }
        try {
          const r = await pushEvent({ ...it, description });
          if (r === "created") created++; else updated++;
          recAdds[naturalKey(it.date, it.time, it.title)] = { host: it.host, date: it.date, time: it.time, title: it.title, sig: gcalSig(it) };
        } catch (e) { errors.push(`${it.title}: ${String(e)}`); }
      }
      for (const d of deletes) {
        try {
          await deleteEvent(d.host, d.date, d.time, d.title);
          removed++;
          recDels.push(naturalKey(d.date, d.time, d.title));
        } catch (e) { errors.push(`delete ${d.title}: ${String(e)}`); }
      }
      setGcalSynced((prev) => {
        const next = { ...prev, ...recAdds };
        for (const k of recDels) delete next[k];
        return next;
      });
      const summary = `Synced to Google — ${created} created, ${updated} updated, ${removed} deleted`;
      if (errors.length) {
        await tauriMessage(`${summary}\n${errors.length} failed:\n${errors.join("\n")}`, { title: "Sync to Google", kind: "warning" });
      } else {
        flashCap(summary, "ok");
      }
    } finally { setGcalSyncing(false); }
  }, [flashCap]);
```

- [ ] **Step 3: Update the dialog gcal section to list deletes**

Replace the `{gcalPending.length > 0 && ( … )}` block (currently ~lines 5545-5564) with:

```tsx
              {(gcalPlan.pushes.length > 0 || gcalPlan.deletes.length > 0) && (
                <div className="sync-deletes">
                  <strong>Sync to Google Calendar:</strong>
                  <p className="mw-orphan-hint">Curated events that changed. "Sync" creates/updates them on the host calendar (with invites) and deletes events you removed or un-shared.</p>
                  <ul>
                    {gcalPlan.pushes.map((it) => (
                      <li key={`p:${gcalSig(it)}`} className="mw-orphan-row">
                        <span className="mw-orphan-name">
                          ↗ {it.date}{it.time ? ` ${it.time}` : ""} {it.title}
                          <span className="mw-orphan-sep"> · {it.host}</span>
                          {it.attendees.length > 0 ? <span className="mw-orphan-sep"> · invite {it.attendees.join(", ")}</span> : null}
                        </span>
                      </li>
                    ))}
                    {gcalPlan.deletes.map((d) => (
                      <li key={`d:${naturalKey(d.date, d.time, d.title)}`} className="mw-orphan-row">
                        <span className="mw-orphan-name">
                          ✕ Delete: {d.date}{d.time ? ` ${d.time}` : ""} {d.title}
                          <span className="mw-orphan-sep"> · {d.host}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="mw-orphan-actions">
                    <button type="button" className="mw-orphan-btn" disabled={gcalSyncing} onClick={() => { void applyGcalSync(); }}>{gcalSyncing ? "Syncing…" : `Sync ${gcalPlan.pushes.length + gcalPlan.deletes.length} to Google`}</button>
                  </span>
                </div>
              )}
```

- [ ] **Step 4: Update the indicator + dialog-open + auto-reset conditions**

`gcalPending.length` (and `gcalPending.length > 0`) appears in three places — the auto-reset effect (~line 2603), the dialog-open guard (~line 5442), and the indicator (~line 5617-5618). Replace each `gcalPending.length` usage with `gcalPendingCount`:
- Auto-reset effect: `… && modifiedEvents.length === 0 && gcalPendingCount === 0` and its deps array `gcalPendingCount`.
- Dialog-open guard (~5442) and indicator guard (~5617): `… || gcalPendingCount > 0`.
- Indicator count (~5618): `… + gcalPendingCount`.

(Search the file for `gcalPending` after editing to confirm no stale references remain — `gcalPending`/`gcalPendingRef` should be fully gone, replaced by `gcalPlan`/`gcalPendingCount`/`gcalPlanRef`.)

- [ ] **Step 5: Type-check + build + commit**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

```bash
git add src/components/CardGrid.tsx
git commit -m "feat: sync Google deletes — persisted record + delete pass in Sync review"
```

---

### Task 4: Verification (unit/build + LIVE)

**Files:** none.

- [ ] **Step 1: Gates**

```
npx tsx src/lib/gcal-sync-plan.test.ts     # ALL CHECKS PASS
cd src-tauri && cargo test gcal::           # all pass
cd /Users/geet.duggal/Development/order
npx tsc --noEmit                            # clean
pnpm build                                  # ✓ built
```

- [ ] **Step 2: LIVE (connected Google account)**

In `pnpm tauri dev`:
1. Add an event with your connected email, Sync → it appears on Google.
2. **Delete** that event in Order (event menu → Delete, or remove the line in `spacetime.mw`) → the bottom-left "spacetime · N pending" shows a `✕ Delete:` row → Sync → the event is removed from Google (guest gets a cancellation).
3. **Reschedule** a synced event (change its time) → Sync shows a delete (old time) + a push (new time) → Google has only the new one.
4. **Un-share**: remove all emails from a synced event → Sync flags it as a delete → removed from Google.
5. Restart the app, delete another previously-synced event → it's still flagged (persisted record).

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add -A
git commit -m "chore: gcal delete sync verification"
```

---

## Self-review notes
- Spec coverage: persisted record (T1 load/save + T3 state), pushes+deletes diff (T1 `gcalSyncPlan`), delete command with natural-key match + sendUpdates + graceful absent (T2), Sync applies both + updates record (T3), dialog lists deletes (T3), reschedule = swap and un-share = delete (covered by the diff + T1 test). All covered.
- Unit-tested: `gcalSyncPlan` (pushes/deletes/swap). Compile-verified: the delete command + bridge. Manually verified live: the actual Google delete (T4).
- Type consistency: `SyncedEntry`/`SyncRecord`/`naturalKey`/`gcalSyncPlan`/`SyncPlan`/`deleteEvent` consistent across tasks; `gcalSig` stays in CardGrid and is passed as `sigOf`.

## Notes for the implementer
- The synced record is keyed by `naturalKey` so an update overwrites the same entry (the `sig` changes); deletes remove the entry.
- Keep `gcalSig` where it is in CardGrid and pass it into `gcalSyncPlan` as `sigOf` — don't duplicate the signature logic.
- After T3, grep `CardGrid.tsx` for `gcalPending` to ensure every old reference is migrated to `gcalPlan`/`gcalPendingCount`.
- `deleteEvent` passes `time ?? null` so an all-day event (no time) deletes by date+title.
