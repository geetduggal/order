// Note "view" model: a .md note can be flipped between its markdown editor
// and two sidecar-backed editors — a spreadsheet (.sheet.html) and an
// Excalidraw drawing (.excalidraw). The active view is persisted in the
// note's YAML `view:` field; the sidecar files sit next to the .md with the
// same base name. Sidecars are NOT walked as their own cards (the Rust vault
// walk only loads .md/.txt/.yml/.mw), so they stay attached to their note.

import type { Frontmatter } from "./frontmatter";

export type NoteView = "note" | "sheet" | "drawing";

export function parseView(fm: Frontmatter): NoteView {
  const v = fm.view;
  return v === "sheet" || v === "drawing" ? v : "note";
}

/** Sidecar path for a note's spreadsheet: `<dir>/<Base>.sheet.html`. */
export function sheetSidecarPath(notePath: string): string {
  return notePath.replace(/\.md$/i, ".sheet.html");
}

/** Sidecar path for a note's drawing: `<dir>/<Base>.excalidraw`. */
export function drawingSidecarPath(notePath: string): string {
  return notePath.replace(/\.md$/i, ".excalidraw");
}

// ---------------- Spreadsheet model + HTML (de)serialization ----------------

export interface SheetCell {
  /** Raw cell text; a leading "=" makes it a formula (evaluated by the grid). */
  value: string;
  /** Background: a palette token (`t:<key>`) resolved per theme, or a raw
   *  CSS color (e.g. "#ffcc00") for a custom pick. Absent = no background
   *  layer, so earlier-column overflow text passes through. */
  bg?: string;
  /** When true the cell clips its own text instead of letting it continue
   *  past — the toolbar "collapse" toggle. */
  collapse?: boolean;
}

/** Palette of background tokens. Rendered via CSS vars (`--sheet-<key>`) that
 *  are themed in styles.css, so the same token reads well in every Order
 *  theme. Custom colors bypass this and store a raw hex. */
export const SHEET_PALETTE: { key: string; label: string }[] = [
  { key: "rose", label: "Rose" },
  { key: "amber", label: "Amber" },
  { key: "green", label: "Green" },
  { key: "teal", label: "Teal" },
  { key: "blue", label: "Blue" },
  { key: "violet", label: "Violet" },
  { key: "slate", label: "Slate" },
];

/** Resolve a stored bg value to a CSS color for rendering. Palette tokens map
 *  to a theme CSS var; raw colors pass through. */
export function resolveSheetBg(bg: string | undefined): string | undefined {
  if (!bg) return undefined;
  if (bg.startsWith("t:")) return `var(--sheet-${bg.slice(2)})`;
  return bg;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** An empty rows×cols matrix. */
export function emptySheet(rows: number, cols: number): SheetCell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ value: "" }) as SheetCell),
  );
}

/** Serialize the grid to a self-contained HTML table. Trailing all-empty rows
 *  and columns are trimmed so the file tracks real content. A cell is "empty"
 *  when it has no value, no background, and no collapse flag. */
export function serializeSheet(data: SheetCell[][]): string {
  const isEmpty = (c: SheetCell | undefined) => !c || (!c.value && !c.bg && !c.collapse);
  let maxRow = 0;
  let maxCol = 0;
  data.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!isEmpty(cell)) {
        maxRow = Math.max(maxRow, r + 1);
        maxCol = Math.max(maxCol, c + 1);
      }
    }),
  );
  const rows: string[] = [];
  for (let r = 0; r < maxRow; r++) {
    const cells: string[] = [];
    for (let c = 0; c < maxCol; c++) {
      const cell = data[r]?.[c];
      const attrs: string[] = [];
      if (cell?.bg) attrs.push(`data-bg="${escapeHtml(cell.bg)}"`);
      if (cell?.collapse) attrs.push(`data-collapse="1"`);
      const a = attrs.length ? " " + attrs.join(" ") : "";
      cells.push(`<td${a}>${escapeHtml(cell?.value ?? "")}</td>`);
    }
    rows.push(`  <tr>${cells.join("")}</tr>`);
  }
  return `<table class="order-sheet">\n${rows.join("\n")}\n</table>\n`;
}

/** Parse a `.sheet.html` table back into a matrix. Tolerant of hand edits and
 *  of an empty/absent file (returns a small blank grid). */
export function parseSheet(html: string): SheetCell[][] {
  const out: SheetCell[][] = [];
  const trMatches = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const tr of trMatches) {
    const row: SheetCell[] = [];
    const tdMatches = tr.match(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi) ?? [];
    for (const td of tdMatches) {
      const m = /<td\b([^>]*)>([\s\S]*?)<\/td>/i.exec(td);
      const attrs = m?.[1] ?? "";
      const inner = m?.[2] ?? "";
      const bg = /data-bg="([^"]*)"/i.exec(attrs)?.[1];
      const collapse = /data-collapse="1"/i.test(attrs);
      row.push({
        value: unescapeHtml(inner),
        ...(bg ? { bg: unescapeHtml(bg) } : {}),
        ...(collapse ? { collapse: true } : {}),
      });
    }
    out.push(row);
  }
  return out;
}

const UNESC: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot);/g, (m) => UNESC[m]);

/** Grow a matrix to at least rows×cols (used to fill space, e.g. fullscreen),
 *  never shrinking existing content. */
export function padSheet(data: SheetCell[][], rows: number, cols: number): SheetCell[][] {
  const r = Math.max(rows, data.length);
  const c = Math.max(cols, data.reduce((m, row) => Math.max(m, row.length), 0));
  return Array.from({ length: r }, (_, i) =>
    Array.from({ length: c }, (_, j) => data[i]?.[j] ?? ({ value: "" } as SheetCell)),
  );
}

/** A rectangular cell selection (inclusive), for cell-drag moves. */
export interface SheetRect { r0: number; c0: number; r1: number; c1: number }

/** Move the source rectangle `sel` by (dr, dc). Cells the block lands on that
 *  are NOT part of the source are displaced into the slots the block vacated —
 *  a "somewhat intelligent" swap so nothing is silently overwritten. Grows the
 *  matrix as needed; never shrinks. */
export function moveBlock(data: SheetCell[][], sel: SheetRect, dr: number, dc: number): SheetCell[][] {
  const rows = Math.max(data.length, sel.r1 + dr + 1);
  const cols = Math.max(data.reduce((m, r) => Math.max(m, r.length), 0), sel.c1 + dc + 1);
  const out: SheetCell[][] = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ ...(data[r]?.[c] ?? { value: "" }) })),
  );
  const inSrc = (r: number, c: number) => r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
  const nonEmpty = (cell: SheetCell) => !!(cell.value || cell.bg || cell.collapse);
  const block: { r: number; c: number; cell: SheetCell }[] = [];
  for (let r = sel.r0; r <= sel.r1; r++)
    for (let c = sel.c0; c <= sel.c1; c++) { block.push({ r, c, cell: { ...out[r][c] } }); out[r][c] = { value: "" }; }
  const displaced: SheetCell[] = [];
  for (const { r, c } of block) {
    const tr = r + dr, tc = c + dc;
    if (!inSrc(tr, tc) && nonEmpty(out[tr][tc])) displaced.push({ ...out[tr][tc] });
  }
  for (const { r, c, cell } of block) out[r + dr][c + dc] = cell;
  let di = 0;
  for (const { r, c } of block) {
    if (di >= displaced.length) break;
    if (!nonEmpty(out[r][c])) out[r][c] = displaced[di++];
  }
  return out;
}
