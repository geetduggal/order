// useEditor: which note is currently being edited inline, with a debounced
// save back through the vault hook. Exposes a `saving` flag so the card can
// show a "saving…" / "saved" indicator while a write is in flight.

import { useState, useRef, useCallback } from "react";
import type { Note } from "../lib/types";

const DEBOUNCE_MS = 500;

export function useEditor(
  saveNote: (path: string, body: string, frontmatter: Record<string, any>) => Promise<void>
) {
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const inflight = useRef(0);

  const open = useCallback((n: Note) => setEditingPath(n.path), []);
  const close = useCallback(() => setEditingPath(null), []);

  const queueSave = useCallback((n: Note, body: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      timer.current = undefined;
      inflight.current += 1;
      setSaving(true);
      try {
        await saveNote(n.path, body, n.frontmatter);
      } catch (err) {
        console.error(err);
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0) setSaving(false);
      }
    }, DEBOUNCE_MS);
  }, [saveNote]);

  const saveNow = useCallback(async (n: Note, body: string) => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = undefined; }
    setSaving(true);
    try {
      await saveNote(n.path, body, n.frontmatter);
    } finally {
      setSaving(false);
    }
  }, [saveNote]);

  return { editingPath, saving, open, close, queueSave, saveNow };
}
