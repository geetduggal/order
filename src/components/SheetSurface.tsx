// Spreadsheet surface: a note flipped to `view: sheet`, backed by react-
// spreadsheet and persisted to the `<Base>.sheet.html` sidecar.
//
// Overflow model (per spec): text continues past its cell like a real
// spreadsheet. Each column's `<td>` gets `position: relative` and a z-index
// one higher than the column to its left, so a later column that has an
// opaque background paints over the overflow from earlier columns; an
// uncolored (transparent) cell lets the text pass through. Overflow is
// suppressed while a cell is being edited (onModeChange) so the editor input
// doesn't render on top of the overflowing viewer text. "Collapse" clips a
// cell's own text instead of letting it continue.
//
// Formulas: react-spreadsheet evaluates any cell whose value starts with "="
// (fast-formula-parser), so basic `=A1+B1`, `=SUM(...)` etc. work for free.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Spreadsheet, { type CellBase, type Matrix } from "react-spreadsheet";
import { Palette as PaletteIcon, Scissors as ScissorsIcon, Eraser as EraserIcon, ChevronsDown as ChevronsDownIcon } from "lucide-react";
import {
  SHEET_PALETTE,
  emptySheet,
  moveBlock,
  padSheet,
  parseSheet,
  serializeSheet,
  type SheetCell,
} from "../lib/note-view";

type RSCell = CellBase<string> & { bg?: string; collapse?: boolean };
type Rect = { r0: number; c0: number; r1: number; c1: number };

interface SheetSurfaceProps {
  initial: string;
  onChange: (html: string) => void;
  readOnly?: boolean;
  /** Card view: hide the row/column headers and the palette dock, cap the
   *  visible rows, and lock editing — a clean preview; the full editor is in
   *  fullscreen. */
  minimal?: boolean;
  /** Called by the preview's "open fullscreen" enticer. */
  onExpand?: () => void;
  minRows?: number;
  minCols?: number;
}

function bgClass(bg: string): string {
  if (bg.startsWith("t:")) return `sheet-bg-${bg.slice(2)}`;
  return `sheet-bg-c${bg.replace(/[^a-z0-9]/gi, "")}`;
}

/** Column index → spreadsheet letter (0→A, 26→AA). */
function colLabel(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

function toRS(data: SheetCell[][], locked: boolean): Matrix<RSCell> {
  return data.map((row, r) =>
    row.map((cell, c): RSCell => {
      // The TD only carries the fill COLOR (a background layer that stays
      // BELOW all text). "Stops at content" is handled by the text span
      // (see CellViewer), which sits above every color so overflow text is
      // never overwritten by a later cell's color.
      const bgCls = cell.bg ? bgClass(cell.bg) : "";
      return {
        value: cell.value,
        ...(locked ? { readOnly: true } : {}),
        ...(cell.bg ? { bg: cell.bg } : {}),
        ...(cell.collapse ? { collapse: true } : {}),
        className:
          `sheet-col-${c} sheet-row-${r}` +
          (bgCls ? ` ${bgCls}` : "") +
          (cell.collapse ? " sheet-collapse" : ""),
      };
    }),
  );
}


/** Resolve a stored bg (palette token or raw color) to a CSS color. */
function resolveBg(bg: string | undefined): string | undefined {
  if (!bg) return undefined;
  return bg.startsWith("t:") ? `var(--sheet-${bg.slice(2)})` : bg;
}

// Card view shows at most this many rows — a preview that entices fullscreen.
const PREVIEW_ROWS = 8;

function fromRS(m: Matrix<RSCell>): SheetCell[][] {
  return m.map((row) =>
    (row ?? []).map((cell): SheetCell => ({
      value: cell?.value ?? "",
      ...(cell?.bg ? { bg: cell.bg } : {}),
      ...(cell?.collapse ? { collapse: true } : {}),
    })),
  );
}

/** A readable text color for a CUSTOM background (palette tints already pair
 *  with the theme's ink, so they return undefined → inherit). Picks near-black
 *  or near-white by the background's perceived luminance so custom colors
 *  stay legible in the spirit of the theme. */
function customTextColor(bg: string | undefined): string | undefined {
  if (!bg || bg.startsWith("t:") || !bg.startsWith("#")) return undefined;
  const hex = bg.slice(1);
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (full.length < 6) return undefined;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#14171a" : "#f4f2ea";
}

export function SheetSurface({ initial, onChange, readOnly, minimal, onExpand, minRows = 12, minCols = 8 }: SheetSurfaceProps) {
  const [sheet, setSheet] = useState<SheetCell[][]>(() => {
    const parsed = initial.trim() ? parseSheet(initial) : [];
    return padSheet(parsed, minRows, minCols);
  });
  useEffect(() => {
    setSheet((prev) => {
      const cols = prev.reduce((m, r) => Math.max(m, r.length), 0);
      // Only grow (new array) when actually needed — returning the same ref
      // avoids a redundant render + a spurious react-spreadsheet onChange echo.
      return prev.length >= minRows && cols >= minCols ? prev : padSheet(prev, minRows, minCols);
    });
  }, [minRows, minCols]);

  // Last known selection rectangle, kept in a ref so a toolbar click (which
  // blurs the grid) still applies to what was selected. onActivate covers a
  // single-cell click; onSelect covers a dragged range.
  const selRef = useRef<Rect | null>(null);
  const [editing, setEditing] = useState(false);
  // Optional press-and-drag to move a cell / block (see the "Cell drag" toggle).
  const [cellDrag, setCellDrag] = useState(false);
  const [dragOver, setDragOver] = useState<{ r: number; c: number } | null>(null);
  const dragRef = useRef<{ sel: Rect; startX: number; startY: number; moved: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Row/column header right-click menu (insert / delete).
  const [menu, setMenu] = useState<{ axis: "row" | "col"; index: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  // Card view shows only the first PREVIEW_ROWS and locks editing; the last
  // content row drives the "N rows — open fullscreen" enticer.
  const contentRows = useMemo(() => {
    let n = 0;
    sheet.forEach((row, r) => { if (row.some((c) => c.value != null && String(c.value).trim() !== "")) n = r + 1; });
    return n;
  }, [sheet]);
  const displaySheet = useMemo(() => (minimal ? sheet.slice(0, PREVIEW_ROWS) : sheet), [sheet, minimal]);
  const hasMore = !!minimal && contentRows > PREVIEW_ROWS;

  // Card view stays editable (type values inline) — only a published/read-only
  // card locks cells. Formatting + structural edits are the fullscreen extras.
  const rsData = useMemo(() => toRS(displaySheet, !!readOnly), [displaySheet, readOnly]);
  const rsDataRef = useRef(rsData);
  rsDataRef.current = rsData;
  // Logical data for the viewer (reads bg for contrast); a ref so the memoized
  // DataViewer stays stable (no per-render remount of every cell).
  const dataRef = useRef(sheet);
  dataRef.current = sheet;
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  // Custom cell viewer: renders the (evaluated) value in an ABSOLUTELY
  // positioned span so it escapes the cell box and continues past to the
  // right like a real spreadsheet — column z-index (set per column below)
  // makes later opaque cells paint over the overflow. Text color is forced
  // readable on custom backgrounds.
  const CellViewer = useMemo(() => {
    const V = ({ row, column, cell, evaluatedCell }: { row: number; column: number; cell?: RSCell; evaluatedCell?: RSCell }) => {
      const logical = dataRef.current[row]?.[column];
      const bg = logical?.bg;
      const hasContent = logical?.value != null && String(logical.value).trim() !== "";
      // Prefer the evaluated value so `=A1+B1` shows its result, not the formula.
      const v = (evaluatedCell ?? cell)?.value;
      // Column z-index puts later text above earlier overflow, and above ALL
      // colors (colors live on the TD, below the span). A cell WITH content
      // carries an opaque background (its color, else the surface) so it paints
      // over overflow from its left — "stops at content". An empty cell (even a
      // colored one) has a transparent span, so overflow passes over its color.
      const style: React.CSSProperties = { zIndex: column + 1 };
      if (hasContent) style.background = resolveBg(bg) ?? "var(--sheet-surface-bg)";
      const color = customTextColor(bg);
      if (color) style.color = color;
      return (
        <span className="order-sheet-val" style={style}>
          {v == null ? "" : String(v)}
        </span>
      );
    };
    return V;
  }, []);

  // Custom editor: an auto-growing input (via the `size` attribute) with an
  // opaque surface background, so the edit box itself spills past the cell
  // like a real spreadsheet WHILE typing — and paints over the view span
  // underneath so there's no doubled text. (react-spreadsheet's default
  // editor is a fixed cell-width input that just scrolls internally.)
  const CellEditor = useMemo(() => {
    const E = ({ cell, onChange }: { cell?: RSCell; onChange: (c: RSCell) => void }) => {
      const value = String(cell?.value ?? "");
      return (
        <input
          className="order-sheet-editor"
          autoFocus
          value={value}
          size={Math.max(value.length + 1, 2)}
          onChange={(e) => onChange({ ...(cell ?? { value: "" }), value: e.target.value })}
        />
      );
    };
    return E;
  }, []);

  // Header indicators: keep react-spreadsheet's click-to-select-axis behavior,
  // and add a right-click menu for insert / delete. Stable across renders
  // (setMenu is stable) so the grid doesn't remount headers each render.
  const ColumnIndicator = useMemo(() => {
    const C = ({ column, label, selected, onSelect }: { column: number; label?: React.ReactNode; selected: boolean; onSelect: (c: number, extend: boolean) => void }) => (
      <th
        className={"Spreadsheet__header" + (selected ? " Spreadsheet__header--selected" : "")}
        onClick={(e) => onSelect(column, e.shiftKey)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ axis: "col", index: column, x: e.clientX, y: e.clientY }); }}
      >
        {label ?? colLabel(column)}
      </th>
    );
    return C;
  }, []);
  const RowIndicator = useMemo(() => {
    const R = ({ row, label, selected, onSelect }: { row: number; label?: React.ReactNode; selected: boolean; onSelect: (r: number, extend: boolean) => void }) => (
      <th
        className={"Spreadsheet__header" + (selected ? " Spreadsheet__header--selected" : "")}
        onClick={(e) => onSelect(row, e.shiftKey)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ axis: "row", index: row, x: e.clientX, y: e.clientY }); }}
      >
        {label ?? row + 1}
      </th>
    );
    return R;
  }, []);

  // Serialized form of what's currently committed. react-spreadsheet fires
  // onChange whenever its `data` prop changes — INCLUDING when we change it
  // ourselves (padding on fullscreen, a toolbar edit). Without this guard,
  // that echo would call setSheet again → new data ref → onChange → an
  // infinite loop that blanks the grid. Every commit updates this ref, and an
  // onChange whose serialized content already matches is ignored.
  const lastHtmlRef = useRef<string | null>(null);
  if (lastHtmlRef.current === null) lastHtmlRef.current = serializeSheet(sheet);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistHtml = useCallback((html: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onChange(html), 500);
  }, [onChange]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  /** Commit new sheet data: dedupe against the last serialized form, stamp the
   *  guard ref, update state, and schedule a save. */
  const commit = useCallback((next: SheetCell[][]) => {
    const html = serializeSheet(next);
    if (html === lastHtmlRef.current) return;
    lastHtmlRef.current = html;
    setSheet(next);
    persistHtml(html);
  }, [persistHtml]);

  const handleRSChange = useCallback((m: Matrix<RSCell>) => {
    const edited = fromRS(m);
    // Card view renders only the first PREVIEW_ROWS — merge edits back over the
    // hidden rows so typing in the preview never truncates the sheet.
    const next = minimal ? [...edited, ...sheetRef.current.slice(edited.length)] : edited;
    commit(padSheet(next, minRows, minCols));
  }, [commit, minimal, minRows, minCols]);

  const handleActivate = useCallback((pt: { row: number; column: number }) => {
    selRef.current = { r0: pt.row, c0: pt.column, r1: pt.row, c1: pt.column };
  }, []);
  const handleSelect = useCallback((sel: { toRange: (d: Matrix<RSCell>) => { start: { row: number; column: number }; end: { row: number; column: number } } | null }) => {
    const pr = sel.toRange(rsDataRef.current);
    if (!pr) return;
    selRef.current = {
      r0: Math.min(pr.start.row, pr.end.row),
      c0: Math.min(pr.start.column, pr.end.column),
      r1: Math.max(pr.start.row, pr.end.row),
      c1: Math.max(pr.start.column, pr.end.column),
    };
  }, []);

  const mutateSelection = useCallback((mut: (cell: SheetCell) => SheetCell) => {
    const sel = selRef.current;
    if (!sel || readOnly) return;
    const next = padSheet(sheetRef.current, sel.r1 + 1, sel.c1 + 1).map((row) => row.slice());
    for (let r = sel.r0; r <= sel.r1; r++)
      for (let c = sel.c0; c <= sel.c1; c++) next[r][c] = mut({ ...next[r][c] });
    commit(next);
  }, [readOnly, commit]);

  const setBg = useCallback((bg: string | undefined) => {
    mutateSelection((cell) => {
      if (bg) return { ...cell, bg };
      const { bg: _drop, ...rest } = cell;
      return rest;
    });
  }, [mutateSelection]);

  const toggleCollapse = useCallback(() => {
    const sel = selRef.current;
    let anyOpen = false;
    if (sel) {
      for (let r = sel.r0; r <= sel.r1 && !anyOpen; r++)
        for (let c = sel.c0; c <= sel.c1 && !anyOpen; c++)
          if (!sheet[r]?.[c]?.collapse) anyOpen = true;
    }
    mutateSelection((cell) => {
      if (anyOpen) return { ...cell, collapse: true };
      const { collapse: _d, ...rest } = cell;
      return rest;
    });
  }, [mutateSelection, sheet]);

  // Row / column structural edits, driven by the header right-click menu.
  const blankRow = (cols: number): SheetCell[] => Array.from({ length: cols }, () => ({ value: "" }));
  const rowOps = useCallback((i: number, kind: "delete" | "above" | "below") => {
    if (readOnly) return;
    const prev = sheetRef.current;
    const cols = prev.reduce((m, r) => Math.max(m, r.length), 1);
    const next = kind === "delete"
      ? prev.filter((_, r) => r !== i)
      : [...prev.slice(0, kind === "above" ? i : i + 1), blankRow(cols), ...prev.slice(kind === "above" ? i : i + 1)];
    commit(padSheet(next, minRows, minCols));
  }, [readOnly, commit, minRows, minCols]);
  // ---- Cell drag (press-and-drag a cell / block to a new location) ----
  const cellAt = useCallback((x: number, y: number): { r: number; c: number } | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(".Spreadsheet__cell");
    if (!el) return null;
    const rm = /sheet-row-(\d+)/.exec(el.className);
    const cm = /sheet-col-(\d+)/.exec(el.className);
    return rm && cm ? { r: +rm[1], c: +cm[1] } : null;
  }, []);
  const onDragPointerDown = useCallback((e: React.PointerEvent) => {
    if (!cellDrag || readOnly || e.button !== 0) return;
    const start = cellAt(e.clientX, e.clientY);
    const sel = selRef.current;
    if (!start || !sel) return;
    // Preempt only when the press lands inside the current selection — that's a
    // drag of the block; a press elsewhere still selects normally.
    if (start.r < sel.r0 || start.r > sel.r1 || start.c < sel.c0 || start.c > sel.c1) return;
    e.stopPropagation();
    dragRef.current = { sel, startX: e.clientX, startY: e.clientY, moved: false };
    scrollRef.current?.setPointerCapture(e.pointerId);
  }, [cellDrag, readOnly, cellAt]);
  const onDragPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    d.moved = true;
    setDragOver(cellAt(e.clientX, e.clientY));
  }, [cellAt]);
  const onDragPointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragOver(null);
    if (!d || !d.moved) return;
    const t = cellAt(e.clientX, e.clientY);
    if (!t) return;
    const dr = t.r - d.sel.r0, dc = t.c - d.sel.c0;
    if (dr === 0 && dc === 0) return;
    commit(padSheet(moveBlock(sheetRef.current, d.sel, dr, dc), minRows, minCols));
    selRef.current = { r0: d.sel.r0 + dr, c0: d.sel.c0 + dc, r1: d.sel.r1 + dr, c1: d.sel.c1 + dc };
  }, [cellAt, commit, minRows, minCols]);

  const colOps = useCallback((j: number, kind: "delete" | "left" | "right") => {
    if (readOnly) return;
    const next = sheetRef.current.map((row) => {
      if (kind === "delete") return row.filter((_, c) => c !== j);
      const at = kind === "left" ? j : j + 1;
      return [...row.slice(0, at), { value: "" } as SheetCell, ...row.slice(at)];
    });
    commit(padSheet(next, minRows, minCols));
  }, [readOnly, commit, minRows, minCols]);

  // Per-column z-index (paint order) + one rule per in-use background color.
  const dynamicCss = useMemo(() => {
    const cols = sheet.reduce((m, row) => Math.max(m, row.length), 0);
    const rules: string[] = [];
    for (let c = 0; c < cols; c++) {
      rules.push(`.order-sheet-surface .sheet-col-${c}{position:relative;}`);
    }
    const seen = new Set<string>();
    for (const row of sheet) {
      for (const cell of row) {
        if (!cell.bg || seen.has(cell.bg)) continue;
        seen.add(cell.bg);
        const color = cell.bg.startsWith("t:") ? `var(--sheet-${cell.bg.slice(2)})` : cell.bg;
        rules.push(`.order-sheet-surface .${bgClass(cell.bg)}{background:${color};}`);
      }
    }
    return rules.join("\n");
  }, [sheet]);

  // preventDefault on toolbar mousedown so clicking a control doesn't blur the
  // grid (which would drop the selection before the action runs).
  const keepSel = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  return (
    <div className={"order-sheet-surface" + (editing ? " is-editing" : "") + (minimal ? " is-minimal" : "")}>
      <style>{dynamicCss}</style>
      {!readOnly && !minimal && (
        <div className="order-sheet-toolbar" role="toolbar" aria-label="Cell formatting" onMouseDown={keepSel}>
          <span className="order-sheet-tool-label"><PaletteIcon size={13} strokeWidth={2} /></span>
          {SHEET_PALETTE.map((p) => (
            <button
              key={p.key}
              type="button"
              className="order-sheet-swatch"
              style={{ background: `var(--sheet-${p.key})` }}
              title={p.label}
              aria-label={`Background ${p.label}`}
              onClick={() => setBg(`t:${p.key}`)}
            />
          ))}
          <label className="order-sheet-swatch order-sheet-swatch-custom" title="Custom color">
            <input type="color" onChange={(e) => setBg(e.target.value)} aria-label="Custom background color" />
          </label>
          <button type="button" className="order-sheet-tool" onClick={() => setBg(undefined)} title="Clear background" aria-label="Clear background">
            <EraserIcon size={13} strokeWidth={2} />
          </button>
          <span className="order-sheet-tool-sep" />
          <button type="button" className="order-sheet-tool" onClick={toggleCollapse} title="Collapse / expand cell overflow" aria-label="Toggle collapse overflow">
            <ScissorsIcon size={13} strokeWidth={2} />
          </button>
          <span className="order-sheet-tool-sep" />
          <label className="order-sheet-checkbox" title="Press and drag a cell or selection to move it; it swaps with whatever's there">
            <input type="checkbox" checked={cellDrag} onChange={(e) => setCellDrag(e.target.checked)} />
            Cell drag
          </label>
        </div>
      )}
      {dragOver && (
        <style>{`.order-sheet-surface .sheet-row-${dragOver.r}.sheet-col-${dragOver.c}{outline:2px solid var(--royal);outline-offset:-2px;}`}</style>
      )}
      {menu && !readOnly && (
        <div className="order-sheet-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.axis === "row" ? (
            <>
              <button type="button" onClick={() => { rowOps(menu.index, "above"); setMenu(null); }}>Insert row above</button>
              <button type="button" onClick={() => { rowOps(menu.index, "below"); setMenu(null); }}>Insert row below</button>
              <button type="button" className="is-danger" onClick={() => { rowOps(menu.index, "delete"); setMenu(null); }}>Delete row {menu.index + 1}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => { colOps(menu.index, "left"); setMenu(null); }}>Insert column left</button>
              <button type="button" onClick={() => { colOps(menu.index, "right"); setMenu(null); }}>Insert column right</button>
              <button type="button" className="is-danger" onClick={() => { colOps(menu.index, "delete"); setMenu(null); }}>Delete column {colLabel(menu.index)}</button>
            </>
          )}
        </div>
      )}
      <div
        className={"order-sheet-scroll" + (cellDrag ? " is-cell-drag" : "")}
        ref={scrollRef}
        onPointerDownCapture={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <Spreadsheet
          data={rsData}
          onChange={handleRSChange}
          onActivate={handleActivate as never}
          onSelect={handleSelect as never}
          onModeChange={(m) => setEditing(m === "edit")}
          DataViewer={CellViewer as never}
          DataEditor={CellEditor as never}
          ColumnIndicator={ColumnIndicator as never}
          RowIndicator={RowIndicator as never}
          hideColumnIndicators={minimal}
          hideRowIndicators={minimal}
          className="order-sheet-grid"
        />
      </div>
      {hasMore && (
        <button
          type="button"
          className="order-sheet-expand"
          onClick={onExpand}
          title={`${contentRows} rows — open fullscreen to see all & edit`}
          aria-label={`Open fullscreen — ${contentRows} rows`}
        >
          <ChevronsDownIcon size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
