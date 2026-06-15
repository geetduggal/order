// Full-text search overlay. Cmd+F (or '/') opens a centered input
// over the page; as the user types, a debounced Rust call returns
// up to N matching notes with a snippet around the first match.
// Click a result to navigate to that note in the Pile.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon, X as XIcon, RotateCw } from "lucide-react";
import { vaultFs } from "../lib/vault-fs";

export interface FtsHit {
  path: string;
  snippet: string;
  matchOffset: number;
  matchLength: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Path → user-facing display title (note's H1 or filename). */
  titleForPath: (path: string) => string;
  /** Navigate to a note (path) and close the overlay. */
  onPick: (path: string) => void;
}

export function FtsOverlay({ open, onClose, titleForPath, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FtsHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // First-time load — populate in-memory index from the on-disk cache.
  useEffect(() => {
    if (!open || indexLoaded) return;
    let cancelled = false;
    void vaultFs.ftsLoad().then((n) => {
      if (!cancelled) {
        setIndexLoaded(true);
        if (n === 0) setError("No index yet — rebuild from settings ↻");
      }
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [open, indexLoaded]);

  // Auto-focus when opened.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Debounced query.
  useEffect(() => {
    if (!open) return;
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const result = await vaultFs.ftsSearch(query, 50);
        if (!cancelled) {
          setHits(result);
          setHighlightIdx(0);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open]);

  const rebuild = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await vaultFs.ftsBuild();
      setError(`Indexed ${n} notes`);
      setIndexLoaded(true);
      // Re-run the current query.
      if (query.trim().length >= 2) {
        const result = await vaultFs.ftsSearch(query, 50);
        setHits(result);
        setHighlightIdx(0);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [query]);

  const close = useCallback(() => {
    setQuery("");
    setHits([]);
    onClose();
  }, [onClose]);

  // Highlight the matched substring inside the snippet for the
  // currently-rendered hit. Simple linear scan once per hit.
  function renderSnippet(hit: FtsHit, q: string): React.ReactNode {
    const i = hit.snippet.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0 || q.length === 0) return hit.snippet;
    return (
      <>
        {hit.snippet.slice(0, i)}
        <mark className="fts-mark">{hit.snippet.slice(i, i + q.length)}</mark>
        {hit.snippet.slice(i + q.length)}
      </>
    );
  }

  const queryTrimmed = useMemo(() => query.trim(), [query]);

  if (!open) return null;
  return (
    <div className="fts-backdrop" onClick={close}>
      <div className="fts-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fts-input-row">
          <SearchIcon size={16} strokeWidth={2.1} className="fts-input-icon" />
          <input
            ref={inputRef}
            className="fts-input"
            placeholder="Search note bodies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); close(); }
              else if (e.key === "Enter") {
                e.preventDefault();
                const h = hits[highlightIdx];
                if (h) { onPick(h.path); close(); }
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIdx((i) => Math.min(i + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIdx((i) => Math.max(i - 1, 0));
              }
            }}
          />
          <button
            type="button"
            className={"fts-rebuild" + (busy ? " is-busy" : "")}
            onClick={() => { void rebuild(); }}
            title="Rebuild search index"
            disabled={busy}
          >
            <RotateCw size={14} strokeWidth={2.1} />
          </button>
          <button
            type="button"
            className="fts-close"
            onClick={close}
            aria-label="Close"
            title="Close"
          >
            <XIcon size={14} strokeWidth={2.1} />
          </button>
        </div>
        {error && <div className="fts-status">{error}</div>}
        {queryTrimmed.length > 0 && queryTrimmed.length < 2 && (
          <div className="fts-status">Type at least 2 characters</div>
        )}
        {queryTrimmed.length >= 2 && hits.length === 0 && !error && (
          <div className="fts-status">No matches.</div>
        )}
        {hits.length > 0 && (
          <ul className="fts-results" role="listbox">
            {hits.map((h, i) => (
              <li
                key={h.path}
                role="option"
                aria-selected={i === highlightIdx}
                className={"fts-hit" + (i === highlightIdx ? " is-on" : "")}
                onMouseEnter={() => setHighlightIdx(i)}
                onClick={() => { onPick(h.path); close(); }}
              >
                <div className="fts-hit-title">{titleForPath(h.path)}</div>
                <div className="fts-hit-snippet">{renderSnippet(h, queryTrimmed)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
