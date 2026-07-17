// Spreadsheet surface: a note flipped to `view: sheet`, backed by react-
// spreadsheet and persisted to the `<Base>.sheet.html` sidecar.
//
// Overflow model (per spec): text continues past its cell like a real
// spreadsheet. Each column's `<td>` gets `position: relative` and a z-index
// one higher than the column to its left, so a later column that has an
// opaque background paints over the overflow text from earlier columns. A
// cell with no background renders no opaque layer, so earlier text passes
// through. "Collapse" clips a cell's own text instead of letting it continue.
//
// Formulas: react-spreadsheet evaluates any cell whose value starts with "="
// (fast-formula-parser), so basic `=A1+B1`, `=SUM(...)` etc. work for free.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Spreadsheet, { type CellBase, type Matrix } from "react-spreadsheet";
import { Palette as PaletteIcon, Scissors as ScissorsIcon, Eraser as EraserIcon } from "lucide-react";
import {
  SHEET_PALETTE,
  emptySheet,
  padSheet,
  parseSheet,
  serializeSheet,
  type SheetCell,
} from "../lib/note-view";

type RSCell = CellBase<string> & { bg?: string; collapse?: boolean };

interface SheetSurfaceProps {
  /** Raw `.sheet.html` contents (empty string for a brand-new sheet). */
  initial: string;
  /** Persist serialized HTML. Debounced by the caller-free surface itself. */
  onChange: (html: string) => void;
  readOnly?: boolean;
  /** Minimum visible grid — grown to fill space (bigger in fullscreen). */
  minRows?: number;
  minCols?: number;
}

/** Class fragment for a background value: palette token → themed var class,
 *  custom color → a per-color class whose CSS we inject below. */
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

export function SheetSurface({ initial, onChange, readOnly, minRows = 12, minCols = 8 }: SheetSurfaceProps) {
  const [sheet, setSheet] = useState<SheetCell[][]>(() => {
    const parsed = initial.trim() ? parseSheet(initial) : emptySheet(minRows, minCols);
    return padSheet(parsed.length ? parsed : emptySheet(minRows, minCols), minRows, minCols);
  });
  // Grow (never shrink) when the min grid changes, e.g. entering fullscreen.
  useEffect(() => {
    setSheet((prev) => padSheet(prev, minRows, minCols));
  }, [minRows, minCols]);

  // Current selection rectangle for toolbar actions (start/end inclusive).
  const [range, setRange] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);

  const rsData = useMemo(() => toRS(sheet), [sheet]);
  const rsDataRef = useRef(rsData);
  rsDataRef.current = rsData;

  // Debounced persistence so typing doesn't hammer the disk.
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

  // Track the selected rectangle. react-spreadsheet's Selection resolves to a
  // PointRange against the current data; a single click yields a 1×1 range.
  const handleSelect = useCallback((sel: { toRange: (d: Matrix<RSCell>) => { start: { row: number; column: number }; end: { row: number; column: number } } | null }) => {
    const pr = sel.toRange(rsDataRef.current);
    if (!pr) { setRange(null); return; }
    setRange({
      r0: Math.min(pr.start.row, pr.end.row),
      c0: Math.min(pr.start.column, pr.end.column),
      r1: Math.max(pr.start.row, pr.end.row),
      c1: Math.max(pr.start.column, pr.end.column),
    });
  }, []);

  const applyToSelection = useCallback((mut: (cell: SheetCell) => SheetCell) => {
    if (!range || readOnly) return;
    setSheet((prev) => {
      const next = padSheet(prev, range.r1 + 1, range.c1 + 1).map((row) => row.slice());
      for (let r = range.r0; r <= range.r1; r++) {
        for (let c = range.c0; c <= range.c1; c++) {
          next[r][c] = mut({ ...next[r][c] });
        }
      }
      persist(next);
      return next;
    });
  }, [range, readOnly, persist]);

  const setBg = useCallback((bg: string | undefined) => {
    applyToSelection((cell) => (bg ? { ...cell, bg } : (() => { const { bg: _drop, ...rest } = cell; return rest; })()));
  }, [applyToSelection]);

  const toggleCollapse = useCallback(() => {
    // If any selected cell isn't collapsed, collapse all; else un-collapse.
    let anyOpen = false;
    if (range) {
      for (let r = range.r0; r <= range.r1 && !anyOpen; r++)
        for (let c = range.c0; c <= range.c1 && !anyOpen; c++)
          if (!sheet[r]?.[c]?.collapse) anyOpen = true;
    }
    applyToSelection((cell) => (anyOpen ? { ...cell, collapse: true } : (() => { const { collapse: _d, ...rest } = cell; return rest; })()));
  }, [applyToSelection, range, sheet]);

  // Inject dynamic CSS: per-column z-index (paint order) + one rule per
  // background color actually in use (palette token or custom hex).
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
        const cls = bgClass(cell.bg);
        const color = cell.bg.startsWith("t:") ? `var(--sheet-${cell.bg.slice(2)})` : cell.bg;
        rules.push(`.order-sheet-surface .${cls}{background:${color};}`);
      }
    }
    return rules.join("\n");
  }, [sheet]);

  return (
    <div className="order-sheet-surface">
      <style>{dynamicCss}</style>
      {!readOnly && (
        <div className="order-sheet-toolbar" role="toolbar" aria-label="Cell formatting">
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
            <input
              type="color"
              onChange={(e) => setBg(e.target.value)}
              aria-label="Custom background color"
            />
          </label>
          <button
            type="button"
            className="order-sheet-tool"
            onClick={() => setBg(undefined)}
            title="Clear background"
            aria-label="Clear background"
          >
            <EraserIcon size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="order-sheet-tool"
            onClick={toggleCollapse}
            title="Collapse / expand cell overflow"
            aria-label="Toggle collapse overflow"
          >
            <ScissorsIcon size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <div className="order-sheet-scroll">
        <Spreadsheet
          data={rsData}
          onChange={handleRSChange}
          onSelect={handleSelect as never}
          className="order-sheet-grid"
        />
      </div>
    </div>
  );
}
