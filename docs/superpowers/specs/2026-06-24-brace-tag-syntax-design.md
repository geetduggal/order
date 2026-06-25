# Brace folder-tag syntax `#[Exact Name]` (design)

## Goal

Make `#[Exact Folder Name]` the canonical folder tag on `spacetime.mw` event
lines, so multi-word/special folder names round-trip without kebab mangling.
Parse **both** the new brace form and the legacy `#kebab` form (back-compat),
**serialize** the brace form going forward, and **migrate** the existing
`spacetime.mw` from kebab to brace.

## Why

Today a folder tag is `#kebab-case` (`spacetime.ts:596` `toMarkwhenTag`). It's
lossy and ambiguous for multi-word names ("Geet Duggal" and "Geet-Duggal" both
→ `#geet-duggal`) and unreadable. `#[Geet Duggal]` is exact and legible. The
current parser regex `/\s+(#[\w-]+)$/` (`spacetime.ts:909`) does **not** match
brackets/spaces, so converting tags without first teaching the parser would
strip every folder association — this must be implemented before any migration.

## Current mechanism (the chokepoints)

- **Serialize** (`spacetime.ts:657`, `:682`): `e.folder` holds the *real* name;
  `tag = toMarkwhenTag(e.folder)`.
- **Parse** (`spacetime.ts:909-915`): peel trailing emails, then match the kebab
  tag; store `ev.folder = "#kebab"` (the raw token).
- **Resolve** (`spacetime.ts:823-829`, `:928-931`): `buildTagLookup` maps
  `toMarkwhenTag(name) → name`; then `ev.folder = tagLookup.get(ev.folder) ?? ev.folder.slice(1)`.
- `toMarkwhenTag` is referenced **only** within `spacetime.ts` (verified). The
  change is contained to this file.

## Design

### 1. New tag emitter
`export function toBraceTag(name: string): string` → `` `#[${name}]` ``. Keep
`toMarkwhenTag` (kebab) — it's still needed for back-compat resolution.

### 2. Parser — accept both forms (`spacetime.ts:909-911`)
After emails are peeled from `work`, try the **brace** form first, then kebab:
- Brace: `work.match(/\s+#\[([^\]]+)\]$/)` → `ev.folder = "#[" + inner.trim() + "]"`
  (store the **full token** so resolution's `.get()` can match), title = the rest.
- Else kebab: existing `work.match(/\s+(#[\w-]+)$/)` → `ev.folder = "#kebab"`.
- The kebab regex can't match a brace token (`[` isn't in `[\w-]`), so order is
  safe, but try brace first for clarity.

### 3. Resolution — handle both (`spacetime.ts:823-829`, `:928-931`)
- `buildTagLookup` adds **both** keys per folder: `map.set(toMarkwhenTag(n.name), n.name)`
  AND `map.set(toBraceTag(n.name), n.name)`. So `#kebab` and `#[Exact Name]` both
  resolve to the real name.
- Replace the inline fallback `ev.folder.slice(1)` with a helper
  `stripTagToName(tag)`: a `#[Name]` token → `Name` (trimmed); otherwise
  `tag.slice(1)` (existing kebab behavior). This fixes the unknown-folder case so
  a brace tag for a folder not in the Space still yields a clean name, not
  `[Name]`.

### 4. Serializer — emit brace (`spacetime.ts:657`, `:682`)
Replace `toMarkwhenTag(e.folder)` with `toBraceTag(e.folder)` in both event-line
emitters (`serializeMarkwhen` and `spliceMwEvents`). Going forward, every event
Order writes uses `#[Exact Name]`.

### 5. Email-peel interaction (unchanged, verified safe)
Emails are peeled before the tag; a folder name has no `@`, so it's never
mistaken for a recipient. `Title #[Geet Duggal] a@x.com b@y.com` parses to
title "Title", folder "Geet Duggal", emails [a@x.com, b@y.com].

### 6. One-time migration of `spacetime.mw`
Because the serializer now emits brace, re-serializing the events block converts
kebab→brace while leaving the Space/Seasons sections byte-identical:
`migrated = spliceMwEvents(mw, parseMarkwhenFormat(mw).events)`. The migration
step: **back up** `spacetime.mw` first (timestamped copy), apply the splice,
write back, and diff to confirm only `## Events` tag tokens changed. Events whose
kebab tag matches a Space folder resolve to the real name (`#[Geet Duggal]`);
any orphan-folder event (kebab not in Space) becomes `#[geet-duggal]` (bracketed
kebab) — acceptable, still valid and reversible.

## Out of scope
- Folder references in note frontmatter (`folder: [[Name]]` wikilinks) — a
  different syntax, unaffected.
- Any push/import/recipients change.

## Testing
Unit (tsx, in `spacetime.test.ts` or a focused file):
- `toBraceTag("Geet Duggal")` → `#[Geet Duggal]`.
- Parse `… : Title #[Geet Duggal]` → folder "Geet Duggal".
- Parse legacy `… : Title #geet-duggal` (with a Space defining "Geet Duggal") →
  folder "Geet Duggal" (back-compat).
- Parse brace + emails → folder + emails both correct.
- Serialize an event with folder "Geet Duggal" → line ends `#[Geet Duggal]`.
- Round-trip: a kebab line → parse → serialize → `#[Geet Duggal]` (idempotent on
  re-parse).
- `stripTagToName`: `#[X Y]`→"X Y", `#x-y`→"x-y".
- Migration: a sample mw with kebab event tags + a Space section → `spliceMwEvents`
  yields brace event tags with the Space section unchanged.

Gates: `tsc --noEmit`, `pnpm build`, the existing `spacetime` tests still pass.
Then the live migration on the real `spacetime.mw` (backed up), with a
before/after diff review.

## Risk
This touches the core `spacetime.mw` parser — a defect orphans every event's
folder. Mitigated by: contained change (one file, one tag chokepoint),
comprehensive round-trip + back-compat tests, a backed-up + diff-reviewed
migration, and keeping kebab parsing intact so old files still load.
