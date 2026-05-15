// useTaxonomy: Areas and Categories, persisted per vault to localStorage.
// Notable Folders are derived from the vault (any markdown file with a
// `category` YAML field is a Notable Folder's Main Document) and live in
// useVault; this hook only manages the user-defined Areas + Categories
// that sit above them in the hierarchy.

import { useCallback, useEffect, useState } from "react";

export interface Area {
  id: string;
  name: string;
}

export interface Category {
  id: string;
  name: string;
  areaId: string | null;
}

interface Stored {
  areas: Area[];
  categories: Category[];
}

const EMPTY: Stored = { areas: [], categories: [] };

function storageKey(vaultPath: string): string {
  return `order.taxonomy:${vaultPath}`;
}

function load(vaultPath: string | null): Stored {
  if (!vaultPath) return EMPTY;
  try {
    const raw = localStorage.getItem(storageKey(vaultPath));
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

function save(vaultPath: string | null, value: Stored): void {
  if (!vaultPath) return;
  try {
    localStorage.setItem(storageKey(vaultPath), JSON.stringify(value));
  } catch {
    // localStorage may be unavailable; non-fatal.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTaxonomy(vaultPath: string | null) {
  const [areas, setAreasState] = useState<Area[]>(() => load(vaultPath).areas);
  const [categories, setCategoriesState] = useState<Category[]>(() => load(vaultPath).categories);

  useEffect(() => {
    const stored = load(vaultPath);
    setAreasState(stored.areas);
    setCategoriesState(stored.categories);
  }, [vaultPath]);

  const persistAll = useCallback((nextAreas: Area[], nextCategories: Category[]) => {
    setAreasState(nextAreas);
    setCategoriesState(nextCategories);
    save(vaultPath, { areas: nextAreas, categories: nextCategories });
  }, [vaultPath]);

  const addArea = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (areas.some(a => a.name.toLowerCase() === trimmed.toLowerCase())) return;
    persistAll([...areas, { id: newId(), name: trimmed }], categories);
  }, [areas, categories, persistAll]);

  const renameArea = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistAll(areas.map(a => a.id === id ? { ...a, name: trimmed } : a), categories);
  }, [areas, categories, persistAll]);

  const removeArea = useCallback((id: string) => {
    persistAll(
      areas.filter(a => a.id !== id),
      categories.map(c => c.areaId === id ? { ...c, areaId: null } : c),
    );
  }, [areas, categories, persistAll]);

  const addCategory = useCallback((name: string, areaId: string | null) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (categories.some(c => c.name.toLowerCase() === trimmed.toLowerCase() && c.areaId === areaId)) return;
    persistAll(areas, [...categories, { id: newId(), name: trimmed, areaId }]);
  }, [areas, categories, persistAll]);

  const renameCategory = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistAll(areas, categories.map(c => c.id === id ? { ...c, name: trimmed } : c));
  }, [areas, categories, persistAll]);

  const removeCategory = useCallback((id: string) => {
    persistAll(areas, categories.filter(c => c.id !== id));
  }, [areas, categories, persistAll]);

  return {
    areas,
    categories,
    addArea,
    renameArea,
    removeArea,
    addCategory,
    renameCategory,
    removeCategory,
  };
}
