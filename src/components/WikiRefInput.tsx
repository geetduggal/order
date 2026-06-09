// A plain text input that matches Milkdown's wikilink autocomplete
// pattern: type freely; the moment you type `[[`, a popup of Notable
// Folder candidates appears, filtered by whatever follows the `[[`.
// Picking a candidate or typing `]]` closes the popup with the
// `[[Name]]` literal pasted into the input. Outside of an open `[[…`
// trigger the input behaves like any other text field.
//
// On commit, the parent receives the raw final value. It's the parent's
// job to decide whether `[[Foo]]` becomes a wikilink item or a text
// item — usually: a value that is *exactly* `[[Name]]` saves as a
// wikilink, anything else saves as the literal text bullet.

import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Fired on Enter (or selecting a candidate when no extra text was
   *  typed around it). The parent inspects the value to decide
   *  wikilink-vs-text. */
  onCommit: (final: string) => void;
  onCancel: () => void;
  /** Candidate refs surfaced once `[[` is open. */
  candidates: string[];
  /** Lowercase set of refs to suppress (already used in the list). */
  exclude?: Set<string>;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

const TRIGGER_RE = /\[\[([^\[\]\n]*)$/;

export function WikiRefInput({
  value, onChange, onCommit, onCancel, candidates, exclude, className, placeholder, autoFocus,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [caret, setCaret] = useState(0);

  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  // Open trigger: the substring from start-of-value up to the caret
  // ends in `[[query` with no `]]` between the `[[` and the caret.
  const head = value.slice(0, caret);
  const tail = value.slice(caret);
  const match = TRIGGER_RE.exec(head);
  // Suppress when there's a closing `]]` just ahead of the cursor —
  // user is editing inside an already-finished wikilink, not opening
  // a new one. Same heuristic as the Milkdown plugin.
  const closedAhead = match && tail.startsWith("]]");
  const triggerOpen = !!match && !closedAhead;
  const query = match ? match[1] : "";

  const matches = (() => {
    if (!triggerOpen) return [] as string[];
    const q = query.trim().toLowerCase();
    const ex = exclude ?? new Set<string>();
    const lcExclude = new Set([...ex].map((s) => s.toLowerCase()));
    return candidates
      .filter((c) => {
        const l = c.toLowerCase();
        if (lcExclude.has(l)) return false;
        if (!q) return true;
        return l.includes(q);
      })
      .slice(0, 8);
  })();

  useEffect(() => { setHighlightIdx(0); }, [matches.length, triggerOpen]);

  function pick(name: string) {
    if (!match) return;
    // Replace `[[query` at the trigger position with `[[name]]`.
    const triggerStart = (match.index ?? 0);
    const before = value.slice(0, triggerStart);
    const after = value.slice(caret);
    const next = `${before}[[${name}]]${after}`;
    onChange(next);
    // Move the caret to right after the inserted `]]`.
    const newCaret = before.length + 2 + name.length + 2;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  function syncCaret() {
    const el = inputRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? value.length);
  }

  return (
    <div className="ref-ac">
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); syncCaret(); }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onBlur={() => {
          // Defer so a click on a candidate gets processed first.
          setTimeout(() => onCommit(value), 100);
        }}
        onKeyDown={(e) => {
          if (triggerOpen && matches.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[Math.max(0, Math.min(highlightIdx, matches.length - 1))]);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
        }}
      />
      {triggerOpen && matches.length > 0 && (
        <ul className="ref-ac-menu">
          {matches.map((m, i) => (
            <li key={m}>
              <button
                type="button"
                className={"ref-ac-option" + (i === highlightIdx ? " is-on" : "")}
                onMouseDown={(e) => { e.preventDefault(); pick(m); }}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
