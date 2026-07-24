// VS Code style centered command palette for folder filtering.
// Opens with Cmd+K. Type to filter, Up/Down to navigate, Enter to
// toggle the selected folder's filter, Esc to dismiss.

import { useEffect, useMemo, useRef, useState } from "react";
import { folderColor, folderIcon } from "../lib/folders";
import type { NotableFolder } from "./Sidebar";

/** A non-folder action surfaced in the palette (e.g. "Open todo.txt").
 *  Sorts above folder matches when the user's query hits its keywords,
 *  and surfaces in the empty-query view too. */
export interface PaletteExtra {
  label: string;
  /** Lowercase keywords for fuzzy match against the query. */
  keywords: string;
  /** Optional secondary label (path, hint) shown after the main label. */
  hint?: string;
  onPick: () => void;
}

interface Props {
  folders: NotableFolder[];
  selected: Set<string>;
  onToggle: (folderName: string) => void;
  onClose: () => void;
  /** Folder refs the user opened most-recently-first. The empty-query
   *  view shows these first (as "Recent") then the rest alphabetically,
   *  so the palette doubles as a back-history for jumping. */
  recents?: string[];
  /** Extra non-folder actions (e.g. "Open todo.txt"). Shown above
   *  the folders when their keywords match the query. */
  extras?: PaletteExtra[];
  /** Every Area → Category pair, for the quick "create folder" step. */
  placements?: { area: string; category: string }[];
  /** Create a Notable Folder named `name` under `area` → `category`.
   *  When set, a "Create folder…" row appears for an unmatched query. */
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void> | void;
}

export function CommandPalette({ folders, selected, onToggle, onClose, recents, extras, placements, onCreateFolder }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // When set, the palette is in its two-step "create folder" placement mode.
  const [creating, setCreating] = useState<{ name: string; area: string; category: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Hover only selects after a real mouse move — opening with the keyboard, or
  // items scrolling under a resting cursor, must not steal the selection.
  const mouseMovedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const byName = useMemo(() => {
    const m = new Map<string, NotableFolder>();
    for (const f of folders) m.set(f.name, f);
    return m;
  }, [folders]);

  // Matches are heterogeneous: a folder entry or an extra action (an
  // object marked with a literal `kind: "extra"` discriminator). Both
  // render in the same list; Enter / click dispatches accordingly.
  type Match =
    | { kind: "folder"; folder: NotableFolder }
    | { kind: "extra"; extra: PaletteExtra }
    | { kind: "create"; name: string };
  const matches = useMemo<Match[]>(() => {
    const q = query.trim().toLowerCase();
    const xs = extras ?? [];
    // Offer "create folder" when the query doesn't exactly name an existing
    // folder (by ref or title) and a create handler + placements are wired.
    const trimmed = query.trim();
    const canCreate = !!onCreateFolder && (placements?.length ?? 0) > 0 && trimmed.length > 0
      && !folders.some((f) => {
        const t = f.frontmatter.title;
        return f.name.toLowerCase() === q || (typeof t === "string" && t.toLowerCase() === q);
      });
    const createMatch: Match[] = canCreate ? [{ kind: "create", name: trimmed }] : [];
    if (!q) {
      const extraMatches: Match[] = xs.map((e) => ({ kind: "extra", extra: e }));
      // Recents first, then the rest in folders' natural order, capped
      // at 12 (minus the extras). Skip recents that no longer exist.
      const recentEntries: NotableFolder[] = [];
      const seen = new Set<string>();
      for (const name of recents ?? []) {
        const f = byName.get(name);
        if (f && !seen.has(name)) {
          recentEntries.push(f);
          seen.add(name);
        }
        if (recentEntries.length >= 12) break;
      }
      const rest = folders.filter((f) => !seen.has(f.name));
      const folderMatches: Match[] = [...recentEntries, ...rest]
        .slice(0, Math.max(0, 12 - extraMatches.length))
        .map((f) => ({ kind: "folder", folder: f }));
      return [...extraMatches, ...folderMatches];
    }
    const extraMatches: Match[] = xs
      .filter((e) => e.keywords.includes(q) || e.label.toLowerCase().includes(q))
      .map((e) => ({ kind: "extra", extra: e }));
    const folderMatches: Match[] = folders
      .filter((f) => {
        const t = f.frontmatter.title;
        const hay = (f.name + " " + (typeof t === "string" ? t : "")).toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12 - extraMatches.length)
      .map((f) => ({ kind: "folder", folder: f }));
    return [...extraMatches, ...folderMatches, ...createMatch];
  }, [folders, query, recents, byName, extras, onCreateFolder, placements]);
  const recentSet = useMemo(() => new Set(recents ?? []), [recents]);
  const areaOptions = useMemo(() => [...new Set((placements ?? []).map((p) => p.area))], [placements]);
  const catOptions = useMemo(() => {
    if (!creating) return [] as string[];
    const forArea = (placements ?? []).filter((p) => p.area === creating.area).map((p) => p.category);
    return forArea.length > 0 ? [...new Set(forArea)] : [...new Set((placements ?? []).map((p) => p.category))];
  }, [placements, creating]);

  function beginCreate(name: string) {
    const first = placements?.[0];
    setCreating({ name, area: first?.area ?? "", category: first?.category ?? "" });
  }
  async function submitCreate() {
    if (!creating || !onCreateFolder || busy) return;
    const name = creating.name.trim();
    const area = creating.area.trim();
    const category = creating.category.trim();
    if (!name || !area || !category) return;
    setBusy(true);
    try { await onCreateFolder(name, area, category); onClose(); }
    finally { setBusy(false); }
  }

  function labelOf(f: typeof folders[number]): string {
    const t = f.frontmatter.title;
    return typeof t === "string" && t.trim() ? t : f.name;
  }

  // Keep active index in range when matches shrink.
  useEffect(() => {
    if (active >= matches.length) setActive(Math.max(0, matches.length - 1));
  }, [active, matches.length]);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    // In placement mode, Esc steps back to the list; the form's own inputs
    // handle Enter. Don't run the list navigation below.
    if (creating) {
      if (e.key === "Escape") { e.preventDefault(); setCreating(null); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mouseMovedRef.current = false;
      setActive((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mouseMovedRef.current = false;
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[active];
      if (!pick) return;
      if (pick.kind === "extra") { pick.extra.onPick(); onClose(); return; }
      if (pick.kind === "create") { beginCreate(pick.name); return; }
      onToggle(pick.folder.name);
      onClose();
    }
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label="Filter folders"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={() => { mouseMovedRef.current = true; }}
        onKeyDown={onKeyDown}
      >
        {creating ? (
          <div className="cmdk-create">
            <div className="cmdk-create-title">New folder <strong>{creating.name}</strong></div>
            <label className="cmdk-create-field">
              <span className="cmdk-create-label">Area</span>
              <input
                autoFocus
                className="cmdk-create-input"
                list="cmdk-area-options"
                value={creating.area}
                disabled={busy}
                placeholder="Area"
                onChange={(e) => setCreating((c) => c && { ...c, area: e.target.value })}
              />
            </label>
            <datalist id="cmdk-area-options">
              {areaOptions.map((a) => <option key={a} value={a} />)}
            </datalist>
            <label className="cmdk-create-field">
              <span className="cmdk-create-label">Category</span>
              <input
                className="cmdk-create-input"
                list="cmdk-cat-options"
                value={creating.category}
                disabled={busy}
                placeholder="Category"
                onChange={(e) => setCreating((c) => c && { ...c, category: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitCreate(); } }}
              />
            </label>
            <datalist id="cmdk-cat-options">
              {catOptions.map((c) => <option key={c} value={c} />)}
            </datalist>
            <div className="cmdk-create-actions">
              <button type="button" className="cmdk-create-btn is-ghost" disabled={busy} onClick={() => setCreating(null)}>Back</button>
              <button type="button" className="cmdk-create-btn" disabled={busy || !creating.area.trim() || !creating.category.trim()} onClick={() => { void submitCreate(); }}>Create folder</button>
            </div>
          </div>
        ) : (
        <>
        <input
          ref={inputRef}
          type="text"
          className="cmdk-input"
          placeholder="Type a folder name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        />
        {matches.length === 0 ? (
          <p className="cmdk-empty">No folders match.</p>
        ) : (
          <ul ref={listRef} className="cmdk-list" role="listbox">
            {matches.map((m, i) => {
              if (m.kind === "extra") {
                return (
                  <li
                    key={`extra:${m.extra.label}`}
                    role="option"
                    aria-selected={i === active}
                    className={"cmdk-item cmdk-item-extra" + (i === active ? " is-active" : "")}
                    onMouseEnter={() => { if (mouseMovedRef.current) setActive(i); }}
                    onClick={() => { m.extra.onPick(); onClose(); }}
                  >
                    <span className="cmdk-item-name">{m.extra.label}</span>
                    {m.extra.hint && (
                      <span className="cmdk-item-crumb">{m.extra.hint}</span>
                    )}
                  </li>
                );
              }
              if (m.kind === "create") {
                return (
                  <li
                    key="create-folder"
                    role="option"
                    aria-selected={i === active}
                    className={"cmdk-item cmdk-item-create" + (i === active ? " is-active" : "")}
                    onMouseEnter={() => { if (mouseMovedRef.current) setActive(i); }}
                    onClick={() => beginCreate(m.name)}
                  >
                    <span className="cmdk-item-name">+ Create folder “{m.name}”…</span>
                    <span className="cmdk-item-crumb">pick a place</span>
                  </li>
                );
              }
              const f = m.folder;
              const color = folderColor(f.name, f.frontmatter.color);
              const Icon = folderIcon(f.name, f.frontmatter.icon);
              const isOn = selected.has(f.name);
              const isRecent = !query.trim() && recentSet.has(f.name);
              return (
                <li
                  key={f.path}
                  role="option"
                  aria-selected={i === active}
                  className={"cmdk-item" + (i === active ? " is-active" : "") + (isRecent ? " is-recent" : "")}
                  onMouseEnter={() => { if (mouseMovedRef.current) setActive(i); }}
                  onClick={() => { onToggle(f.name); onClose(); }}
                >
                  <Icon size={14} strokeWidth={1.8} style={{ color }} />
                  <span className="cmdk-item-name">{labelOf(f)}</span>
                  {(f.area || f.category) && (
                    <span className="cmdk-item-crumb">
                      {f.area}{f.area && f.category ? " › " : ""}{f.category}
                    </span>
                  )}
                  {isRecent && <span className="cmdk-item-recent">recent</span>}
                  {isOn && <span className="cmdk-item-check">✓</span>}
                </li>
              );
            })}
          </ul>
        )}
        </>
        )}
      </div>
    </div>
  );
}
