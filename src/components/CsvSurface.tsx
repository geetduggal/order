// Component #4 of the OSuite Finance MVP: view a raw `.csv` file as a rendered
// table in Order, the same spirit as the `.sheet.html` spreadsheet view. Report
// snapshot CSVs (and any hand-kept CSV) become glanceable directly, without
// reopening the HTML report. Read-only for now — the CSV is a snapshot/evidence
// file, not a live editing surface.

import { useEffect, useMemo, useState } from "react";
import { toVaultRel } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";

/** Minimal RFC-4180-ish CSV parse: handles quoted fields, escaped quotes, commas
 *  and newlines inside quotes. Returns rows of string cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cur); cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      // Skip fully-empty trailing rows.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

/** True if every non-empty cell in a column parses as a number (for right-align). */
function isNumericColumn(rows: string[][], col: number, startRow: number): boolean {
  let sawOne = false;
  for (let r = startRow; r < rows.length; r++) {
    const v = rows[r]?.[col]?.trim();
    if (!v) continue;
    if (Number.isNaN(Number(v))) return false;
    sawOne = true;
  }
  return sawOne;
}

export function CsvSurface({ path }: { path: string }) {
  const rel = useMemo(() => toVaultRel(path), [path]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    void vaultFs.readText(rel)
      .then((raw) => { if (alive) setText(raw); })
      .catch((e) => { if (alive) setError(typeof e === "string" ? e : "Couldn't read this CSV."); });
    return () => { alive = false; };
  }, [rel]);

  const rows = useMemo(() => (text == null ? [] : parseCsv(text)), [text]);
  const numericCols = useMemo(() => {
    if (rows.length < 2) return new Set<number>();
    const cols = rows[0]?.length ?? 0;
    const s = new Set<number>();
    for (let c = 0; c < cols; c++) if (isNumericColumn(rows, c, 1)) s.add(c);
    return s;
  }, [rows]);

  if (error) return <div className="order-surface-loading">{error}</div>;
  if (text == null) return <div className="order-surface-loading">Loading CSV…</div>;
  if (rows.length === 0) return <div className="order-surface-loading">Empty CSV.</div>;

  const [header, ...body] = rows;
  return (
    <div className="order-csv-surface">
      <table className="order-csv-table">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className={numericCols.has(i) ? "num" : undefined}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {header.map((_, ci) => (
                <td key={ci} className={numericCols.has(ci) ? "num" : undefined}>{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
