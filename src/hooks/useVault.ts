// useVault: filesystem-backed list of notes. Writes go through Rust IPC first,
// then state updates. No global store — App.tsx owns this slice.

import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Note } from "../lib/types";

const VAULT_KEY = "order.vaultPath";

export function useVault() {
  const [vaultPath, setVaultPathState] = useState<string | null>(
    () => localStorage.getItem(VAULT_KEY)
  );
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(0); // count of unpublished public changes

  const setVault = useCallback(async (path: string) => {
    if (!path) {
      // Empty string = reset to picker.
      localStorage.removeItem(VAULT_KEY);
      setVaultPathState(null);
      setNotes([]);
      return;
    }
    localStorage.setItem(VAULT_KEY, path);
    setVaultPathState(path);
    await invoke("set_vault", { path });
  }, []);

  const rescan = useCallback(async () => {
    if (!vaultPath) return;
    setLoading(true);
    try {
      const list = await invoke<Note[]>("scan_vault", { path: vaultPath });
      list.sort((a, b) => b.modified - a.modified);
      setNotes(list);
    } catch (e) {
      console.error("scan_vault failed", e);
    } finally {
      setLoading(false);
    }
  }, [vaultPath]);

  // Initial scan + watcher.
  useEffect(() => {
    if (!vaultPath) return;
    let cleanup: (() => void) | undefined;
    (async () => {
      await invoke("set_vault", { path: vaultPath });
      await rescan();
      await invoke("start_watcher", { path: vaultPath }).catch(() => {});
      const un = await listen<string[]>("vault-changed", () => rescan());
      cleanup = un;
    })();
    return () => { cleanup?.(); };
  }, [vaultPath, rescan]);

  const saveNote = useCallback(async (path: string, body: string, frontmatter: Record<string, any>) => {
    await invoke("save_note", { path, body, frontmatter });
    // Optimistic local update, then rely on the watcher to reconcile.
    setNotes(prev => prev.map(n => n.path === path
      ? { ...n, body, frontmatter, modified: Math.floor(Date.now() / 1000) }
      : n));
    if (frontmatter?.public) setDirty(d => d + 1);
  }, []);

  const deleteNote = useCallback(async (path: string) => {
    await invoke("delete_note", { path });
    setNotes(prev => prev.filter(n => n.path !== path));
  }, []);

  const createLogNote = useCallback(async (text: string) => {
    if (!vaultPath) return;
    const lines = text.split("\n");
    const title = lines[0].trim().replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80) || "Untitled";
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const path = `${vaultPath}/${dateStr} ${title}.md`;
    const frontmatter = {
      title,
      folder: "Log",
      date: dateStr,
      startTime: `${hh}:${mm}`,
      allDay: false,
    };
    await invoke("save_note", { path, body: text, frontmatter });
    await rescan();
  }, [vaultPath, rescan]);

  const publish = useCallback(async () => {
    if (!vaultPath) return 0;
    const count = await invoke<number>("publish_public", { vault: vaultPath });
    setDirty(0);
    return count;
  }, [vaultPath]);

  return { vaultPath, setVault, notes, loading, rescan, saveNote, deleteNote, createLogNote, dirty, publish };
}
