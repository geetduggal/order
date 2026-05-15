// useEditor: which note is currently being edited inline, with a debounced
// save back through the vault hook.

import { useState, useRef, useCallback } from "react";
import type { Note } from "../lib/types";

const DEBOUNCE_MS = 800;

export function useEditor(
  saveNote: (path: string, body: string, frontmatter: Record<string, any>) => Promise<void>
) {
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const open = useCallback((n: Note) => setEditingPath(n.path), []);
  const close = useCallback(() => setEditingPath(null), []);

  const queueSave = useCallback((n: Note, body: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveNote(n.path, body, n.frontmatter).catch(console.error);
    }, DEBOUNCE_MS);
  }, [saveNote]);

  const saveNow = useCallback(async (n: Note, body: string) => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = undefined; }
    await saveNote(n.path, body, n.frontmatter);
  }, [saveNote]);

  return { editingPath, open, close, queueSave, saveNow };
}
