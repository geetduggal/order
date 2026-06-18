# Spacetime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `spacetime.yml` the canonical source of truth for space + seasons, and optionally strip YAML frontmatter from event notes and remove chain index files, with a safe backup/restore path.

**Architecture:** Phased: (A) read from spacetime.yml (non-destructive fallback), (B) write mutations to spacetime.yml, (C) vault migration (backup → strip frontmatter → archive chain files). The app stays functional at every phase boundary because phase A falls back to chain files if spacetime.yml is absent or incomplete.

**Tech Stack:** Tauri v2, React 19, TypeScript, js-yaml, existing `vault-fs.ts` IPC layer (`vault_write_text` auto-creates dirs), `parseSpacetime`/`serializeSpacetime`/`buildSpacetime` in `lib/spacetime.ts`, `buildVaultTaxonomy` in `lib/taxonomy.ts`.

---

## Phase A — Read path (non-destructive)

### Task 1: `buildVaultTaxonomy` reads from spacetime.yml when present

**Files:**
- Modify: `src/lib/taxonomy.ts`
- Modify: `src/lib/spacetime.ts` (export `spacetimeTaxonomy`)

- [ ] **Step 1: Export a taxonomy builder from `SpaceNode[]`**

Add to `src/lib/spacetime.ts`:

```typescript
import type { VaultTaxonomy, AreaNode, CategoryNode } from "./taxonomy";

/** Build a VaultTaxonomy from a parsed spacetime.yml `space` tree.
 *  The three-level invariant (Area → Category → NF) is assumed; nodes
 *  that don't fit are silently skipped. hiddenRefs stays empty because
 *  there are no chain index files to hide when spacetime drives the
 *  taxonomy. */
export function spacetimeTaxonomy(space: SpaceNode[]): VaultTaxonomy {
  const areas: AreaNode[] = [];
  for (const areaNode of space) {
    const categories: CategoryNode[] = [];
    for (const catNode of areaNode.children) {
      const folders = catNode.children.map((f) => f.name);
      categories.push({ ref: catNode.name, folders });
    }
    areas.push({ ref: areaNode.name, categories });
  }
  return { areas, hiddenRefs: new Set() };
}
```

- [ ] **Step 2: In `buildVaultTaxonomy`, accept an optional parsed spacetime**

Add parameter and early-return to `src/lib/taxonomy.ts`:

```typescript
import { type Spacetime, spacetimeTaxonomy } from "./spacetime";

export function buildVaultTaxonomy(
  notes: ChainNote[],
  spacetime?: Spacetime,
): VaultTaxonomy {
  // Prefer spacetime.yml when it carries a non-empty space tree.
  if (spacetime && spacetime.space.length > 0) {
    return spacetimeTaxonomy(spacetime.space);
  }
  // … existing chain-walking code unchanged …
```

- [ ] **Step 3: Pass parsed spacetime to `buildVaultTaxonomy` in `CardGrid`**

In `src/components/CardGrid.tsx`, find where `buildVaultTaxonomy` is called (search `buildVaultTaxonomy(`) and pass the parsed spacetime:

```typescript
// existing: const tax = buildVaultTaxonomy(chainNotes);
// new:
const parsedSpacetime = spacetimeNote ? parseSpacetime(spacetimeNote.body ?? "") : undefined;
const tax = buildVaultTaxonomy(chainNotes, parsedSpacetime);
```

`spacetimeNote` is already located via `notes.find((n) => n.filename === SPACETIME_FILENAME)` (it exists in the mirror effect). Reuse that.

- [ ] **Step 4: Typecheck**

```bash
pnpm exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spacetime.ts src/lib/taxonomy.ts src/components/CardGrid.tsx
git commit -m "feat: taxonomy reads from spacetime.yml space when present, falls back to chain"
```

---

### Task 2: Seasons read from spacetime.yml when present

**Files:**
- Modify: `src/components/CardGrid.tsx` (SeasonView derivation, ~line 3110)

- [ ] **Step 1: In `CardGrid`, derive seasons from parsedSpacetime when available**

The seasons derivation is around line 3107:

```typescript
// existing:
const seasonsFile = notes.find((n) => isSeasonsFile(n.frontmatter, n.filename));
const seasons: Season[] = seasonsFile ? parseSeasons(seasonsFile.body) : [];

// new: prefer spacetime.yml seasons when present
const seasons: Season[] = (() => {
  if (parsedSpacetime && parsedSpacetime.seasons.length > 0) {
    return parsedSpacetime.seasons.map((s) => ({
      start: s.date,
      end: s.endDate ?? "",
      name: s.title,
    }));
  }
  const seasonsFile = notes.find((n) => isSeasonsFile(n.frontmatter, n.filename));
  return seasonsFile ? parseSeasons(seasonsFile.body) : [];
})();
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/components/CardGrid.tsx
git commit -m "feat: seasons read from spacetime.yml when present, falls back to Seasons.md"
```

---

### Task 3: Mirror preserves space + seasons instead of regenerating them

**Files:**
- Modify: `src/lib/spacetime.ts` — `buildSpacetime` signature
- Modify: `src/components/CardGrid.tsx` — mirror effect

- [ ] **Step 1: Update `buildSpacetime` to accept an existing Spacetime for space/seasons**

```typescript
/** Build the canonical Spacetime model. When `existing` is provided its
 *  `space` and `seasons` are preserved (they are authoritative in
 *  spacetime.yml); only `events` are regenerated from note frontmatter. */
export function buildSpacetime(
  notes: SpacetimeNote[],
  tax: VaultTaxonomy,
  existing?: Spacetime,
): Spacetime {
  const space = existing && existing.space.length > 0
    ? existing.space
    : spaceFromTaxonomy(tax);

  const seasons: SpacetimeSeason[] = existing && existing.seasons.length > 0
    ? existing.seasons
    : (/* existing Seasons.md derivation code */ ...);
```

Move the Seasons.md derivation into the `else` branch (copy the 3 lines already in `buildSpacetime`).

- [ ] **Step 2: Pass existing spacetime to `buildSpacetime` in the mirror effect**

In `CardGrid`, the mirror effect calls `buildSpacetime(notes, tax)`. Update to:

```typescript
buildSpacetime(notes, tax, parsedSpacetime)
```

`parsedSpacetime` is already computed in Task 1 Step 3.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/lib/spacetime.ts src/components/CardGrid.tsx
git commit -m "feat: spacetime mirror preserves space+seasons from yml; only regenerates events"
```

---

### Task 4: Structure mutations write spacetime.yml

**Files:**
- Modify: `src/components/CardGrid.tsx` — `handleAddArea`, `handleAddCategory`, `handleCreateFolder`, `handleRemoveArea`, `handleRemoveCategory`, `handleRemoveFolder`, `handleReorderAreasTo`, `handleReorderCategoriesTo`, `handleReorderFoldersTo`

> This is the biggest task. All of the handlers currently call `mutateBullets` on the chain index files. We redirect them to `mutateSpaceNode` on spacetime.yml.

- [ ] **Step 1: Write a `mutateSpace` helper in `lib/spacetime.ts`**

```typescript
/** Apply a mutation to the SpaceNode tree, returning a new copy.
 *  All structure mutations (add/remove/reorder area/category/folder)
 *  go through this so they share the same tree-walk logic. */
export type SpaceMutation =
  | { kind: "addArea"; name: string }
  | { kind: "removeArea"; name: string }
  | { kind: "reorderAreas"; names: string[] }
  | { kind: "addCategory"; area: string; name: string }
  | { kind: "removeCategory"; area: string; name: string }
  | { kind: "reorderCategories"; area: string; names: string[] }
  | { kind: "addFolder"; area: string; category: string; name: string }
  | { kind: "removeFolder"; area: string; category: string; name: string }
  | { kind: "reorderFolders"; area: string; category: string; names: string[] };

export function applySpaceMutation(space: SpaceNode[], m: SpaceMutation): SpaceNode[] {
  switch (m.kind) {
    case "addArea":
      if (space.some((n) => n.name === m.name)) return space;
      return [...space, { name: m.name, children: [] }];
    case "removeArea":
      return space.filter((n) => n.name !== m.name);
    case "reorderAreas":
      return m.names.map((name) => space.find((n) => n.name === name) ?? { name, children: [] });
    case "addCategory":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.some((c) => c.name === m.name)
          ? a.children
          : [...a.children, { name: m.name, children: [] }],
      });
    case "removeCategory":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.filter((c) => c.name !== m.name),
      });
    case "reorderCategories":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: m.names.map((n) => a.children.find((c) => c.name === n) ?? { name: n, children: [] }),
      });
    case "addFolder":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: c.children.some((f) => f.name === m.name)
            ? c.children
            : [...c.children, { name: m.name, children: [] }],
        }),
      });
    case "removeFolder":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: c.children.filter((f) => f.name !== m.name),
        }),
      });
    case "reorderFolders":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: m.names.map((n) => c.children.find((f) => f.name === n) ?? { name: n, children: [] }),
        }),
      });
  }
}
```

- [ ] **Step 2: Write a `patchSpacetimeYml` async helper in `CardGrid.tsx`**

Reads the current spacetime.yml, applies a SpaceMutation, serializes + writes back.

```typescript
async function patchSpacetimeYml(mutation: SpaceMutation): Promise<void> {
  const raw = await vaultFs.readText(SPACETIME_FILENAME).catch(() => "");
  const st = parseSpacetime(raw);
  const next: Spacetime = { ...st, space: applySpaceMutation(st.space, mutation) };
  await writeVault(SPACETIME_FILENAME, serializeSpacetime(next));
}
```

Import `applySpaceMutation` and `SpaceMutation` from `lib/spacetime.ts`.

- [ ] **Step 3: Redirect each structure handler to `patchSpacetimeYml`**

Replace the chain-writing logic in:
- `handleAddArea(name)` → `patchSpacetimeYml({ kind: "addArea", name })`
- `handleRemoveArea(ref)` → `patchSpacetimeYml({ kind: "removeArea", name: ref })`
- `handleReorderAreasTo(names)` → `patchSpacetimeYml({ kind: "reorderAreas", names })`
- `handleAddCategory(area, cat)` → `patchSpacetimeYml({ kind: "addCategory", area, name: cat })`
- `handleRemoveCategory(area, cat)` → `patchSpacetimeYml({ kind: "removeCategory", area, name: cat })`
- `handleReorderCategoriesTo(area, names)` → `patchSpacetimeYml({ kind: "reorderCategories", area, names })`
- `handleCreateFolder(area, category, name)` → `patchSpacetimeYml({ kind: "addFolder", area, category, name })` (then create the NF dir + main doc as before — that part stays)
- `handleRemoveFolder(area, category, name)` → `patchSpacetimeYml({ kind: "removeFolder", area, category, name })` (then `vaultFs.remove` dir as before)
- `handleReorderFoldersTo(area, category, names)` → `patchSpacetimeYml({ kind: "reorderFolders", area, category, names })`

Note: keep the physical filesystem operations (create dir, remove dir) as-is. Only the index-file mutations (`mutateBullets`) are replaced.

- [ ] **Step 4: Seasons write path: redirect season edits to spacetime.yml**

Find the season create/edit handler in `CardGrid` (writes to `Seasons.md` via `writeVault`). Replace with:

```typescript
async function patchSpacetimeSeasons(seasons: SpacetimeSeason[]): Promise<void> {
  const raw = await vaultFs.readText(SPACETIME_FILENAME).catch(() => "");
  const st = parseSpacetime(raw);
  await writeVault(SPACETIME_FILENAME, serializeSpacetime({ ...st, seasons }));
}
```

Route all season writes through this instead of `writeVault("Seasons.md", ...)`.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/lib/spacetime.ts src/components/CardGrid.tsx
git commit -m "feat: all structure + season mutations write spacetime.yml; chain files no longer written"
```

---

## Phase B — Test the read + write round-trip

### Task 5: Unit tests for spacetime mutation helpers

**Files:**
- Create: `tests/e2e/spacetime-mutations.spec.ts`

- [ ] **Step 1: Write and run tests**

```typescript
import { applySpaceMutation, type SpaceNode } from "../../src/lib/spacetime";
import assert from "node:assert";

const base: SpaceNode[] = [
  { name: "Work", children: [
    { name: "Projects", children: [
      { name: "Order", children: [] },
      { name: "PKM", children: [] },
    ]},
  ]},
];

// addArea
let r = applySpaceMutation(base, { kind: "addArea", name: "Personal" });
assert.equal(r.length, 2);
assert.equal(r[1].name, "Personal");

// reorderAreas
r = applySpaceMutation(r, { kind: "reorderAreas", names: ["Personal", "Work"] });
assert.equal(r[0].name, "Personal");

// addFolder round-trip
r = applySpaceMutation(base, { kind: "addFolder", area: "Work", category: "Projects", name: "NewApp" });
const proj = r[0].children[0];
assert.equal(proj.children.length, 3);
assert.equal(proj.children[2].name, "NewApp");

// removeFolder
r = applySpaceMutation(base, { kind: "removeFolder", area: "Work", category: "Projects", name: "Order" });
assert.equal(r[0].children[0].children.length, 1);
assert.equal(r[0].children[0].children[0].name, "PKM");

console.log("ALL PASS");
```

Run: `node tests/e2e/spacetime-mutations.spec.ts`
Expected: `ALL PASS`

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/spacetime-mutations.spec.ts
git commit -m "test: spacetime space mutation helpers"
```

---

## Phase C — Vault migration (run after install, never on the old build)

### Task 6: Vault backup

**Files:**
- Create: `src/lib/vault-backup.ts`
- Add command to `src-tauri/src/vault_fs.rs` + `lib.rs`

- [ ] **Step 1: Add `vault_backup` Rust command**

In `src-tauri/src/vault_fs.rs`, add:

```rust
#[tauri::command]
pub fn vault_backup(state: tauri::State<VaultState>) -> Result<String, String> {
    let root = state.root.lock().unwrap().clone().ok_or("no vault")?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // ISO-ish stamp: YYYYMMDDTHHMMSS
    let dt = chrono::DateTime::from_timestamp(ts as i64, 0)
        .ok_or("bad timestamp")?
        .format("%Y%m%dT%H%M%S")
        .to_string();
    let backup_root = root.join(".order-legacy").join(format!("backup-{dt}"));
    // Skip if a backup was made in the last 60 seconds
    if let Ok(entries) = std::fs::read_dir(root.join(".order-legacy")) {
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified.elapsed().unwrap_or_default().as_secs() < 60 {
                        return Ok(e.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    copy_dir_all(&root, &backup_root)?;
    Ok(backup_root.to_string_lossy().to_string())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        // Don't back up inside the backup dir itself
        if name == ".order-legacy" { continue; }
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(name))?;
        } else {
            std::fs::copy(entry.path(), dst.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

Add `chrono` to `src-tauri/Cargo.toml` if not present:
```toml
chrono = { version = "0.4", features = ["serde"] }
```

Register in `src-tauri/src/lib.rs`:
```rust
vault_fs::vault_backup,
```

- [ ] **Step 2: TS wrapper in `src/lib/vault-fs.ts`**

```typescript
export async function vaultBackup(): Promise<string> {
  return invoke<string>("vault_backup");
}
```

- [ ] **Step 3: Typecheck (TS) + Rust check**

```bash
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/vault_fs.rs src-tauri/Cargo.toml src-tauri/src/lib.rs src/lib/vault-fs.ts
git commit -m "feat: vault_backup Rust command — timestamped snapshot in .order-legacy/"
```

---

### Task 7: Migration runner — strip event frontmatter + archive chain files

**Files:**
- Create: `src/lib/vault-migrate.ts`
- Modify: `src/components/SettingsPanel.tsx` (add migration button)
- Modify: `src/components/CardGrid.tsx` (wire migration handler)

- [ ] **Step 1: Write `planMigration` (pure, no I/O)**

```typescript
// src/lib/vault-migrate.ts
import { splitFrontmatter, joinFrontmatter, type Frontmatter } from "./frontmatter";
import { toIsoDateValue } from "./frontmatter";

/** A note that carries event frontmatter (date + time/allDay) but is NOT
 *  a chain index file (Areas.md, list: cards area/category docs). */
export function isEventNote(fm: Frontmatter, filename: string): boolean {
  return !!toIsoDateValue(fm.date) && !fm.role && fm.list !== "cards" && fm.list !== "lines";
}

/** True for chain index files that are superseded by spacetime.yml. */
export function isChainIndex(fm: Frontmatter, filename: string): boolean {
  if (fm.role === "areas" || filename === "Areas.md") return true;
  if (fm.role === "seasons" || filename === "Seasons.md") return true;
  // list: cards files at the vault root (Area.md / Category.md index files)
  if (fm.list === "cards" && !fm.category) return true;
  return false;
}

export interface MigrationAction =
  | { kind: "stripFrontmatter"; path: string; newContent: string }
  | { kind: "archiveChainFile"; path: string; archivePath: string };

export function planVaultMigration(
  notes: { path: string; filename: string; frontmatter: Frontmatter; body: string; raw: string }[],
  archiveDir: string, // e.g. ".order-legacy/chain"
): MigrationAction[] {
  const actions: MigrationAction[] = [];
  for (const n of notes) {
    if (isChainIndex(n.frontmatter, n.filename)) {
      actions.push({
        kind: "archiveChainFile",
        path: n.path,
        archivePath: `${archiveDir}/${n.filename}`,
      });
    } else if (isEventNote(n.frontmatter, n.filename)) {
      // Strip only event-related frontmatter keys, keep everything else
      const { date, startTime, endTime, allDay, endDate, folder, ...rest } = n.frontmatter;
      void date; void startTime; void endTime; void allDay; void endDate; void folder;
      const newContent = Object.keys(rest).length > 0
        ? joinFrontmatter(rest, n.body)
        : n.body;
      if (newContent !== n.raw) {
        actions.push({ kind: "stripFrontmatter", path: n.path, newContent });
      }
    }
  }
  return actions;
}
```

- [ ] **Step 2: Add `onRunMigration` to `SettingsPanel`**

In `src/components/SettingsPanel.tsx`, add a button in the Spacetime section:

```tsx
{props.onRunMigration && (
  <button
    type="button"
    className="settings-btn settings-btn-danger"
    onClick={props.onRunMigration}
  >
    Migrate vault (strip event frontmatter + archive chain files)
  </button>
)}
```

- [ ] **Step 3: Wire in `CardGrid` with backup + confirm flow**

```typescript
const handleRunMigration = useCallback(async () => {
  // 1. Backup
  const backupPath = await vaultBackup();
  const ok = confirm(
    `Vault backed up to:\n${backupPath}\n\n` +
    `This will:\n` +
    `• Strip date/time/folder frontmatter from ${eventCount} event notes\n` +
    `• Archive Areas.md, Seasons.md, and category index files\n\n` +
    `Proceed?`
  );
  if (!ok) return;
  // 2. Plan
  const notesWithBody = await Promise.all(notes.map(async (n) => ({
    ...n,
    path: n.path ?? n.filename,
    raw: await vaultFs.readText(n.path ?? n.filename).catch(() => ""),
    body: splitFrontmatter(await vaultFs.readText(n.path ?? n.filename).catch(() => "")).body,
  })));
  const actions = planVaultMigration(notesWithBody, ".order-legacy/chain");
  // 3. Execute
  for (const a of actions) {
    if (a.kind === "stripFrontmatter") {
      await writeVault(a.path, a.newContent);
    } else if (a.kind === "archiveChainFile") {
      const content = await vaultFs.readText(a.path).catch(() => "");
      await writeVault(a.archivePath, content);
      await vaultFs.remove(a.path);
    }
  }
  alert(`Migration complete. ${actions.length} files updated. Backup at:\n${backupPath}`);
}, [notes]);
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/lib/vault-migrate.ts src/components/SettingsPanel.tsx src/components/CardGrid.tsx src/lib/vault-fs.ts
git commit -m "feat: vault migration — strip event frontmatter, archive chain files; backup first"
```

---

### Task 8: Unit tests for migration planner

**Files:**
- Create: `tests/e2e/vault-migrate.spec.ts`

- [ ] **Step 1: Write and run tests**

```typescript
import { planVaultMigration, isEventNote, isChainIndex } from "../../src/lib/vault-migrate";
import assert from "node:assert";

// isEventNote
assert(isEventNote({ date: "2026-06-15", startTime: "09:00", allDay: false, folder: "[[X]]" }, "2026-06-15 Note.md"));
assert(!isEventNote({ role: "areas", list: "cards" }, "Areas.md"));
assert(!isEventNote({ category: "Projects", list: "cards" }, "Projects.md"));

// isChainIndex
assert(isChainIndex({ role: "areas" }, "Areas.md"));
assert(isChainIndex({ list: "cards" }, "Craft.md")); // category index
assert(isChainIndex({ role: "seasons" }, "Seasons.md"));
assert(!isChainIndex({ category: "Projects" }, "Order.md")); // NF main doc — not a chain file

// planVaultMigration
const notes = [
  { path: "Areas.md", filename: "Areas.md", frontmatter: { role: "areas", list: "cards" }, body: "# Areas\n", raw: "---\nrole: areas\nlist: cards\n---\n# Areas\n" },
  { path: "Creative Spaces/Geet Duggal/2026-06-15 Note.md", filename: "2026-06-15 Note.md",
    frontmatter: { date: "2026-06-15", startTime: "09:00", allDay: false, folder: "[[Geet Duggal]]", title: "Note" },
    body: "# Note\nsome content\n",
    raw: "---\ndate: \"2026-06-15\"\nstartTime: \"09:00\"\nallDay: false\nfolder: \"[[Geet Duggal]]\"\ntitle: Note\n---\n# Note\nsome content\n" },
];
const actions = planVaultMigration(notes, ".order-legacy/chain");
assert.equal(actions.length, 2);
const archive = actions.find((a) => a.kind === "archiveChainFile");
const strip = actions.find((a) => a.kind === "stripFrontmatter");
assert(archive);
assert(strip);
// Stripped content should have no date/startTime/folder but keep title
assert(!strip!.newContent.includes("date:"));
assert(!strip!.newContent.includes("startTime:"));
assert(strip!.newContent.includes("title:") || strip!.newContent.includes("# Note"));

console.log("ALL PASS");
```

Run: `node tests/e2e/vault-migrate.spec.ts`
Expected: `ALL PASS`

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/vault-migrate.spec.ts
git commit -m "test: vault migration planner"
```

---

## Ship order

1. Merge Phase A (Tasks 1–3) first — non-destructive, ships on the existing `spacetime-source-of-truth` branch.
2. Add Phase A Task 4 (write path) — now no chain files are written, but existing ones still work as fallback.
3. Install and verify the vault still looks right.
4. Only then run Task 7 (migration button in Settings) on the actual vault.

## Out of scope for this plan
- Provenance cache (deferred — the app's in-memory `notes[]` + spacetime.yml serve as the source; a persistent cache across restarts is a future optimization)
- File watching for `spacetime.mw` (markwhen round-trip sync is already marked experimental/one-way)
- Folder renames (the spec's Step 5 is explicitly optional; can be done manually)
- `spacetime.mw` Markwhen output (nice to have, but the canonical format is `spacetime.yml`)
