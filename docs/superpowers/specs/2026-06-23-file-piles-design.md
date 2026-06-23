# File Piles — Design

**Goal:** Let the user surface any markdown file (including undated reference docs) as a card at the top of a Notable Folder's note stream, reorder cards, and close cards — as a session-only display action. Also add rename/delete to the folder's file browser.

**Status:** Approved (session-only; persistence and custom layouts explicitly deferred — YAGNI).

---

## Concept

A folder's pile is the stream of cards around its Main Document. Today that stream is computed: Main Doc first, then dated notes in date order. Undated files in the folder don't appear at all.

"Add to pile" is a **pure display action** — no `pinned` marker, no stored list. It just inserts a file as the first card in the folder's stream for the current session. Closing a card (X) hides it for the session. Everything resets on app restart.

## Data model (session-only, in `CardGrid`)

Two per-folder structures held in React state, keyed by the folder ref (the canonical Notable Folder name). No disk writes.

```ts
const [pileFront, setPileFront]   = useState<Map<string, string[]>>(new Map());   // folder → ordered paths surfaced/moved to front
const [pileHidden, setPileHidden] = useState<Map<string, Set<string>>>(new Map()); // folder → paths closed this session
```

- **Add to pile / move to front:** prepend (or move) the file's `path` in `pileFront[folder]`; also clear it from `pileHidden[folder]`.
- **Close (X):** add the card's `path` to `pileHidden[folder]`; remove from `pileFront[folder]` if present.

## Render order (single-folder pile mode only)

A pure helper governs the order so it can be unit-tested:

```ts
// Returns the ordered list of note paths to render as cards for one folder.
function computePileOrder(
  mainDocPath: string | null,
  datedNotePaths: string[],   // already in the folder's default (date desc) order
  front: string[],            // session: moved/added to top, in order
  hidden: Set<string>,        // session: closed cards
): string[]
```

Order = `mainDoc` (always first, never hidden) → `front` items (in order) → remaining `datedNotePaths` not already in `front` → minus any path in `hidden`. Deduped, so a file that is both a dated note and in `front` appears once, in its `front` position.

Added undated files are looked up in the loaded `notes` array by `path` and rendered as normal Cards (body lazy-loads on mount, like any card). The surfaced card is passed the current folder as its `folderName` for context.

## Components touched

### `CardGrid.tsx`
- Add `pileFront` / `pileHidden` state and handlers `addToPile(folder, path)` / `closeFromPile(folder, path)`.
- Add the pure `computePileOrder` helper; apply it when building the single-folder pile's card list.
- Surface `front` files (which `effectiveFolder` would exclude) by path lookup in `notes`.
- Pass `onAddToPile` / `onClosePile` to note Cards; pass `onAddToPile` + rename/delete callbacks to `NotableFolderBackside`.

### `Card.tsx`
- For **non-main cards in single-folder pile view only** (not the Main Doc, not calendar):
  - **X** (close) to the right of the fullscreen button → `onClosePile`. Rendered in the same slot as the existing `order-card-dismiss` X; distinct handler so it never collides with the Main Doc's existing "remove folder from filtered view" X.
  - **Add-to-pile icon** (same icon as the browser row) → `onAddToPile` (move this card to front).
- The Main Document is unchanged: it keeps its existing X (close the folder page) and gets no add-to-pile icon.

### `NotableFolderBackside.tsx` (the file browser)
- Per **markdown-file** row, add three actions:
  - **Add to pile** icon → calls back into CardGrid to add this file to the folder's pile, then flips the card to the front so the user sees it land on top.
  - **Rename** → inline edit of the filename → `vaultFs.rename` → reload the listing and the app's notes.
  - **Delete** → confirm → `vaultFs.remove` → reload.
- Non-markdown rows (images, etc.) keep their current open/drag behavior; no add-to-pile.

## Behavior details
- Main Document: always first, never hidden, no add-to-pile icon.
- X on a dated note hides it for the session; it returns on restart or if re-added from the browser.
- Add-to-pile is markdown-only.
- Rename/delete are the only operations that write to disk; pile membership never does.

## Testing
- Unit-test `computePileOrder`: default order; front prepend and reorder; hidden removal; dedup (file both dated and in front); main-doc-always-first-and-never-hidden.
- Manual: add an undated reference doc → top card; X it → gone; bump a dated note → jumps to top; rename/delete in browser → reflected; restart → arrangement resets.

## Out of scope (deferred)
- Persistence across restarts.
- Custom layouts.
- Cross-folder piles (a file is only ever added to the pile of the folder it lives in).
