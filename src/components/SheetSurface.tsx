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
import {
  Palette as PaletteIcon, Scissors as ScissorsIcon, Eraser as EraserIcon,
  Rows3 as RowsIcon, Columns3 as ColumnsIcon,
} from "lucide-react";
import {
  SHEET_PALETTE,
  emptySheet,
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
  minRows?: number;
  minCols?: number;
}

function bgClass(bg: string): string {
  if (bg.startsWith("t:")) return `sheet-bg-${bg.slice(2)}`;
  return `sheet-bg-c${bg.replace(/[^a-z0-9]/gi, "")}`;
}

function toRS(data: SheetCell[][]): Matrix<RSCell> {
  return data.map((row, r) =>
    row.map((cell, c): RSCell => ({
      value: cell.value,
      ...(cell.bg ? { bg: cell.bg } : {}),
      ...(cell.collapse ? { collapse: true } : {}),
      className:
        `sheet-col-${c}` +
        (cell.bg ? ` ${bgClass(cell.bg)}` : "") +
        (cell.collapse ? " sheet-collapse" : ""),
    })),
  );
}

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

export function SheetSurface({ initial, onChange, readOnly, minRows = 12, minCols = 8 }: SheetSurfaceProps) {
  const [sheet, setSheet] = useState<SheetCell[][]>(() => {
    const parsed = initial.trim() ? parseSheet(initial) : [];
    return padSheet(parsed, minRows, minCols);
  });
  useEffect(() => { setSheet((prev) => padSheet(prev, minRows, minCols)); }, [minRows, minCols]);

  // Last known selection rectangle, kept in a ref so a toolbar click (which
  // blurs the grid) still applies to what was selected. onActivate covers a
  // single-cell click; onSelect covers a dragged range.
  const selRef = useRef<Rect | null>(null);
  const [editing, setEditing] = useState(false);

  const rsData = useMemo(() => toRS(sheet), [sheet]);
  const rsDataRef = useRef(rsData);
  rsDataRef.current = rsData;
  // Logical data for the viewer (reads bg for contrast); a ref so the memoized
  // DataViewer stays stable (no per-render remount of every cell).
  const dataRef = useRef(sheet);
  dataRef.current = sheet;

  // Custom cell viewer: renders the (evaluated) value in an ABSOLUTELY
  // positioned span so it escapes the cell box and continues past to the
  // right like a real spreadsheet — column z-index (set per column below)
  // makes later opaque cells paint over the overflow. Text color is forced
  // readable on custom backgrounds.
  const CellViewer = useMemo(() => {
    const V = ({ row, column, cell, evaluatedCell }: { row: number; column: number; cell?: RSCell; evaluatedCell?: RSCell }) => {
      const bg = dataRef.current[row]?.[column]?.bg;
      const color = customTextColor(bg);
      // Prefer the evaluated value so `=A1+B1` shows its result, not the formula.
      const v = (evaluatedCell ?? cell)?.value;
      return (
        <span className="order-sheet-val" style={color ? { color } : undefined}>
          {v == null ? "" : String(v)}
        </span>
      );
    };
    return V;
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((next: SheetCell[][]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onChange(serializeSheet(next)), 500);
  }, [onChange]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const handleRSChange = useCallback((m: Matrix<RSCell>) => {
    const next = fromRS(m);
    setSheet(next);
    persist(next);
  }, [persist]);

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
    setSheet((prev) => {
      const next = padSheet(prev, sel.r1 + 1, sel.c1 + 1).map((row) => row.slice());
      for (let r = sel.r0; r <= sel.r1; r++)
        for (let c = sel.c0; c <= sel.c1; c++) next[r][c] = mut({ ...next[r][c] });
      persist(next);
      return next;
    });
  }, [readOnly, persist]);

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

  const deleteRows = useCallback(() => {
    const sel = selRef.current;
    if (!sel || readOnly) return;
    setSheet((prev) => {
      const next = padSheet(prev.filter((_, i) => i < sel.r0 || i > sel.r1), minRows, minCols);
      persist(next);
      return next;
    });
  }, [readOnly, persist, minRows, minCols]);

  const deleteCols = useCallback(() => {
    const sel = selRef.current;
    if (!sel || readOnly) return;
    setSheet((prev) => {
      const next = padSheet(prev.map((row) => row.filter((_, j) => j < sel.c0 || j > sel.c1)), minRows, minCols);
      persist(next);
      return next;
    });
  }, [readOnly, persist, minRows, minCols]);

  // Per-column z-index (paint order) + one rule per in-use background color.
  const dynamicCss = useMemo(() => {
    const cols = sheet.reduce((m, row) => Math.max(m, row.length), 0);
    const rules: string[] = [];
    for (let c = 0; c < cols; c++) {
      rules.push(`.order-sheet-surface .sheet-col-${c}{position:relative;z-index:${c + 1};}`);
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
    <div className={"order-sheet-surface" + (editing ? " is-editing" : "")}>
      <style>{dynamicCss}</style>
      {!readOnly && (
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
          <button type="button" className="order-sheet-tool" onClick={deleteRows} title="Delete selected row(s)" aria-label="Delete rows">
            <RowsIcon size={13} strokeWidth={2} />
          </button>
          <button type="button" className="order-sheet-tool" onClick={deleteCols} title="Delete selected column(s)" aria-label="Delete columns">
            <ColumnsIcon size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <div className="order-sheet-scroll">
        <Spreadsheet
          data={rsData}
          onChange={handleRSChange}
          onActivate={handleActivate as never}
          onSelect={handleSelect as never}
          onModeChange={(m) => setEditing(m === "edit")}
          DataViewer={CellViewer as never}
          className="order-sheet-grid"
        />
      </div>
    </div>
  );
}
