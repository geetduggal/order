// useFilters: which Notable Folders are "on the page". Right-sidebar drill
// toggles this; left-top tabs read from this and scroll-anchor into sections.

import { useState, useCallback } from "react";

const KEY = "order.selectedFolders";

function loadInitial(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? JSON.parse(raw) : ["Log"]);
  } catch {
    return new Set(["Log"]);
  }
}

export function useFilters() {
  const [selected, setSelected] = useState<Set<string>>(loadInitial);

  const persist = (s: Set<string>) => {
    localStorage.setItem(KEY, JSON.stringify(Array.from(s)));
    return s;
  };

  const toggle = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return persist(next);
    });
  }, []);

  const clear = useCallback(() => setSelected(persist(new Set(["Log"]))), []);

  const isOn = useCallback((name: string) => selected.has(name), [selected]);

  return { selected, toggle, clear, isOn };
}
