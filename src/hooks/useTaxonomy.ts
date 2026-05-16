// Areas + Categories — name-based storage, persisted to localStorage.
// Notable Folders are derived from the markdown vault separately.
// Names are unique within their scope (areas globally, categories
// within an area).

import { useCallback, useEffect, useState } from "react";

export interface CategoryRecord { area: string; name: string }

interface Stored { areas: string[]; categories: CategoryRecord[] }

const KEY = "order.taxonomy";
const EMPTY: Stored = { areas: [], categories: [] };

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      areas: Array.isArray(parsed.areas)
        ? parsed.areas.filter((x: unknown): x is string => typeof x === "string")
        : [],
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.filter(
            (c: unknown): c is CategoryRecord =>
              typeof c === "object" && c !== null
              && typeof (c as CategoryRecord).area === "string"
              && typeof (c as CategoryRecord).name === "string",
          )
        : [],
    };
  } catch {
    return EMPTY;
  }
}

function save(value: Stored): void {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* non-fatal */ }
}

function eqi(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

export function useTaxonomy() {
  const [state, setState] = useState<Stored>(() => load());
  useEffect(() => { save(state); }, [state]);

  const addArea = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((prev) =>
      prev.areas.some((a) => eqi(a, trimmed))
        ? prev
        : { ...prev, areas: [...prev.areas, trimmed] },
    );
  }, []);

  const removeArea = useCallback((name: string) => {
    setState((prev) => ({
      areas: prev.areas.filter((a) => !eqi(a, name)),
      // Categories under this area also drop — orphaning would just
      // re-stash them in derived state via Notable Folders if any
      // exist, which is fine.
      categories: prev.categories.filter((c) => !eqi(c.area, name)),
    }));
  }, []);

  const addCategory = useCallback((name: string, areaName: string) => {
    const trimmedName = name.trim();
    const trimmedArea = areaName.trim();
    if (!trimmedName || !trimmedArea) return;
    setState((prev) => {
      const areas = prev.areas.some((a) => eqi(a, trimmedArea))
        ? prev.areas
        : [...prev.areas, trimmedArea];
      const exists = prev.categories.some(
        (c) => eqi(c.area, trimmedArea) && eqi(c.name, trimmedName),
      );
      if (exists && areas === prev.areas) return prev;
      return {
        areas,
        categories: exists
          ? prev.categories
          : [...prev.categories, { area: trimmedArea, name: trimmedName }],
      };
    });
  }, []);

  const removeCategory = useCallback((name: string, areaName: string) => {
    setState((prev) => ({
      ...prev,
      categories: prev.categories.filter(
        (c) => !(eqi(c.area, areaName) && eqi(c.name, name)),
      ),
    }));
  }, []);

  return {
    areas: state.areas,
    categories: state.categories,
    addArea, removeArea,
    addCategory, removeCategory,
  };
}
