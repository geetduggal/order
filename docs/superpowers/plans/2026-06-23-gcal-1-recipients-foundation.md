# GCal Sync — Plan 1: Email-Recipient Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the plain-text data-model foundation for Google Calendar sync — parse/serialize trailing email recipients on spacetime event lines, and resolve host-vs-invitee from a connected-accounts set. Pure logic, no Google/OAuth/UI.

**Architecture:** Extend `SpacetimeEvent` with `emails?: string[]`. The events parser peels trailing email-shaped tokens (after the folder tag) into that array; both serializers emit them; round-trip is exact. A new pure helper `resolveRecipients` classifies a line's emails into one host calendar + invitees. Everything is unit-tested with the project's standalone `tsx` script convention.

**Tech Stack:** TypeScript. Tests are standalone scripts run with `npx tsx <file>` using a local `assertEq` that throws and prints `ALL CHECKS PASS` (no vitest/jest in this repo).

## Global Constraints

- Plain-text, no hidden ids: emails are written literally on the event line, after the folder tag.
- An email is recognized by shape: `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`.
- Emails are peeled from the **end** of the line, after the existing `#tag`, so the title is never mis-read. Each email must be preceded by whitespace (a sole token is never treated as an email).
- This plan adds NO Google API, OAuth, Rust, or UI code. Pure `src/lib` logic + tests.
- Host/invite rule (spec): emails matching a connected account → host calendar (first one wins); non-matching → invitees; if none match → host = default account and all emails are invitees.
- Tests follow the existing pattern in `src/lib/file-piles.test.ts` (local `assertEq`, `npx tsx`, `ALL CHECKS PASS`). Do NOT add a test framework.
- Commits must NOT include any Claude/AI authorship or co-author trailers — plain commit, the given subject line only.

---

### Task 1: Parse trailing email recipients

**Files:**
- Modify: `src/lib/spacetime.ts` (the `SpacetimeEvent` interface ~line 53; the events-section parse ~lines 893–906)
- Create: `src/lib/spacetime.gcal-parse.test.ts`

**Interfaces:**
- Produces: `SpacetimeEvent.emails?: string[]` — recipient emails on an event line, lowercased-as-written (the parser stores them verbatim; normalization happens in Task 3). `parseMarkwhenFormat(text).events[i].emails` is set only when ≥1 email is present.

- [ ] **Step 1: Write the failing test**

Create `src/lib/spacetime.gcal-parse.test.ts`:

```ts
// Run: npx tsx src/lib/spacetime.gcal-parse.test.ts  → "ALL CHECKS PASS"
import { parseMarkwhenFormat } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

function ev(line: string) {
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n${line}\n`);
  return st.events[0];
}

// 1. No emails → emails undefined, title intact.
assertEq(ev("2026-06-25 09:00 : Standup #verkada"), { date: "2026-06-25", title: "Standup", folder: "#verkada", time: "09:00" }, "no emails");

// 2. One trailing email after the tag.
assertEq(ev("2026-06-25 09:00 : Standup #verkada geet@verkada.com"),
  { date: "2026-06-25", title: "Standup", folder: "#verkada", time: "09:00", emails: ["geet@verkada.com"] },
  "one email after tag");

// 3. Multiple trailing emails.
assertEq(ev("2026-06-25 14:00 : Planning #verkada a@x.com b@y.com c@z.org"),
  { date: "2026-06-25", title: "Planning", folder: "#verkada", time: "14:00", emails: ["a@x.com", "b@y.com", "c@z.org"] },
  "multiple emails");

// 4. Emails with no folder tag.
assertEq(ev("2026-06-25 14:00 : Planning a@x.com b@y.com"),
  { date: "2026-06-25", title: "Planning", time: "14:00", emails: ["a@x.com", "b@y.com"] },
  "emails, no tag");

// 5. A title word that is not a full email is left alone.
assertEq(ev("2026-06-25 09:00 : Email Bob later #verkada"),
  { date: "2026-06-25", title: "Email Bob later", folder: "#verkada", time: "09:00" },
  "non-email title preserved");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/spacetime.gcal-parse.test.ts`
Expected: FAIL on test 2 — `emails` missing from the parsed event (actual has no `emails` key).

- [ ] **Step 3: Add `emails` to the interface**

In `src/lib/spacetime.ts`, change the `SpacetimeEvent` interface (~line 53) to add the field:

```ts
export interface SpacetimeEvent {
  date: string;            // YYYY-MM-DD
  title: string;
  folder?: string;
  time?: string;           // HH:MM (maps from frontmatter startTime)
  endTime?: string;        // HH:MM
  endDate?: string;        // YYYY-MM-DD
  allDay?: boolean;
  emails?: string[];       // Google sync recipients written on the line (Task 3 classifies)
}
```

- [ ] **Step 4: Peel trailing emails in the events parser**

In the events section (~lines 894–897), replace the title/tag extraction:

```ts
      // Separate trailing #tag from title
      const tagM = rest.trimEnd().match(/\s+(#[\w-]+)$/);
      const tagSlug = tagM ? tagM[1] : null;
      const title = tagM ? rest.slice(0, rest.length - tagM[0].length).trim() : rest.trim();
```

with:

```ts
      // Peel trailing email recipients (Google sync) from the END first, then
      // the folder tag, leaving the title. Emails are written after the tag,
      // e.g. `Title #folder a@x.com b@y.com`. Each email must be preceded by
      // whitespace, so a sole title token is never mistaken for a recipient.
      let work = rest.trimEnd();
      const emails: string[] = [];
      const emailRe = /\s+([^@\s]+@[^@\s]+\.[^@\s]+)$/;
      let em: RegExpMatchArray | null;
      while ((em = work.match(emailRe))) {
        emails.unshift(em[1]);
        work = work.slice(0, work.length - em[0].length).trimEnd();
      }
      const tagM = work.match(/\s+(#[\w-]+)$/);
      const tagSlug = tagM ? tagM[1] : null;
      const title = (tagM ? work.slice(0, work.length - tagM[0].length) : work).trim();
```

Then in the `events.push({...})` call just below it, add the emails field alongside the others:

```ts
      events.push({
        date, title,
        ...(tagSlug ? { folder: tagSlug } : {}), // resolved to real name below
        ...(time    ? { time }   : {}),
        ...(endTime ? { endTime } : {}),
        ...(endDate ? { endDate } : {}),
        ...(emails.length ? { emails } : {}),
        ...(!time && !endDate ? { allDay: true } : {}),
      });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx src/lib/spacetime.gcal-parse.test.ts`
Expected: five `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/spacetime.ts src/lib/spacetime.gcal-parse.test.ts
git commit -m "feat: parse trailing email recipients on spacetime event lines"
```

---

### Task 2: Serialize trailing email recipients (round-trip)

**Files:**
- Modify: `src/lib/spacetime.ts` (`serializeMarkwhen` events emit ~line 656; `spliceMwEvents` events emit ~line 680)
- Create: `src/lib/spacetime.gcal-serialize.test.ts`

**Interfaces:**
- Consumes: `SpacetimeEvent.emails?: string[]` from Task 1.
- Produces: both `serializeMarkwhen` and `spliceMwEvents` emit a line of the form `prefix: Title #tag a@x.com b@y.com` when `emails` is present; absent otherwise.

- [ ] **Step 1: Write the failing round-trip test**

Create `src/lib/spacetime.gcal-serialize.test.ts`:

```ts
// Run: npx tsx src/lib/spacetime.gcal-serialize.test.ts  → "ALL CHECKS PASS"
import { parseMarkwhenFormat, serializeMarkwhen, spliceMwEvents, type SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const events: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "Standup", folder: "Verkada", time: "09:00", emails: ["geet@verkada.com"] },
  { date: "2026-06-25", title: "Planning", folder: "Verkada", time: "14:00", emails: ["a@x.com", "b@y.com"] },
  { date: "2026-06-25", title: "Solo", folder: "Verkada", time: "16:00" },
];

// serializeMarkwhen round-trips emails.
const mw = serializeMarkwhen({ space: [], seasons: [], events });
const back = parseMarkwhenFormat(mw).events;
const norm = (e: SpacetimeEvent) => ({ date: e.date, title: e.title, time: e.time, emails: e.emails ?? null });
assertEq(back.map(norm),
  [
    { date: "2026-06-25", title: "Standup", time: "09:00", emails: ["geet@verkada.com"] },
    { date: "2026-06-25", title: "Planning", time: "14:00", emails: ["a@x.com", "b@y.com"] },
    { date: "2026-06-25", title: "Solo", time: "16:00", emails: null },
  ],
  "serializeMarkwhen round-trip");

// The serialized line literally contains the emails after the tag.
if (!mw.includes(": Standup #verkada geet@verkada.com")) throw new Error("FAIL: emails not appended after tag in serializeMarkwhen\n" + mw);
console.log("ok: emails appear after tag");

// spliceMwEvents also emits emails.
const spliced = spliceMwEvents("# Time\n\n## Events\n", events);
if (!spliced.includes(": Planning #verkada a@x.com b@y.com")) throw new Error("FAIL: spliceMwEvents did not append emails\n" + spliced);
console.log("ok: spliceMwEvents appends emails");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/spacetime.gcal-serialize.test.ts`
Expected: FAIL — the serialized lines lack the emails (the `includes` checks throw, and the round-trip `emails` are `null`).

- [ ] **Step 3: Emit emails in `serializeMarkwhen`**

In `serializeMarkwhen` (~line 654–657), change the line builder:

```ts
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const tag = e.folder ? ` ${toMarkwhenTag(e.folder)}` : "";
      lines.push(`${prefixes[i].padEnd(prefixW)}: ${e.title}${tag}`);
    }
```

to:

```ts
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const tag = e.folder ? ` ${toMarkwhenTag(e.folder)}` : "";
      const recips = e.emails?.length ? ` ${e.emails.join(" ")}` : "";
      lines.push(`${prefixes[i].padEnd(prefixW)}: ${e.title}${tag}${recips}`);
    }
```

- [ ] **Step 4: Emit emails in `spliceMwEvents`**

In `spliceMwEvents` (~line 679–682), change:

```ts
    evBlock += "\n" + events.map((e, i) => {
      const tag = e.folder ? ` ${toMarkwhenTag(e.folder)}` : "";
      return `${prefixes[i].padEnd(w)}: ${e.title}${tag}`;
    }).join("\n") + "\n";
```

to:

```ts
    evBlock += "\n" + events.map((e, i) => {
      const tag = e.folder ? ` ${toMarkwhenTag(e.folder)}` : "";
      const recips = e.emails?.length ? ` ${e.emails.join(" ")}` : "";
      return `${prefixes[i].padEnd(w)}: ${e.title}${tag}${recips}`;
    }).join("\n") + "\n";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx src/lib/spacetime.gcal-serialize.test.ts`
Expected: three `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 6: Regression-check the existing spacetime suites + type-check**

Run: `npx tsx src/lib/spacetime.gcal-parse.test.ts` → `ALL CHECKS PASS` (Task 1 still green).
Run: `npx tsc --noEmit` → no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/spacetime.ts src/lib/spacetime.gcal-serialize.test.ts
git commit -m "feat: serialize email recipients on spacetime event lines (round-trip)"
```

---

### Task 3: Host/invitee resolution

**Files:**
- Create: `src/lib/gcal-recipients.ts`
- Create: `src/lib/gcal-recipients.test.ts`

**Interfaces:**
- Produces: `export interface ResolvedRecipients { host: string | null; invitees: string[] }` and `export function resolveRecipients(emails: string[], connectedAccounts: string[], defaultAccount: string | null): ResolvedRecipients`. All emails are compared case-insensitively and returned lowercased. `host` is `null` only when there are no emails, or no connected match and no default. Push (a later plan) consumes this.

- [ ] **Step 1: Write the failing test**

Create `src/lib/gcal-recipients.test.ts`:

```ts
// Run: npx tsx src/lib/gcal-recipients.test.ts  → "ALL CHECKS PASS"
import { resolveRecipients } from "./gcal-recipients";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const connected = ["geet.duggal@gmail.com", "geet@verkada.com"];
const def = "geet.duggal@gmail.com";

// 1. No emails → not a synced event.
assertEq(resolveRecipients([], connected, def), { host: null, invitees: [] }, "no emails");

// 2. Connected email is the host, no invite.
assertEq(resolveRecipients(["geet@verkada.com"], connected, def),
  { host: "geet@verkada.com", invitees: [] }, "connected = host, no invite");

// 3. One contact → host = default, invite the contact.
assertEq(resolveRecipients(["rohit@verkada.com"], connected, def),
  { host: "geet.duggal@gmail.com", invitees: ["rohit@verkada.com"] }, "contact → default host + invite");

// 4. Connected host + multiple contacts.
assertEq(resolveRecipients(["geet@verkada.com", "rohit@verkada.com", "bob@acme.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["rohit@verkada.com", "bob@acme.com"] }, "host + invitees");

// 5. Case-insensitive, normalized to lowercase.
assertEq(resolveRecipients(["GEET@Verkada.com", "Rohit@Verkada.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["rohit@verkada.com"] }, "case-insensitive");

// 6. No connected match, no default → host null (caller blocks).
assertEq(resolveRecipients(["rohit@verkada.com"], connected, null),
  { host: null, invitees: ["rohit@verkada.com"] }, "no default → host null");

// 7. A second connected email is never invited (it's yours), and host is the first connected.
assertEq(resolveRecipients(["geet@verkada.com", "geet.duggal@gmail.com", "bob@acme.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["bob@acme.com"] }, "second own account not invited");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/gcal-recipients.test.ts`
Expected: FAIL — `Cannot find module './gcal-recipients'`.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/gcal-recipients.ts`:

```ts
// Pure host/invitee resolution for Google Calendar sync. Given the emails
// written on an event line, the user's connected (authenticated) accounts, and
// their default account, decide which calendar HOSTS the event and who is
// INVITED. Dependency-free so it can be unit-tested in isolation.
export interface ResolvedRecipients {
  /** The account whose calendar hosts the event, or null when it can't be
   *  determined (no emails, or no connected match and no default set). */
  host: string | null;
  /** Emails to invite as attendees (never includes a connected account). */
  invitees: string[];
}

export function resolveRecipients(
  emails: string[],
  connectedAccounts: string[],
  defaultAccount: string | null,
): ResolvedRecipients {
  const norm = (e: string) => e.trim().toLowerCase();
  const list = emails.map(norm).filter((e) => e.length > 0);
  if (list.length === 0) return { host: null, invitees: [] };

  const connected = new Set(connectedAccounts.map(norm));
  const onLineConnected = list.filter((e) => connected.has(e));
  const invitees = list.filter((e) => !connected.has(e));

  if (onLineConnected.length > 0) {
    return { host: onLineConnected[0], invitees };
  }
  return { host: defaultAccount ? norm(defaultAccount) : null, invitees };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/gcal-recipients.test.ts`
Expected: seven `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/gcal-recipients.ts src/lib/gcal-recipients.test.ts
git commit -m "feat: resolve host calendar + invitees from event-line emails"
```

---

### Task 4: Verification

**Files:** none.

- [ ] **Step 1: Run all three new test scripts**

```
npx tsx src/lib/spacetime.gcal-parse.test.ts
npx tsx src/lib/spacetime.gcal-serialize.test.ts
npx tsx src/lib/gcal-recipients.test.ts
```
Expected: each prints `ALL CHECKS PASS`.

- [ ] **Step 2: Full type-check + build**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

- [ ] **Step 3: Commit (only if a fix was needed above)**

```bash
git add -A
git commit -m "chore: gcal recipient foundation verification"
```

---

## Notes for the implementer
- This plan is foundation only — no Google API, OAuth, Rust, or UI. Resist adding any; later plans build on these interfaces.
- `SpacetimeEvent.emails`, `parseMarkwhenFormat`, `serializeMarkwhen`, `spliceMwEvents`, and `resolveRecipients` are the exact names later plans depend on — keep them as written.
- Follow the existing `src/lib/file-piles.test.ts` test style; do not introduce vitest/jest.
