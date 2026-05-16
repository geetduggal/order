// Areas + Categories, persisted to localStorage. Matches the design
// doc's three-level hierarchy: Areas (max 10) → Categories (max 10
// per Area) → Notable Folders (derived from any markdown file whose
// YAML frontmatter has a `category:` value).

import { useCallback, useEffect, useState } from "react";

export interface Area { id: string; name: string }
export interface Category { id: string; name: string; areaId: string | null }

interface Stored { areas: Area[]; categories: Category[] }

const KEY = "order.taxonomy";
const EMPTY: Stored = { areas: [], categories: [] };

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      areas: Array.isArray(parsed.areas) ? parsed.areas : [],
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    };
  } catch {
    return EMPTY;
  }
}

function save(value: Stored): void {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* non-fatal */ }
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTaxonomy() {
  const [state, setState] = useState<Stored>(() => load());
  useEffect(() => { save(state); }, [state]);

  const addArea = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((prev) =>
      prev.areas.some((a) => a.name.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : { ...prev, areas: [...prev.areas, { id: newId(), name: trimmed }] },
    );
  }, []);

  const removeArea = useCallback((id: string) => {
    setState((prev) => ({
      areas: prev.areas.filter((a) => a.id !== id),
      categories: prev.categories.map((c) => (c.areaId === id ? { ...c, areaId: null } : c)),
    }));
  }, []);

  const renameArea = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((prev) => ({
      ...prev,
      areas: prev.areas.map((a) => (a.id === id ? { ...a, name: trimmed } : a)),
    }));
  }, []);

  const addCategory = useCallback((name: string, areaId: string | null) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((prev) =>
      prev.categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase() && c.areaId === areaId)
        ? prev
        : { ...prev, categories: [...prev.categories, { id: newId(), name: trimmed, areaId }] },
    );
  }, []);

  const removeCategory = useCallback((id: string) => {
    setState((prev) => ({ ...prev, categories: prev.categories.filter((c) => c.id !== id) }));
  }, []);

  return {
    areas: state.areas,
    categories: state.categories,
    addArea, removeArea, renameArea,
    addCategory, removeCategory,
  };
}
