// Lean autocomplete dropdown for picking a Notable Folder ref while
// typing a new list item. Wraps a controlled input; renders a small
// list of matches beneath it. Up/Down navigate, Enter / Tab pick,
// Esc dismisses (and falls through to the input's own onEscape).

import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  onCommit: (final: string) => void;
  onCancel: () => void;
  /** Candidate refs to surface in the dropdown. Typically Notable
   *  Folder names; the parent decides what's in scope. */
  candidates: string[];
  /** Refs already in the list — excluded from suggestions to avoid
   *  proposing a duplicate. */
  exclude?: Set<string>;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

export function RefAutocomplete({
  value, onChange, onCommit, onCancel, candidates, exclude, className, placeholder, autoFocus,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const ex = exclude ?? new Set<string>();
    const lcExclude = new Set([...ex].map((s) => s.toLowerCase()));
    const isMatch = (c: string) => {
      const l = c.toLowerCase();
      if (lcExclude.has(l)) return false;
      if (!q) return true;
      return l.includes(q);
    };
    return candidates.filter(isMatch).slice(0, 12);
  }, [value, candidates, exclude]);

  useEffect(() => { setHighlightIdx(0); }, [matches.length]);

  function pick(ref: string) {
    onCommit(ref);
  }

  return (
    <div className="ref-ac">
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" || e.key === "Tab") {
            if (matches.length > 0 && (e.key === "Tab" || value.trim() === "" || matches[highlightIdx]?.toLowerCase() !== value.trim().toLowerCase())) {
              e.preventDefault();
              pick(matches[Math.max(0, Math.min(highlightIdx, matches.length - 1))] ?? value);
            } else {
              e.preventDefault();
              onCommit(value);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {matches.length > 0 && (value.trim().length > 0 || true) && (
        <ul className="ref-ac-menu" role="listbox">
          {matches.map((c, i) => (
            <li
              key={c}
              role="option"
              aria-selected={i === highlightIdx}
              className={"ref-ac-item" + (i === highlightIdx ? " is-on" : "")}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHighlightIdx(i)}
            >
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
