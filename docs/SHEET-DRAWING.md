# Sheet & Drawing views

A note card can **flip** between three editors, chosen by two icons next to the
terminal icon (spreadsheet, drawing) and persisted per note:

| File                     | View      | Editor                          |
| ------------------------ | --------- | ------------------------------- |
| `<Name>.md`              | `note`    | Milkdown (the normal card)      |
| `<Name>.sheet.html`      | `sheet`   | `react-spreadsheet`             |
| `<Name>.excalidraw`      | `drawing` | Excalidraw                      |

## Model

- The active view lives in the note's YAML `view: [note|sheet|drawing]`
  frontmatter and is restored on load. Clicking an icon switches + persists it;
  clicking the active icon flips back to the note.
- The sidecar file is created next to the `.md` (same base name) on first flip.
- Sidecars are **not** walked as their own cards — the Rust vault walk only
  loads `.md/.txt/.yml/.mw`, so a sidecar always stays attached to its note.
- Only a plain markdown note can flip; spacetime / yaml / txt raw surfaces stay
  in their own editor.

Code: `src/lib/note-view.ts` (types, sidecar paths, sheet HTML (de)serializer),
`src/components/SheetSurface.tsx`, `src/components/DrawingSurface.tsx`, wired in
`src/components/Card.tsx`. The heavy editors are `React.lazy`-loaded so the
normal note path never pays for them.

## Card view vs fullscreen

The card is a **minimal preview**; the full editor is fullscreen.

- **Sheet, card view:** no row/column headers, no palette dock, editing locked,
  rows capped (a subtle chevron over a bottom fade opens fullscreen). **Sheet,
  fullscreen:** headers, the palette dock, editing, structural edits.
- **Drawing, card view:** Excalidraw chrome hidden, view-only, centered on the
  content. **Drawing, fullscreen:** the full Excalidraw editor. The canvas
  re-fits to content on every fullscreen toggle.

## Spreadsheet specifics

**Overflow (text continues past a cell).** Fill colors render on the `<td>` as a
background layer. Each cell's value renders in an absolutely-positioned span
_above_ all colors, with a per-column z-index (later columns paint over earlier
overflow). A cell **with content** gives its span an opaque background (its fill
color, else the surface color) so it clips overflow from the left — "stops at
the first cell with content". An **empty** cell (even a colored one) keeps a
transparent span, so overflow text passes _over_ its color rather than being
overwritten. Text is therefore always foreground.

**Editing.** A custom auto-growing editor (via the input `size` attribute) with
an opaque background lets the edit box itself spill past the cell while typing,
painting over the view span so there's no doubled text.

**No render loop.** `react-spreadsheet` fires `onChange` whenever its `data`
prop changes — including when we change it ourselves (padding on fullscreen, a
toolbar edit). Every commit dedupes against the last serialized form and stamps
a guard ref, so an echo whose content is unchanged is ignored (otherwise:
`onChange → setState → new data → onChange …` → blank grid).

**Colors.** Seven palette fills plus a custom color picker. Palette fills are
**adaptive** — a hue washed over the current theme's surface color — so the cell
text (`--ink`) contrasts in every Order theme (including the retro ones). Custom
colors get a luminance-picked near-black/near-white text color.

**Formulas** work out of the box (`react-spreadsheet` uses `fast-formula-parser`
for any value starting with `=`).

**Structure.** Right-click a row number or column letter for insert / delete.

**Storage.** The sheet is a plain HTML `<table>`; cells carry `data-bg` (palette
token `t:<key>` or a raw color) and `data-collapse`. Trailing empty rows/columns
are trimmed on save.

## Drawing specifics

Standard Excalidraw JSON (`serializeAsJSON` / `restore`), theme-synced to Order
(its many themes map to Excalidraw's light/dark). Persist is debounced and
skips scene-identical echoes.

**Follow-up:** Excalidraw loads fonts from its CDN by default; fully-offline
drawing needs `EXCALIDRAW_ASSET_PATH` pointed at bundled assets. Renaming a note
does not yet carry its sidecars along.
