# Event Recipients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Recipients" section to the calendar event menu (`EventActionMenu`) to view/add/remove an event's Google-sync emails — with autocomplete from emails already in `spacetime.mw` — writing changes back to `spacetime.mw`.

**Architecture:** A pure `distinctEmails(events)` feeds a native `<datalist>` autocomplete. `EventActionMenu` gains an always-shown Recipients section (current emails as removable chips + an add-input). CardGrid carries the event's current emails in `eventMenu` state and commits changes via `applyMwEdit(mw => mwUpdateEvent(mw, date, title, { emails }))` — the same pattern folder assignment uses. The menu stays open after an edit so multiple recipients can be added. No `spacetime.ts` change (it already round-trips an `emails` patch).

**Tech Stack:** React/TS. Tests via standalone `tsx` scripts (local `assertEq`, `ALL CHECKS PASS`).

## Global Constraints

- Emails are purely recipients (Plan 1 semantics: one matching a connected account = host; others = invitees). No email→folder inference, no contact lookup beyond in-`.mw` emails.
- Email validation is lenient: a value must match `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` (lowercased) to be added; invalid input is silently ignored.
- The Recipients section shows in **every** view's event menu (day/week/month/year) — unconditionally (unlike the view-gated move-to-day chips).
- The menu **stays open** after add/remove; emails persist to `spacetime.mw` via `mwUpdateEvent`.
- No change to push/import or `spacetime.ts`.
- No Claude/AI git authorship trailers.

---

### Task 1: `distinctEmails` pure helper (TS, TDD)

**Files:**
- Modify: `src/lib/gcal-recipients.ts` (add the helper)
- Modify: `src/lib/gcal-recipients.test.ts` (append a test)

**Interfaces:**
- Consumes: `SpacetimeEvent` (has `emails?: string[]`) from `./spacetime`.
- Produces: `export function distinctEmails(events: SpacetimeEvent[]): string[]` — every email across all events, lowercased, de-duplicated, sorted ascending.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/gcal-recipients.test.ts` (before any final `console.log("ALL CHECKS PASS")` — if that line exists once at the end, add these assertions above it; otherwise add the import + assertions and keep the existing final log). Add the import at the top if absent:

```ts
import { distinctEmails } from "./gcal-recipients";
import type { SpacetimeEvent } from "./spacetime";

// distinctEmails: lowercased, de-duplicated, sorted.
{
  const evs: SpacetimeEvent[] = [
    { date: "2026-06-25", title: "A", emails: ["Rohit@verkada.com", "bob@acme.com"] },
    { date: "2026-06-25", title: "B", emails: ["rohit@verkada.com"] }, // dup (case-insensitive)
    { date: "2026-06-25", title: "C" }, // no emails
  ];
  assertEq(distinctEmails(evs), ["bob@acme.com", "rohit@verkada.com"], "distinctEmails: lowercased, deduped, sorted");
  assertEq(distinctEmails([]), [], "distinctEmails: empty");
}
```

(If the test file's `assertEq` is locally defined, reuse it; if each test file defines its own, match the existing one in this file.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/gcal-recipients.test.ts`
Expected: FAIL — `distinctEmails` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/gcal-recipients.ts`:

```ts
import type { SpacetimeEvent } from "./spacetime";

/** Every recipient email across the given events — lowercased, de-duplicated,
 *  and sorted. Used to populate the event menu's email autocomplete. */
export function distinctEmails(events: SpacetimeEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    for (const m of e.emails ?? []) set.add(m.toLowerCase());
  }
  return [...set].sort();
}
```

(If `gcal-recipients.ts` already imports from `./spacetime`, merge the import rather than duplicating it.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx src/lib/gcal-recipients.test.ts`
Expected: the new `ok:` lines print and the script ends `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/gcal-recipients.ts src/lib/gcal-recipients.test.ts
git commit -m "feat: distinctEmails — autocomplete source for event recipients"
```

---

### Task 2: `EventActionMenu` Recipients section (UI, optional props)

**Files:**
- Modify: `src/components/CardGrid.tsx` (the `EventActionMenu` function, ~line 5767)
- Modify: `src/styles.css` (recipients styles)

**Interfaces:**
- Produces: `EventActionMenu` accepts three new OPTIONAL props — `emails?: string[]`, `knownEmails?: string[]`, `onSetEmails?: (emails: string[]) => void` — and renders a Recipients section only when `onSetEmails` is provided. Optional so the existing call site keeps type-checking until Task 3 wires it.

- [ ] **Step 1: Add the props to the signature + type**

In `EventActionMenu`'s destructure (line ~5768) add `emails, knownEmails, onSetEmails`, and in its prop type (the `}: { … }` block ending ~5791) add:

```ts
  /** Current recipient emails on the event (Google sync). */
  emails?: string[];
  /** Autocomplete suggestions — distinct emails already in spacetime.mw. */
  knownEmails?: string[];
  /** Commit a new full recipient list; writes to spacetime.mw. When omitted,
   *  the Recipients section is not shown. */
  onSetEmails?: (emails: string[]) => void;
```

- [ ] **Step 2: Add the draft state + grow the menu box**

Near the other `useState` hooks in the component (after `const [folderOpen, …]`, ~line 5800) add:

```ts
  const [recipDraft, setRecipDraft] = useState("");
```

Then update the menu-size estimates so the popup clamps correctly with the section present. Replace the `menuH` and `menuW` lines (~5828-5829) with:

```ts
  const recipH = onSetEmails ? 40 + (emails?.length ?? 0) * 26 : 0;
  const menuH = (weekDays.length > 0 ? 170 : 120) + (availableFolders.length > 0 ? (folderOpen ? 220 : 56) : 0) + recipH;
  const menuW = (weekDays.length > 0 || availableFolders.length > 0 || onSetEmails) ? 280 : 200;
```

- [ ] **Step 3: Render the Recipients section**

Insert this block between the folder picker's closing `)}` (line ~5940) and the `<button … onClick={onOpen}>Open</button>` line (~5941):

```tsx
        {onSetEmails && (
          <div className="event-action-recipients">
            {(emails ?? []).length > 0 && (
              <ul className="event-action-recip-list">
                {(emails ?? []).map((m) => (
                  <li key={m} className="event-action-recip-chip">
                    <span className="event-action-recip-addr">{m}</span>
                    <button
                      type="button"
                      className="event-action-recip-x"
                      aria-label={`Remove ${m}`}
                      onClick={() => onSetEmails((emails ?? []).filter((x) => x !== m))}
                    >×</button>
                  </li>
                ))}
              </ul>
            )}
            <input
              className="event-action-recip-input"
              list="event-action-recip-options"
              placeholder="Add recipient email…"
              value={recipDraft}
              onChange={(e) => setRecipDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = recipDraft.trim().toLowerCase();
                  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !(emails ?? []).includes(v)) {
                    onSetEmails([...(emails ?? []), v]);
                    setRecipDraft("");
                  }
                }
                if (e.key === "Escape") { e.preventDefault(); onCancel(); }
              }}
            />
            <datalist id="event-action-recip-options">
              {(knownEmails ?? []).map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
        )}
```

- [ ] **Step 4: Add styles**

Append to `src/styles.css`:

```css
.event-action-recipients { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; border-top: 1px solid var(--rule); margin-top: 2px; }
.event-action-recip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.event-action-recip-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 7px; border: 1px solid var(--rule); border-radius: 10px; font-size: 11px; background: var(--bg-soft, transparent); max-width: 100%; }
.event-action-recip-addr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.event-action-recip-x { border: none; background: transparent; color: var(--ink-faint); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.event-action-recip-x:hover { color: var(--royal); }
.event-action-recip-input { width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: 12px; border: 1px solid var(--rule); border-radius: 4px; background: transparent; color: var(--ink); }
```

- [ ] **Step 5: Type-check + build + commit**

Run: `npx tsc --noEmit` → no output. (The existing `<EventActionMenu …>` call site still type-checks because the new props are optional.)
Run: `pnpm build` → ends with `✓ built`.

```bash
git add src/components/CardGrid.tsx src/styles.css
git commit -m "feat: EventActionMenu recipients section (chips + autocomplete input)"
```

---

### Task 3: CardGrid wiring — carry + persist emails

**Files:**
- Modify: `src/components/CardGrid.tsx` (`eventMenu` state, `handleEventClick`, a `knownEmails` memo, a `handleSetEmails` handler, the `<EventActionMenu>` render)

**Interfaces:**
- Consumes: `distinctEmails` (Task 1), the `onSetEmails`/`emails`/`knownEmails` props (Task 2), existing `eventChipRef`, `applyMwEdit`, `mwUpdateEvent`, `mwEvents`.
- Produces: the live wiring so editing recipients in the menu writes to `spacetime.mw`.

- [ ] **Step 1: Add `emails` to the `eventMenu` state type**

Change the `eventMenu` state type (~line 3065) from:

```ts
  const [eventMenu, setEventMenu] = useState<
    { path: string; title: string; x: number; y: number; date: string | null; folder: string | null } | null
  >(null);
```

to add `emails: string[]`:

```ts
  const [eventMenu, setEventMenu] = useState<
    { path: string; title: string; x: number; y: number; date: string | null; folder: string | null; emails: string[] } | null
  >(null);
```

- [ ] **Step 2: Populate `emails` when the menu opens**

In `handleEventClick`, the event's chip is read via `eventChipRef.current.get(path)`. Add a local `let em: string[] = [];` alongside the existing `let title/d/f` locals (~line 3101), set it from the chip wherever the chip is resolved (e.g. right after `const chip = eventChipRef.current.get(path);` succeeds: `em = chip.ev.emails ?? [];`), and include it in the `setEventMenu({ … })` call (~line 3119):

```ts
    setEventMenu({
      path,
      title,
      x: coords?.x ?? window.innerWidth / 2,
      y: coords?.y ?? window.innerHeight / 2,
      date: d,
      folder: f,
      emails: em,
    });
```

(If `handleEventClick` resolves the chip in more than one branch, set `em` in the branch that has the `SpacetimeEvent`; leave it `[]` for the todo.txt / note-only fallbacks.)

- [ ] **Step 3: Add the `knownEmails` memo + `handleSetEmails` handler**

Import `distinctEmails` at the top of CardGrid (merge into the existing `../lib/gcal-recipients` import if present, else add `import { distinctEmails } from "../lib/gcal-recipients";`).

Near `handleAssignFolder` (~line 3890) add:

```ts
  const knownEmails = useMemo(() => distinctEmails(mwEvents), [mwEvents]);

  /** Commit a new recipient list onto the event's spacetime.mw line. Updates
   *  the open menu optimistically so chips repaint without closing it. */
  const handleSetEmails = useCallback(async (path: string, emails: string[]) => {
    const chip = eventChipRef.current.get(path);
    if (!chip) return;
    const { date, title } = chip.ev;
    setEventMenu((m) => (m && m.path === path ? { ...m, emails } : m));
    await applyMwEdit((mw) => mwUpdateEvent(mw, date, title, { emails }));
  }, [applyMwEdit]);
```

- [ ] **Step 4: Pass the props to `<EventActionMenu>`**

In the `<EventActionMenu … />` render (~line 5679), add:

```tsx
          emails={eventMenu.emails}
          knownEmails={knownEmails}
          onSetEmails={(emails) => { void handleSetEmails(eventMenu.path, emails); }}
```

- [ ] **Step 5: Type-check + build + commit**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

```bash
git add src/components/CardGrid.tsx
git commit -m "feat: wire event recipients — edit emails from the calendar into spacetime.mw"
```

---

### Task 4: Verification

**Files:** none.

- [ ] **Step 1: Gates**

```
npx tsx src/lib/gcal-recipients.test.ts   # ALL CHECKS PASS
npx tsc --noEmit                           # clean
pnpm build                                 # ✓ built
```

- [ ] **Step 2: Manual (in `pnpm tauri dev`)**

1. Click an event in **Week** view → the menu shows a **Recipients** section.
2. Type an email — suggestions from existing `spacetime.mw` emails appear (datalist); pick or finish typing → Enter → it appears as a chip and the menu **stays open**.
3. Add a second email; remove one with ✕.
4. Open `spacetime.mw` (or the event again) → the emails are on the event's line.
5. Confirm the same Recipients section appears from the event menu in **Day, Month, and Year** views.
6. The edited event now shows in the bottom-left **"spacetime · N pending"** indicator (its attendee signature changed) → Sync would push it with the new invites.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add -A
git commit -m "chore: event recipients verification"
```

---

## Self-review notes
- Spec coverage: `distinctEmails` (autocomplete), Recipients section in `EventActionMenu` (all views), CardGrid wiring to `mwUpdateEvent` (writes spacetime.mw), menu stays open, lenient validation, no `spacetime.ts` change. All present.
- Type consistency: `onSetEmails(emails: string[])`, `emails`/`knownEmails` props, `eventMenu.emails`, `handleSetEmails(path, emails)`, `distinctEmails(events)` consistent across tasks.
- Optional props in Task 2 keep the call site compiling before Task 3 wires it.

## Notes for the implementer
- Do NOT touch `spacetime.ts` — `mwUpdateEvent` already accepts an `emails` patch (`{ emails: [] }` clears).
- Keep the menu open on edit (optimistic `setEventMenu` update) — that's intended.
- Match the existing `assertEq`/`ALL CHECKS PASS` convention in the test file (some files define `assertEq` locally; reuse what's there).
