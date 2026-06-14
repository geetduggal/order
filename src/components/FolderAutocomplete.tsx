// Shared autocomplete used anywhere a user picks a Notable Folder by
// name — currently the card status bar's `+ folder` picker and the
// FrontmatterInspector's `folder:` field. Visual + behavioral contract:
//
//   - Empty query → recents first (most-recent on top), then the rest
//     of the candidates alphabetically. The "recents first" rule is
//     what makes the picker pleasant: 80% of the time you want a
//     folder you opened recently, not a search through the whole list.
//   - Non-empty query → simple case-insensitive substring filter over
//     all candidates (recents lose their ranking once you commit to a
//     search — substring match is the only signal that matters).
//   - ↑/↓ to move; Enter or click to commit; Esc to dismiss.
//
// Styling reuses the `.ref-ac` / `.ref-ac-option` classes WikiRefInput
// already uses, so every "ref autocomplete" in the app shares one look.

import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  /** Current text in the input. The caller owns it. */
  value: string;
  /** Called on every keystroke so the caller's value stays in sync. */
  onChange: (next: string) => void;
  /** Picked a candidate (or pressed Enter on a free-text value). */
  onPick: (name: string) => void;
  /** Dismissed without committing (Esc, blur with no change). */
  onCancel?: () => void;
  /** Full list of candidate refs the picker can show. Order doesn't
   *  matter — the component sorts. */
  candidates: string[];
  /** Most-recent-first list of refs. The first ~6 land at the top of
   *  the menu when the query is empty. */
  recents?: string[];
  /** Refs to suppress (e.g. the folder a card is already assigned to). */
  exclude?: Set<string>;
  /** Caller can decorate each row with a swatch / color. */
  colorFor?: (ref: string) => string | undefined;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Max rows in the dropdown. Default 8. */
  max?: number;
}

const DEFAULT_MAX = 8;

export function FolderAutocomplete({
  value, onChange, onPick, onCancel,
  candidates, recents, exclude, colorFor,
  className, placeholder, autoFocus,
  max = DEFAULT_MAX,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  // Track whether the user has typed since focusing. When they have,
  // the substring filter narrows; when they HAVEN'T (still the value
  // we focused with), show the full recents-first menu — clicking
  // into a folder field with the current folder typed in shouldn't
  // filter the menu to just that one row.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  const lcExclude = useMemo(
    () => new Set([...(exclude ?? [])].map((s) => s.toLowerCase())),
    [exclude],
  );

  // Rows: until the user actually types into the field, treat the
  // query as empty so a click on the chip (focuses with the current
  // folder pre-filled) shows the full recents-first menu — not a
  // one-row "match yourself" filter. The recents-first ordering is
  // implicit in the row order; no visual badge — the ordering itself
  // is the signal.
  const rows = useMemo(() => {
    const q = dirty ? value.trim().toLowerCase() : "";
    const want = (ref: string) => !lcExclude.has(ref.toLowerCase());
    if (!q) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of (recents ?? [])) {
        const key = r.toLowerCase();
        if (seen.has(key) || !want(r)) continue;
        seen.add(key);
        out.push(r);
        if (out.length >= max) return out;
      }
      const rest = [...candidates]
        .filter((c) => !seen.has(c.toLowerCase()) && want(c))
        .sort((a, b) => a.localeCompare(b));
      for (const r of rest) {
        out.push(r);
        if (out.length >= max) break;
      }
      return out;
    }
    // With a query the user has committed to a search — substring
    // filter the full list, prefix-matches first.
    const matched = candidates.filter((c) => want(c) && c.toLowerCase().includes(q));
    matched.sort((a, b) => {
      const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.localeCompare(b);
    });
    return matched.slice(0, max);
  }, [value, candidates, recents, lcExclude, max, dirty]);

  useEffect(() => { setHi(0); }, [rows.length, value]);

  function pick(ref: string) {
    onPick(ref);
    setOpen(false);
    setDirty(false);
  }

  return (
    <div className={"ref-ac" + (className ? ` ${className}` : "")}>
      <input
        ref={inputRef}
        className="ref-ac-input"
        value={value}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setDirty(false); }}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setDirty(true); }}
        onBlur={() => {
          // Defer so a click on a row gets to fire first.
          setTimeout(() => { setOpen(false); setDirty(false); }, 120);
        }}
        onKeyDown={(e) => {
          if (open && rows.length > 0) {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, rows.length - 1)); return; }
            if (e.key === "ArrowUp")   { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); return; }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(rows[Math.max(0, Math.min(hi, rows.length - 1))]);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            // Free text — let the caller decide what to do with it.
            if (value.trim()) onPick(value.trim());
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            onCancel?.();
            return;
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul className="ref-ac-menu" role="listbox">
          {rows.map((ref, i) => {
            const swatch = colorFor?.(ref);
            return (
              <li key={ref}>
                <button
                  type="button"
                  className={"ref-ac-option" + (i === hi ? " is-on" : "")}
                  onMouseDown={(e) => { e.preventDefault(); pick(ref); }}
                  role="option"
                  aria-selected={i === hi}
                >
                  {swatch && <span className="ref-ac-swatch" style={{ background: swatch }} />}
                  <span className="ref-ac-name">{ref}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
