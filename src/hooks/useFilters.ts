// useFilters: which Areas, Categories, and Notable Folders are "on the page".
// Right-sidebar drill toggles these; left-top tabs read from them and scroll-
// anchor into sections. Empty selection across all three buckets shows Log only.

import { useCallback, useState } from "react";

const KEY = "order.filters";

export interface FilterSelection {
  folders: Set<string>;
  categories: Set<string>;
  areas: Set<string>;
}

interface Stored {
  folders?: string[];
  categories?: string[];
  areas?: string[];
}

function loadInitial(): FilterSelection {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { folders: new Set(["Log"]), categories: new Set(), areas: new Set() };
    const parsed = JSON.parse(raw) as Stored;
    return {
      folders: new Set(parsed.folders ?? ["Log"]),
      categories: new Set(parsed.categories ?? []),
      areas: new Set(parsed.areas ?? []),
    };
  } catch {
    return { folders: new Set(["Log"]), categories: new Set(), areas: new Set() };
  }
}

function persist(s: FilterSelection): FilterSelection {
  const payload: Stored = {
    folders: Array.from(s.folders),
    categories: Array.from(s.categories),
    areas: Array.from(s.areas),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable; non-fatal.
  }
  return s;
}

function toggleIn(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name); else next.add(name);
  return next;
}

export function useFilters() {
  const [selection, setSelection] = useState<FilterSelection>(loadInitial);

  const toggleFolder = useCallback((name: string) => {
    setSelection(prev => persist({ ...prev, folders: toggleIn(prev.folders, name) }));
  }, []);

  const toggleCategory = useCallback((name: string) => {
    setSelection(prev => persist({ ...prev, categories: toggleIn(prev.categories, name) }));
  }, []);

  const toggleArea = useCallback((name: string) => {
    setSelection(prev => persist({ ...prev, areas: toggleIn(prev.areas, name) }));
  }, []);

  const clear = useCallback(() => {
    setSelection(persist({ folders: new Set(["Log"]), categories: new Set(), areas: new Set() }));
  }, []);

  // Back-compat alias used by the existing folder-tab code path.
  const toggle = toggleFolder;
  const selected = selection.folders;
  const isOn = useCallback((name: string) => selection.folders.has(name), [selection.folders]);

  return {
    selection,
    selected,
    toggle,
    toggleFolder,
    toggleCategory,
    toggleArea,
    clear,
    isOn,
  };
}
