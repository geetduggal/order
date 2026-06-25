# Brace folder-tag syntax `#[Exact Name]` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `#[Exact Folder Name]` the canonical folder tag on `spacetime.mw` event lines — parse both brace and legacy `#kebab`, serialize brace, and migrate the existing file.

**Architecture:** All folder-tag handling lives in `src/lib/spacetime.ts`. A new `toBraceTag` emitter + `stripTagToName` fallback (Task 1) feed the parser (accepts both forms, Task 2), the resolution map (`buildTagLookup` registers both forms, Task 2), and the serializer (emits brace, Task 3). A `migrateMwTagsToBrace` helper (Task 4) re-serializes only the `## Events` block. The live migration of the real `spacetime.mw` is a controller/human step (Task 5) — backup + diff review.

**Tech Stack:** TypeScript. Tests via standalone `tsx` scripts (local `assertEq`, `ALL CHECKS PASS`).

## Global Constraints

- Parse BOTH `#[Exact Name]` and legacy `#kebab` (back-compat); kebab parsing must remain byte-identical for old files.
- Folder resolution only runs when a `# Space` section is present (`spacetime.ts:927` guard `events.length > 0 && space.length > 0`) — preserve that guard.
- The serializer emits `#[Exact Name]` for ALL folder tags going forward (brace is canonical), preserving the name's exact case/spacing.
- Migration rewrites ONLY the `## Events` block via `spliceMwEvents`; Space/Seasons stay byte-identical. The real-file migration happens with a timestamped backup + before/after diff.
- All changes confined to `src/lib/spacetime.ts` (+ its tests). `toMarkwhenTag` is used only within this file (verified) — keep it (back-compat resolution still needs it).
- No Claude/AI git authorship trailers.

---

### Task 1: `toBraceTag` + `stripTagToName` helpers (TDD)

**Files:**
- Modify: `src/lib/spacetime.ts` (add two functions near `toMarkwhenTag`, ~line 596)
- Create: `src/lib/spacetime.brace-tag.test.ts`

**Interfaces:**
- Produces: `export function toBraceTag(name: string): string` → `` `#[${name}]` ``; `export function stripTagToName(tag: string): string` — a `#[Name]` token → `Name` (trimmed), otherwise `tag.slice(1)` (legacy kebab).

- [ ] **Step 1: Write the failing test**

Create `src/lib/spacetime.brace-tag.test.ts`:

```ts
// Run: npx tsx src/lib/spacetime.brace-tag.test.ts  → "ALL CHECKS PASS"
import { toBraceTag, stripTagToName } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

assertEq(toBraceTag("Geet Duggal"), "#[Geet Duggal]", "toBraceTag multi-word");
assertEq(toBraceTag("order"), "#[order]", "toBraceTag single-word preserves case-as-is");
assertEq(stripTagToName("#[Geet Duggal]"), "Geet Duggal", "stripTagToName brace");
assertEq(stripTagToName("#[ Spaced ]"), "Spaced", "stripTagToName trims inner");
assertEq(stripTagToName("#geet-duggal"), "geet-duggal", "stripTagToName kebab fallback");

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts`
Expected: FAIL — `toBraceTag`/`stripTagToName` not exported.

- [ ] **Step 3: Implement**

In `src/lib/spacetime.ts`, just after `toMarkwhenTag` (the function ending ~line 598), add:

```ts
/** Brace folder tag: "Geet Duggal" → "#[Geet Duggal]". The canonical form on
 *  event lines — exact name, no kebab mangling. */
export function toBraceTag(name: string): string {
  return `#[${name}]`;
}

/** Strip a folder-tag token to a plain name. A brace token `#[Name]` → `Name`
 *  (trimmed); any other `#token` → the token minus its leading `#` (legacy
 *  kebab fallback). Used when a tag doesn't resolve to a known Space folder. */
export function stripTagToName(tag: string): string {
  const b = tag.match(/^#\[(.+)\]$/);
  return b ? b[1].trim() : tag.slice(1);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts`
Expected: 5 `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/spacetime.ts src/lib/spacetime.brace-tag.test.ts
git commit -m "feat: toBraceTag + stripTagToName helpers for brace folder tags"
```

---

### Task 2: Parser accepts brace tags + resolution handles both forms (TDD)

**Files:**
- Modify: `src/lib/spacetime.ts` (event-line parser ~909-915; `buildTagLookup` ~826; resolution ~931)
- Modify: `src/lib/spacetime.brace-tag.test.ts` (append parse/resolution tests)

**Interfaces:**
- Consumes: `toBraceTag`, `stripTagToName` (Task 1).
- Produces: `parseMarkwhenFormat` recognizes `#[Exact Name]` (stored as the raw `#[…]` token, then resolved to the real name when a Space section is present) AND legacy `#kebab` (unchanged).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/spacetime.brace-tag.test.ts` (before the final `console.log("ALL CHECKS PASS")` — move that line to the very end). Add the import and assertions:

```ts
import { parseMarkwhenFormat } from "./spacetime";

// Parser captures a brace tag as the raw token when there's no Space to resolve.
{
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n2026-06-25 09:00 : Standup #[Geet Duggal]\n`);
  assertEq(st.events[0].folder, "#[Geet Duggal]", "brace tag captured (unresolved, no space)");
  assertEq(st.events[0].title, "Standup", "title excludes the brace tag");
}
// Brace tag + trailing emails both parse.
{
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n2026-06-25 09:00 : Sync #[Geet Duggal] a@x.com b@y.com\n`);
  assertEq(st.events[0].folder, "#[Geet Duggal]", "brace tag with emails: folder");
  assertEq(st.events[0].emails ?? null, ["a@x.com", "b@y.com"], "brace tag with emails: emails");
  assertEq(st.events[0].title, "Sync", "brace tag with emails: title");
}
// With a Space section, BOTH brace and kebab resolve to the real folder name.
{
  const space = `# Space\n\n## Personal\n\n- Projects\n  - Geet Duggal\n\n`;
  const brace = parseMarkwhenFormat(`${space}# Time\n\n## Events\n\n2026-06-25 09:00 : A #[Geet Duggal]\n`);
  assertEq(brace.events[0].folder, "Geet Duggal", "brace resolves to real name");
  const kebab = parseMarkwhenFormat(`${space}# Time\n\n## Events\n\n2026-06-25 09:00 : A #geet-duggal\n`);
  assertEq(kebab.events[0].folder, "Geet Duggal", "legacy kebab still resolves (back-compat)");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts`
Expected: FAIL — the brace tag isn't recognized (folder is `null`/title includes `#[…]`).

- [ ] **Step 3: Implement the parser change**

In `src/lib/spacetime.ts`, replace the three tag lines in the event parser (currently):

```ts
      const tagM = work.match(/\s+(#[\w-]+)$/);
      const tagSlug = tagM ? tagM[1] : null;
      const title = (tagM ? work.slice(0, work.length - tagM[0].length) : work).trim();
```

with brace-aware matching:

```ts
      // Folder tag: try the brace form #[Exact Name] first (spaces/case ok),
      // then the legacy #kebab form. Store the raw token; it's resolved to the
      // real folder name after the Space section is parsed (when present).
      const braceM = work.match(/\s+#\[([^\]]+)\]$/);
      const kebabM = braceM ? null : work.match(/\s+(#[\w-]+)$/);
      const tagToken = braceM ? `#[${braceM[1].trim()}]` : (kebabM ? kebabM[1] : null);
      const tagLen = braceM ? braceM[0].length : (kebabM ? kebabM[0].length : 0);
      const title = (tagToken ? work.slice(0, work.length - tagLen) : work).trim();
```

Then update the event push a few lines below — change `...(tagSlug ? { folder: tagSlug } : {})` to:

```ts
        ...(tagToken ? { folder: tagToken } : {}),
```

- [ ] **Step 4: Implement the resolution change**

In `buildTagLookup` (the `walk` loop, ~line 826), register BOTH tag forms per folder. Replace:

```ts
    for (const n of nodes) { map.set(toMarkwhenTag(n.name), n.name); walk(n.children); }
```

with:

```ts
    for (const n of nodes) {
      map.set(toMarkwhenTag(n.name), n.name);
      map.set(toBraceTag(n.name), n.name);
      walk(n.children);
    }
```

And in the resolution loop (~line 931), replace the kebab-only fallback:

```ts
        ev.folder = tagLookup.get(ev.folder) ?? ev.folder.slice(1);
```

with the brace-aware fallback:

```ts
        ev.folder = tagLookup.get(ev.folder) ?? stripTagToName(ev.folder);
```

- [ ] **Step 5: Run to verify it passes + back-compat**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts` → `ALL CHECKS PASS`.
Run: `npx tsx src/lib/spacetime.gcal-parse.test.ts` → `ALL CHECKS PASS` (legacy kebab parse unchanged).

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/spacetime.ts src/lib/spacetime.brace-tag.test.ts
git commit -m "feat: parse #[Exact Name] folder tags + resolve both brace and kebab"
```

---

### Task 3: Serializer emits brace (TDD) + update existing serialize tests

**Files:**
- Modify: `src/lib/spacetime.ts` (event-line serializers at ~657 and ~682)
- Modify: `src/lib/spacetime.gcal-serialize.test.ts` (update tag assertions)
- Modify: `src/lib/spacetime.brace-tag.test.ts` (append a serialize/round-trip test)

**Interfaces:**
- Consumes: `toBraceTag` (Task 1).
- Produces: `serializeMarkwhen` and `spliceMwEvents` write folder tags as `#[Exact Name]`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/spacetime.brace-tag.test.ts` (keep `ALL CHECKS PASS` last). Add the import:

```ts
import { serializeMarkwhen, spliceMwEvents } from "./spacetime";

// Serializer emits the brace form, preserving the name's case.
{
  const mw = serializeMarkwhen({ space: [], seasons: [], events: [
    { date: "2026-06-25", title: "Standup", folder: "Geet Duggal", time: "09:00" },
  ] });
  if (!mw.includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: serializeMarkwhen should emit brace tag\n" + mw);
  console.log("ok: serializeMarkwhen emits brace tag");
}
// spliceMwEvents emits brace too; a kebab line round-trips to brace.
{
  const spliced = spliceMwEvents("# Time\n\n## Events\n", [
    { date: "2026-06-25", title: "Plan", folder: "Geet Duggal", time: "14:00" },
  ]);
  if (!spliced.includes(": Plan #[Geet Duggal]")) throw new Error("FAIL: spliceMwEvents should emit brace tag\n" + spliced);
  console.log("ok: spliceMwEvents emits brace tag");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts`
Expected: FAIL — serializer still emits `#geet-duggal`, not `#[Geet Duggal]`.

- [ ] **Step 3: Implement the serializer change**

In `src/lib/spacetime.ts`, both event-line emitters currently read:

```ts
      const tag = e.folder ? ` ${toMarkwhenTag(e.folder)}` : "";
```

(one in `serializeMarkwhen` ~line 657, one in `spliceMwEvents` ~line 682). Change BOTH to:

```ts
      const tag = e.folder ? ` ${toBraceTag(e.folder)}` : "";
```

- [ ] **Step 4: Update the existing serialize test to the new canonical form**

In `src/lib/spacetime.gcal-serialize.test.ts`, the events use `folder: "Acme"`, so the serialized tag is now `#[Acme]`. Update the two literal checks:

- Line ~29: change `": Standup #acme you@example.com"` to `": Standup #[Acme] you@example.com"`.
- Line ~34: change `": Planning #acme a@x.com b@y.com"` to `": Planning #[Acme] a@x.com b@y.com"`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts` → `ALL CHECKS PASS`.
Run: `npx tsx src/lib/spacetime.gcal-serialize.test.ts` → `ALL CHECKS PASS`.
Run: `npx tsx src/lib/spacetime.gcal-parse.test.ts` → `ALL CHECKS PASS`.

- [ ] **Step 6: Type-check + build + commit**

Run: `npx tsc --noEmit` → no output.
Run: `pnpm build` → ends with `✓ built`.

```bash
git add src/lib/spacetime.ts src/lib/spacetime.gcal-serialize.test.ts src/lib/spacetime.brace-tag.test.ts
git commit -m "feat: serialize folder tags as #[Exact Name] (brace canonical)"
```

---

### Task 4: `migrateMwTagsToBrace` helper (TDD)

**Files:**
- Modify: `src/lib/spacetime.ts` (add the helper near `spliceMwEvents`)
- Modify: `src/lib/spacetime.brace-tag.test.ts` (append a migration test)

**Interfaces:**
- Consumes: `parseMarkwhenFormat`, `spliceMwEvents`.
- Produces: `export function migrateMwTagsToBrace(mw: string): string` — re-serializes only the `## Events` block (kebab tags → brace), leaving Space/Seasons untouched. Idempotent.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/spacetime.brace-tag.test.ts` (keep `ALL CHECKS PASS` last). Add the import:

```ts
import { migrateMwTagsToBrace } from "./spacetime";

// Migration rewrites event tags kebab→brace, leaves the Space section intact.
{
  const before = `# Space\n\n## Personal\n\n- Projects\n  - Geet Duggal\n\n# Time\n\n## Events\n\n2026-06-25 09:00: Standup #geet-duggal\n`;
  const after = migrateMwTagsToBrace(before);
  if (!after.includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: migration should produce brace tag\n" + after);
  if (!after.includes("## Personal") || !after.includes("  - Geet Duggal")) throw new Error("FAIL: migration must preserve Space section\n" + after);
  // Idempotent: running again is a no-op on the tag.
  if (!migrateMwTagsToBrace(after).includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: migration not idempotent");
  console.log("ok: migrateMwTagsToBrace converts tags + preserves space + idempotent");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts`
Expected: FAIL — `migrateMwTagsToBrace` not exported.

- [ ] **Step 3: Implement**

In `src/lib/spacetime.ts`, just after `spliceMwEvents` (ends ~line 715), add:

```ts
/** One-time migration: rewrite the `## Events` block's folder tags to the brace
 *  form by re-parsing and re-splicing. Space/Seasons stay byte-identical
 *  (spliceMwEvents only replaces from `## Events` onward). Idempotent. */
export function migrateMwTagsToBrace(mw: string): string {
  return spliceMwEvents(mw, parseMarkwhenFormat(mw).events);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx src/lib/spacetime.brace-tag.test.ts` → `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → no output.

```bash
git add src/lib/spacetime.ts src/lib/spacetime.brace-tag.test.ts
git commit -m "feat: migrateMwTagsToBrace — one-time kebab→brace tag migration"
```

---

### Task 5: Verification + LIVE migration of the real `spacetime.mw`

**Files:** none (operates on the vault file).

- [ ] **Step 1: Full gate run**

```
npx tsx src/lib/spacetime.brace-tag.test.ts      # ALL CHECKS PASS
npx tsx src/lib/spacetime.gcal-parse.test.ts     # ALL CHECKS PASS
npx tsx src/lib/spacetime.gcal-serialize.test.ts # ALL CHECKS PASS
npx tsc --noEmit                                  # clean
pnpm build                                        # ✓ built
```

- [ ] **Step 2: LIVE migration (controller/human — backup + diff review)**

This step runs against the real `/Users/geet.duggal/Development/Dropbox/Home/spacetime.mw`. It is NOT a blind subagent action — back up first, generate the migrated file, and review the diff before overwriting:

1. Back up: copy `spacetime.mw` to `spacetime.mw.bak-<timestamp>`.
2. Produce the migrated text with `migrateMwTagsToBrace` (a tiny one-off `tsx` reading the real file, writing to a temp file).
3. `diff` the temp file against the original — confirm ONLY `## Events` folder tags changed (kebab → brace), and the Space/Seasons sections are identical. Flag any orphan tags that became `#[kebab-name]`.
4. On approval, overwrite `spacetime.mw` with the migrated text.
5. Open Order → confirm every event still shows its correct folder (the calendar reads the migrated mw).

- [ ] **Step 3: Commit (only if any code fix was needed during migration)**

```bash
git add -A
git commit -m "chore: brace-tag migration verification"
```

---

## Self-review notes
- Spec coverage: `toBraceTag`/`stripTagToName` (T1), parse both forms + resolve both (T2), serialize brace + update tests (T3), migration helper (T4), gates + live migration (T5). All spec sections covered.
- Back-compat: kebab parse path unchanged (T2 tries brace first; kebab regex can't match a brace token); the `space.length > 0` resolution guard is preserved; legacy `gcal-parse` test still passes.
- Type/name consistency: `toBraceTag`, `stripTagToName`, `tagToken`, `migrateMwTagsToBrace` consistent across tasks.

## Notes for the implementer
- This is the CORE `spacetime.mw` parser — do not change kebab behavior; only ADD brace. Run the legacy `spacetime.gcal-parse.test.ts` after Tasks 2 and 3 to prove back-compat.
- The brace name is stored as the full `#[…]` token at parse time so it matches the `toBraceTag` key in `buildTagLookup`; it's resolved (or stripped) only when a Space section exists.
- Do NOT perform the live vault-file migration (Task 5 Step 2) as an automated subagent action — it is controller/human-run with a backup + diff.
