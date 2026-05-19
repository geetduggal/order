// VS Code style centered command palette for folder filtering.
// Opens with Cmd+K. Type to filter, Up/Down to navigate, Enter to
// toggle the selected folder's filter, Esc to dismiss.

import { useEffect, useMemo, useRef, useState } from "react";
import { folderColor, folderIcon } from "../lib/folders";
import type { NotableFolder } from "./Sidebar";

interface Props {
  folders: NotableFolder[];
  selected: Set<string>;
  onToggle: (folderName: string) => void;
  onClose: () => void;
}

export function CommandPalette({ folders, selected, onToggle, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return folders.slice(0, 12);
    return folders.filter((f) => {
      const t = f.frontmatter.title;
      const hay = (f.name + " " + (typeof t === "string" ? t : "")).toLowerCase();
      return hay.includes(q);
    }).slice(0, 12);
  }, [folders, query]);

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
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[active];
      if (pick) { onToggle(pick.name); onClose(); }
    }
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label="Filter folders"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
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
            {matches.map((f, i) => {
              const color = folderColor(f.name, f.frontmatter.color);
              const Icon = folderIcon(f.name, f.frontmatter.icon);
              const isOn = selected.has(f.name);
              return (
                <li
                  key={f.path}
                  role="option"
                  aria-selected={i === active}
                  className={"cmdk-item" + (i === active ? " is-active" : "")}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => { onToggle(f.name); onClose(); }}
                >
                  <Icon size={14} strokeWidth={1.8} style={{ color }} />
                  <span className="cmdk-item-name">{labelOf(f)}</span>
                  {(f.area || f.category) && (
                    <span className="cmdk-item-crumb">
                      {f.area}{f.area && f.category ? " › " : ""}{f.category}
                    </span>
                  )}
                  {isOn && <span className="cmdk-item-check">✓</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
