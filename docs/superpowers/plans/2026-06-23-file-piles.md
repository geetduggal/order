# File Piles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user surface any markdown file (including undated reference docs) as the top card in a Notable Folder's note stream, reorder cards to the top, and close cards — all as session-only display state — plus rename/delete files in the folder's file browser.

**Architecture:** A pure helper `computePileOrder` orders a folder's non-main card stream from the default dated-note order plus two session-only structures (`front`, `hidden`) held in `CardGrid`. The single-folder newspaper section applies it and surfaces added files by path lookup. `Card` renders per-card close (X) and move-to-top controls; `NotableFolderBackside` (the file browser) gains per-row add-to-pile, rename, and delete.

**Tech Stack:** React 19 + TypeScript, Tauri v2, lucide-react icons, `vaultFs` bridge. Tests are standalone `tsx` scripts (no vitest): a `.test.ts` file with a local `assertEq` that throws, run via `npx tsx <file>`, printing `ALL CHECKS PASS`.

## Global Constraints

- Pile membership is **session-only** — held in React state, **zero disk writes**. Only rename/delete touch the filesystem.
- spacetime.mw remains the source of truth for events/structure; File Piles never reads or writes it.
- Pile controls and ordering apply **only in single-folder view** (`includeRefs.length === 1`). Home/multi-folder newspaper mode is unchanged.
- Add-to-pile is **markdown-only**.
- The Main Document is never hidden, never gets an add-to-pile icon, and keeps its existing X (`onRemoveFromFilter`).
- Match existing code style: no semicolize churn, reuse existing imports/classes (`order-card-btn`, `nf-flip-row`).

---

### Task 1: `computePileOrder` pure helper + unit test

**Files:**
- Create: `src/lib/file-piles.ts`
- Create: `src/lib/file-piles.test.ts`

**Interfaces:**
- Produces: `export function computePileOrder(datedNotePaths: string[], front: string[], hidden: ReadonlySet<string>, mainDocPath?: string | null): string[]` — returns the ordered list of **non-main** note paths to render: `front` items first (in array order), then `datedNotePaths` not already emitted, with any path in `hidden` or equal to `mainDocPath` removed, deduplicated (first occurrence wins).

- [ ] **Step 1: Write the failing test**

Create `src/lib/file-piles.test.ts`:

```ts
// Run: npx tsx src/lib/file-piles.test.ts  → prints "ALL CHECKS PASS"
import { computePileOrder } from "./file-piles";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const set = (...xs: string[]) => new Set(xs);

// 1. Default: no front, no hidden → dated order unchanged.
assertEq(
  computePileOrder(["b.md", "c.md"], [], set()),
  ["b.md", "c.md"],
  "default dated order",
);

// 2. Front prepends and reorders to the top, in front-array order.
assertEq(
  computePileOrder(["b.md", "c.md"], ["x.md", "c.md"], set()),
  ["x.md", "c.md", "b.md"],
  "front items first, then remaining dated",
);

// 3. Hidden removes from the stream (whether dated or front).
assertEq(
  computePileOrder(["b.md", "c.md"], ["x.md"], set("b.md")),
  ["x.md", "c.md"],
  "hidden dropped",
);

// 4. Dedup: a path in both front and dated appears once, in its front slot.
assertEq(
  computePileOrder(["b.md", "c.md"], ["c.md"], set()),
  ["c.md", "b.md"],
  "dedup front vs dated",
);

// 5. mainDocPath is defensively excluded and never appears.
assertEq(
  computePileOrder(["b.md"], ["main.md"], set(), "main.md"),
  ["b.md"],
  "main doc never in stream",
);

// 6. A hidden front item is dropped (close wins over add).
assertEq(
  computePileOrder(["b.md"], ["x.md"], set("x.md")),
  ["b.md"],
  "hidden beats front",
);

console.log("ALL CHECKS PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/lib/file-piles.test.ts`
Expected: FAIL — `Cannot find module './file-piles'` (or "computePileOrder is not a function").

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/file-piles.ts`:

```ts
// Session-only ordering for a Notable Folder's card stream (File Piles).
// Pure + dependency-free so it can be unit-tested in isolation.
//
// Order: `front` paths first (in array order), then the default
// `datedNotePaths` not already emitted. Any path in `hidden` or equal to
// `mainDocPath` is removed. Deduplicated — first occurrence wins. The Main
// Document is rendered separately as the section centerpiece, so it is
// excluded here defensively.
export function computePileOrder(
  datedNotePaths: string[],
  front: string[],
  hidden: ReadonlySet<string>,
  mainDocPath?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const skip = (p: string) =>
    hidden.has(p) || (mainDocPath != null && p === mainDocPath);
  for (const p of [...front, ...datedNotePaths]) {
    if (seen.has(p) || skip(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/lib/file-piles.test.ts`
Expected: prints six `ok:` lines then `ALL CHECKS PASS`.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` → no output (clean).

```bash
git add src/lib/file-piles.ts src/lib/file-piles.test.ts
git commit -m "feat: computePileOrder helper for File Piles session ordering"
```

---

### Task 2: CardGrid session state, handlers, and single-folder render

**Files:**
- Modify: `src/components/CardGrid.tsx` (import; state near other `useState`; handlers near `updateNoteFrontmatter`; `cardNode` signature; single-folder section build at ~4436-4451)

**Interfaces:**
- Consumes: `computePileOrder` from Task 1.
- Produces (used by Task 3 via `cardNode`'s third arg and by Task 4 via props):
  - `addToPile(folder: string, path: string): void` — move/insert `path` at the front of `folder`'s pile, clear it from hidden.
  - `closeFromPile(folder: string, path: string): void` — hide `path` in `folder`, remove from its front.
  - `addToPileByName(folderRef: string, folderRel: string, filename: string): void` — resolve a browser row to a note path and `addToPile`.
  - `renameVaultFile(folderRel: string, oldName: string, newName: string): Promise<void>` and `deleteVaultFile(folderRel: string, name: string): Promise<void>`.

- [ ] **Step 1: Add the import**

Find the import from `"../lib/spacetime"` block region; add a new import line after the `folders` import (near line 38):

```ts
import { computePileOrder } from "../lib/file-piles";
```

- [ ] **Step 2: Add session state**

Immediately after the `mwEventIndexRef`/`eventChipRef` refs area — concretely right after the line `const eventChipRef = useRef<Map<string, { ev: SpacetimeEvent; notePath: string | null }>>(new Map());` — add:

```ts
  // File Piles (session-only display state; never persisted). Keyed by folder
  // ref (canonical Notable Folder name). pileFront = paths moved/added to the
  // top in order; pileHidden = cards closed this session. Reset on restart.
  const [pileFront, setPileFront] = useState<Map<string, string[]>>(new Map());
  const [pileHidden, setPileHidden] = useState<Map<string, Set<string>>>(new Map());

  const addToPile = useCallback((folder: string, path: string) => {
    setPileFront((prev) => {
      const next = new Map(prev);
      const cur = next.get(folder) ?? [];
      next.set(folder, [path, ...cur.filter((p) => p !== path)]);
      return next;
    });
    setPileHidden((prev) => {
      const cur = prev.get(folder);
      if (!cur || !cur.has(path)) return prev;
      const next = new Map(prev);
      const s = new Set(cur);
      s.delete(path);
      next.set(folder, s);
      return next;
    });
  }, []);

  const closeFromPile = useCallback((folder: string, path: string) => {
    setPileHidden((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(folder) ?? []);
      s.add(path);
      next.set(folder, s);
      return next;
    });
    setPileFront((prev) => {
      const cur = prev.get(folder);
      if (!cur || !cur.includes(path)) return prev;
      const next = new Map(prev);
      next.set(folder, cur.filter((p) => p !== path));
      return next;
    });
  }, []);
```

- [ ] **Step 3: Add the browser-row resolver and rename/delete handlers**

Right after `closeFromPile`, add:

```ts
  // Resolve a file-browser row (folderRel + filename) to its loaded note path,
  // then surface it at the top of folderRef's pile.
  const addToPileByName = useCallback((folderRef: string, folderRel: string, filename: string) => {
    const rel = folderRel ? `${folderRel}/${filename}` : filename;
    const note = notesRef.current?.find((n) => toVaultRel(n.path) === rel);
    if (note) addToPile(folderRef, note.path);
  }, [addToPile]);

  const renameVaultFile = useCallback(async (folderRel: string, oldName: string, newName: string) => {
    const from = folderRel ? `${folderRel}/${oldName}` : oldName;
    const to = folderRel ? `${folderRel}/${newName}` : newName;
    if (from === to) return;
    await vaultFs.rename(from, to);
    await reloadNotes();
  }, [reloadNotes]);

  const deleteVaultFile = useCallback(async (folderRel: string, name: string) => {
    const ok = await tauriConfirm(`Delete "${name}"? This can't be undone.`, { title: "Delete file?", kind: "warning" });
    if (!ok) return;
    const rel = folderRel ? `${folderRel}/${name}` : name;
    await vaultFs.remove(rel);
    await reloadNotes();
  }, [reloadNotes]);
```

(`notesRef`, `vaultFs`, `toVaultRel`, `reloadNotes`, `tauriConfirm` all already exist/imported in this file. The confirm lives here — on all platforms — so the backside's delete button just calls through without its own prompt.)

- [ ] **Step 4: Extend `cardNode` to accept a pile context**

Find `const cardNode = (n: LoadedNote, capHeight?: number) => {` (~line 4254). Change the signature and add the close/add handlers passed to `<Card>`. New signature:

```ts
  const cardNode = (n: LoadedNote, capHeight?: number, pile?: { folder: string }) => {
```

Inside `cardNode`, locate the `<Card ... />` props and add these two props (place them right after the existing `onRemoveFromFilter={...}` prop line ~4292):

```ts
        onClosePile={pile && !isMain ? () => closeFromPile(pile.folder, n.path) : undefined}
        onAddToPile={pile && !isMain ? () => addToPile(pile.folder, n.path) : undefined}
```

Also, for a surfaced undated file `effectiveFolder(n)` is `null`; give the card the section folder for context. Find where `folderName` is computed in `cardNode` (`const folderName = isMain ? ref : effectiveFolder(n);`, ~line 4257) and change the non-main branch to fall back to the pile folder:

```ts
    const folderName = isMain ? ref : (effectiveFolder(n) ?? pile?.folder ?? null);
```

- [ ] **Step 5: Build a path→note map and apply the pile order in single-folder mode**

Just above the `const sections = newspaperMode` block (~line 4425), add a lookup over all notes (used to surface added files that `filteredNotes` excludes):

```ts
  const noteByPath = new Map(notes.map((n) => [n.path, n] as const));
```

Then, inside the `includeRefs.map((ref) => { ... })` body, replace the `noteCells` construction (the lines that currently read:

```ts
        const noteCells: SectionCell[] = sectionNotes.map((n) => ({
          key: keyFor(n), dataPath: n.path, node: cardNode(n, NOTE_CAP),
        }));
```

) with pile-aware logic:

```ts
        // Single-folder view = the "Notable Folder view". Apply File Piles:
        // surface session-added files at the top, drop closed ones, and pass
        // each card its close/add controls. Multi-folder/home newspaper is
        // unchanged (no pile controls, default dated order).
        let noteCells: SectionCell[];
        if (includeRefs.length === 1) {
          const front = pileFront.get(ref) ?? [];
          const hidden = pileHidden.get(ref) ?? new Set<string>();
          const datedPaths = sectionNotes.map((n) => n.path);
          const ordered = computePileOrder(datedPaths, front, hidden, mainNote?.path ?? null);
          noteCells = ordered
            .map((p) => noteByPath.get(p))
            .filter((n): n is LoadedNote => !!n)
            .map((n) => ({
              key: keyFor(n), dataPath: n.path, node: cardNode(n, NOTE_CAP, { folder: ref }),
            }));
        } else {
          noteCells = sectionNotes.map((n) => ({
            key: keyFor(n), dataPath: n.path, node: cardNode(n, NOTE_CAP),
          }));
        }
```

- [ ] **Step 6: Wire add-to-pile + rename/delete into the backside via Card**

Find the single `<Card ... />` render call inside `cardNode` and add three props so the Card (which hosts the backside) can pass them down. Add right after the `onAddToPile=` line from Step 4:

```ts
        onBrowserAddToPile={isMain ? (filename: string) => addToPileByName(ref, vaultDirRelFor(n), filename) : undefined}
        onBrowserRename={isMain ? (oldName: string, newName: string) => renameVaultFile(vaultDirRelFor(n), oldName, newName) : undefined}
        onBrowserDelete={isMain ? (name: string) => deleteVaultFile(vaultDirRelFor(n), name) : undefined}
```

Add this small helper just above `cardNode` (the backside operates on the folder dir = the main doc's parent dir):

```ts
  const vaultDirRelFor = (n: LoadedNote) => vaultDir(toVaultRel(n.path));
```

(`vaultDir` already imported/used in this file — see `folderRelForFlip` in Card; if not imported in CardGrid, it is available from `"../lib/vault"`; confirm and add to the existing vault import if missing.)

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: errors in `Card.tsx` only about unknown props `onClosePile` / `onAddToPile` / `onBrowser*` (those props are added in Task 3). CardGrid itself should have no errors. If CardGrid reports an error (e.g. `vaultDir` not imported), fix the import: add `vaultDir` to the existing `import { ... } from "../lib/vault";` line.

- [ ] **Step 8: Commit**

```bash
git add src/components/CardGrid.tsx
git commit -m "feat: File Piles session state + single-folder pile ordering"
```

---

### Task 3: Card pile controls (close + move-to-top) and backside prop pass-through

**Files:**
- Modify: `src/components/Card.tsx` (props interface; icon import; header buttons near fullscreen ~1144-1163; `<NotableFolderBackside>` render ~1175)

**Interfaces:**
- Consumes: `onClosePile?`, `onAddToPile?`, `onBrowserAddToPile?`, `onBrowserRename?`, `onBrowserDelete?` from Task 2.
- Produces: passes `onAddToPile`/`onRename`/`onDelete` into `NotableFolderBackside` (Task 4 consumes them).

- [ ] **Step 1: Add the icon import**

In the lucide import line (~line 53), add `ArrowUpToLine as ArrowUpToLineIcon` to the destructured set (keep alphabetical-ish; placement doesn't matter functionally):

```ts
import { Check, ChevronRight, Folder as FolderIcon, Link2, Trash2, X as XIcon, FolderOpen as FolderOpenIcon, Home as HomeIcon, List as ListIcon, LayoutGrid as LayoutGridIcon, AlignJustify as AlignJustifyIcon, Copy as CopyIcon, Maximize2 as Maximize2Icon, Minimize2 as Minimize2Icon, EyeOff as EyeOffIcon, Terminal as TerminalIcon, Star as StarIcon, CalendarDays as CalendarIcon, ArrowUpToLine as ArrowUpToLineIcon } from "lucide-react";
```

- [ ] **Step 2: Add the new props to the Card props interface**

Find the props type (the object after `onRemoveFromFilter?: () => void;`, ~line 172) and add:

```ts
  /** File Piles (session-only). Present only for non-main cards in the
   *  single-folder "Notable Folder view". onAddToPile moves this card to the
   *  top of the folder's stream; onClosePile hides it for the session. */
  onAddToPile?: () => void;
  onClosePile?: () => void;
  /** File browser (backside) row actions — present only on the NF Main Doc. */
  onBrowserAddToPile?: (filename: string) => void;
  onBrowserRename?: (oldName: string, newName: string) => Promise<void> | void;
  onBrowserDelete?: (name: string) => Promise<void> | void;
```

- [ ] **Step 3: Destructure the new props**

Find the destructuring of props (where `onRemoveFromFilter,` appears ~line 255) and add the five names:

```ts
    onAddToPile,
    onClosePile,
    onBrowserAddToPile,
    onBrowserRename,
    onBrowserDelete,
```

- [ ] **Step 4: Render the move-to-top and close controls**

Find the fullscreen button block and the existing dismiss X (~lines 1144-1163). Insert the move-to-top button immediately BEFORE the fullscreen `<button>`, and the close X immediately AFTER the existing `onRemoveFromFilter` block. Result:

```tsx
        {onAddToPile && (
          <button
            type="button"
            className="order-card-btn order-card-topile"
            onClick={onAddToPile}
            title="Move to top of pile"
            aria-label="Move to top of pile"
          >
            <ArrowUpToLineIcon size={14} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          className="order-card-btn order-card-fullscreen"
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {fullscreen ? <Minimize2Icon size={14} strokeWidth={2} /> : <Maximize2Icon size={14} strokeWidth={2} />}
        </button>
        {onRemoveFromFilter && !confirmingDelete && (
          <button
            type="button"
            className="order-card-btn order-card-dismiss"
            onClick={onRemoveFromFilter}
            title="Remove from filtered view"
            aria-label="Remove from filtered view"
          >
            <XIcon size={14} strokeWidth={2.4} />
          </button>
        )}
        {onClosePile && (
          <button
            type="button"
            className="order-card-btn order-card-dismiss"
            onClick={onClosePile}
            title="Close card"
            aria-label="Close card"
          >
            <XIcon size={14} strokeWidth={2.4} />
          </button>
        )}
```

(For a non-main note card `onRemoveFromFilter` is undefined, so only the `onClosePile` X renders, sitting right of fullscreen. For the Main Doc, `onClosePile` is undefined and only the existing X renders — unchanged.)

- [ ] **Step 5: Pass row-action callbacks into the backside**

Find the `<NotableFolderBackside` render (~line 1175) and add three props:

```tsx
        <NotableFolderBackside
          vaultRoot={vaultRootForFlip}
          folderRel={folderRelForFlip}
          folderName={folderName}
          onFlipBack={() => setFlipped(false)}
          onAddToPile={onBrowserAddToPile ? (filename) => { onBrowserAddToPile(filename); setFlipped(false); } : undefined}
          onRenameFile={onBrowserRename}
          onDeleteFile={onBrowserDelete}
        />
```

(Flipping back on add-to-pile shows the user the card landing on top of the pile.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: errors only in `NotableFolderBackside.tsx` about unknown props `onAddToPile`/`onRenameFile`/`onDeleteFile` (added in Task 4). `Card.tsx` and `CardGrid.tsx` clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/Card.tsx
git commit -m "feat: card move-to-top + close controls; pass browser row actions"
```

---

### Task 4: File browser (backside) per-row add-to-pile, rename, delete

**Files:**
- Modify: `src/components/NotableFolderBackside.tsx` (props; icon import; row rendering ~292-317; small inline rename state)

**Interfaces:**
- Consumes: `onAddToPile?`, `onRenameFile?`, `onDeleteFile?` from Task 3.

- [ ] **Step 1: Add icon imports**

Update the lucide import (line 18) to add the row-action icons:

```ts
import { ArrowDownAZ, Clock4, FolderOpen, FileText, FileImage, FileVideo, Folder as FolderIcon, File as FileIcon, ArrowUpToLine, Pencil, Trash2 } from "lucide-react";
```

- [ ] **Step 2: Add the props**

In the props object (after `onFlipBack: () => void;`), add:

```ts
  /** File Piles: surface this markdown file at the top of the folder's pile. */
  onAddToPile?: (filename: string) => void;
  /** Rename a file in this folder. Resolves after the on-disk rename + reload. */
  onRenameFile?: (oldName: string, newName: string) => Promise<void> | void;
  /** Delete a file in this folder. Resolves after the on-disk remove + reload. */
  onDeleteFile?: (name: string) => Promise<void> | void;
```

And destructure them in the component parameter list alongside `onFlipBack`:

```ts
  onFlipBack,
  onAddToPile,
  onRenameFile,
  onDeleteFile,
```

- [ ] **Step 3: Add inline-rename state**

Near the other `useState` calls (after `justImported`, ~line 76), add:

```ts
  // Inline rename: the row name being edited, and its working text.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
```

And a helper just before the return (near `revealFolder`):

```ts
  const isMd = (name: string) => /\.md$/i.test(name);

  const commitRename = useCallback(async (oldName: string) => {
    const next = renameText.trim();
    setRenaming(null);
    if (!next || next === oldName || !onRenameFile) return;
    // Preserve the .md extension if the user dropped it.
    const finalName = /\.md$/i.test(next) ? next : `${next}.md`;
    try { await onRenameFile(oldName, finalName); await reload(); }
    catch (e) { console.error("rename failed", e); }
  }, [renameText, onRenameFile, reload]);

  const doDelete = useCallback(async (name: string) => {
    if (!onDeleteFile) return;
    // The confirm prompt lives in CardGrid.deleteVaultFile (tauriConfirm,
    // cross-platform). If the user cancels there, the file simply remains and
    // the reload is a no-op.
    try { await onDeleteFile(name); await reload(); }
    catch (e) { console.error("delete failed", e); }
  }, [onDeleteFile, reload]);
```

- [ ] **Step 4: Add row action buttons + rename input**

In the row `<li>` render (~292-317), after the existing `<span className="nf-flip-row-mtime">` line and before the closing `</li>`, add an actions cluster. Wrap the name in a rename input when this row is being renamed. Replace the row body:

```tsx
              <li
                key={e.name}
                data-name={e.name}
                className={
                  "nf-flip-row" +
                  (e.isDir ? " is-dir" : "") +
                  (highlighted ? " is-just-imported" : "")
                }
                draggable={!e.isDir && renaming !== e.name}
                onDragStart={!e.isDir ? (ev) => onRowDragStart(ev, e.name) : undefined}
                onClick={renaming === e.name ? undefined : () => { void openFile(e.name); }}
                title={e.name}
              >
                <Icon size={13} strokeWidth={2} className="nf-flip-row-icon" />
                {renaming === e.name ? (
                  <input
                    className="nf-flip-row-rename"
                    autoFocus
                    value={renameText}
                    onChange={(ev) => setRenameText(ev.target.value)}
                    onClick={(ev) => ev.stopPropagation()}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") { ev.preventDefault(); void commitRename(e.name); }
                      else if (ev.key === "Escape") { ev.preventDefault(); setRenaming(null); }
                    }}
                    onBlur={() => void commitRename(e.name)}
                  />
                ) : (
                  <span className="nf-flip-row-name">{e.name}</span>
                )}
                <span className="nf-flip-row-meta">
                  {e.isDir ? "" : formatSize(e.size)}
                </span>
                <span className="nf-flip-row-mtime">{formatMtime(e.mtime)}</span>
                {!e.isDir && renaming !== e.name && (
                  <span className="nf-flip-row-actions">
                    {onAddToPile && isMd(e.name) && (
                      <button
                        type="button"
                        className="nf-flip-row-btn"
                        onClick={(ev) => { ev.stopPropagation(); onAddToPile(e.name); }}
                        title="Add to pile (top)"
                        aria-label="Add to pile"
                      >
                        <ArrowUpToLine size={13} strokeWidth={2} />
                      </button>
                    )}
                    {onRenameFile && (
                      <button
                        type="button"
                        className="nf-flip-row-btn"
                        onClick={(ev) => { ev.stopPropagation(); setRenameText(e.name); setRenaming(e.name); }}
                        title="Rename"
                        aria-label="Rename"
                      >
                        <Pencil size={13} strokeWidth={2} />
                      </button>
                    )}
                    {onDeleteFile && (
                      <button
                        type="button"
                        className="nf-flip-row-btn is-danger"
                        onClick={(ev) => { ev.stopPropagation(); void doDelete(e.name); }}
                        title="Delete"
                        aria-label="Delete"
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
                    )}
                  </span>
                )}
              </li>
```

- [ ] **Step 5: Update the row grid and add styles**

Styles live in `src/styles.css`. `.nf-flip-row` is a CSS grid with **four** columns (`grid-template-columns: 18px 1fr auto auto;` at ~line 5814). Adding the actions cell needs a **fifth** column or the row mis-aligns. First widen the grid — find:

```css
.nf-flip-row {
  display: grid;
  grid-template-columns: 18px 1fr auto auto;
```

and change the columns line to:

```css
  grid-template-columns: 18px 1fr auto auto auto;
```

Then append these rules right after the existing `.nf-flip-row-mtime { ... }` rule (use the real theme vars already in this file — `--ink`, `--ink-faint`, `--paper`, `--bg-elev`):

```css
.nf-flip-row-actions { display: inline-flex; gap: 2px; opacity: 0; transition: opacity 0.12s; }
.nf-flip-row:hover .nf-flip-row-actions { opacity: 1; }
.nf-flip-row-btn { display: inline-flex; align-items: center; justify-content: center; padding: 2px; border: none; background: transparent; color: var(--ink-faint); cursor: pointer; border-radius: 4px; }
.nf-flip-row-btn:hover { background: var(--bg-elev); color: var(--ink); }
.nf-flip-row-btn.is-danger:hover { color: #d9534f; }
.nf-flip-row-rename { font: inherit; padding: 1px 4px; border: 1px solid var(--ink-faint); border-radius: 4px; background: var(--paper); color: var(--ink); }
```

(Touch devices have no hover; the actions are always visible there because `opacity` only animates on hover-capable pointers — acceptable, and the `:hover` reveal keeps the desktop list clean.)

- [ ] **Step 6: Type-check and build**

Run: `npx tsc --noEmit` → clean (no output).
Run: `pnpm build` → ends with `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add src/components/NotableFolderBackside.tsx src/styles.css
git commit -m "feat: file browser per-row add-to-pile, rename, delete"
```

---

### Task 5: Manual smoke test + full verification

**Files:** none (verification only).

- [ ] **Step 1: Re-run the unit test**

Run: `npx tsx src/lib/file-piles.test.ts`
Expected: `ALL CHECKS PASS`.

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit` (clean) and `pnpm build` (`✓ built`).

- [ ] **Step 3: Manual smoke (desktop dev: `pnpm tauri dev`)**

Verify, in a single Notable Folder view (filter to exactly one folder):
- Flip a folder's Main Doc to the file browser; an undated reference `.md` shows an add-to-pile (↥), rename (✎), and delete (🗑) on hover.
- Click add-to-pile → the card flips to front and the file appears as the **first** card after the Main Doc.
- On that card, the **X** (right of fullscreen) closes it → it disappears from the stream.
- On a dated note card, click move-to-top (↥) → it jumps to the top of the stream.
- Rename a file in the browser → the row updates and the front reflects it; Delete (with confirm) removes it.
- Switch to the home/multi-folder view → no pile controls, default order (unchanged behavior).
- Restart the app → pile arrangement resets (Main Doc + dated notes only). Confirms session-only.

- [ ] **Step 4: Commit (if any style tweaks were needed during smoke)**

```bash
git add -A
git commit -m "chore: File Piles smoke-test polish"
```

---

## Notes for the implementer
- `reloadNotes`, `notesRef`, `vaultFs`, `toVaultRel`, `vaultDir`, `effectiveFolder`, `isMainDoc`, `SectionCell`, `NOTE_CAP` all already exist in the named files — reuse them; do not redefine.
- Do not add persistence. If you find yourself writing to a file for pile membership, stop — that's out of scope.
- Keep the existing Main Doc X (`onRemoveFromFilter`) working exactly as before.
