// useVault — filesystem-backed list of notes (metadata only).
// Full body is loaded lazily via readBody() when a note is opened.
// Watcher events trigger targeted refresh_note(path) rather than a full rescan.

import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Note, NoteWithBody } from "../lib/types";

const VAULT_KEY = "order.vaultPath";

export function useVault() {
  const [vaultPath, setVaultPathState] = useState<string | null>(
    () => localStorage.getItem(VAULT_KEY)
  );
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(0);

  // Coalesce watcher events: collect paths, flush every 250ms.
  const pending = useRef<Set<string>>(new Set());
  const flushTimer = useRef<number | undefined>(undefined);

  const setVault = useCallback(async (path: string) => {
    if (!path) {
      localStorage.removeItem(VAULT_KEY);
      setVaultPathState(null);
      setNotes([]);
      return;
    }
    localStorage.setItem(VAULT_KEY, path);
    setVaultPathState(path);
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

  const flushPending = useCallback(async () => {
    flushTimer.current = undefined;
    const paths = Array.from(pending.current);
    pending.current.clear();
    if (!paths.length) return;
    const updates = await Promise.all(
      paths.map(p => invoke<Note | null>("refresh_note", { path: p }).catch(() => null))
    );
    setNotes(prev => {
      const byPath = new Map(prev.map(n => [n.path, n]));
      paths.forEach((p, i) => {
        const u = updates[i];
        if (u === null || u === undefined) byPath.delete(p);
        else byPath.set(p, u);
      });
      return Array.from(byPath.values()).sort((a, b) => b.modified - a.modified);
    });
  }, []);

  // Cold start: set vault on Rust side, scan, subscribe to watcher.
  useEffect(() => {
    if (!vaultPath) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    (async () => {
      await invoke("set_vault", { path: vaultPath });
      if (cancelled) return;
      await rescan();
      if (cancelled) return;
      await invoke("start_watcher", { path: vaultPath }).catch(() => {});
      unlisten = await listen<string[]>("vault-changed", (e) => {
        for (const p of e.payload) pending.current.add(p);
        if (flushTimer.current === undefined) {
          flushTimer.current = window.setTimeout(flushPending, 250);
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (flushTimer.current !== undefined) window.clearTimeout(flushTimer.current);
    };
  }, [vaultPath, rescan, flushPending]);

  const readBody = useCallback(async (path: string): Promise<NoteWithBody> => {
    return invoke<NoteWithBody>("read_note", { path });
  }, []);

  const saveNote = useCallback(async (path: string, body: string, frontmatter: Record<string, any>) => {
    await invoke("save_note", { path, body, frontmatter });
    if (frontmatter?.public) setDirty(d => d + 1);
  }, []);

  // Patch front matter without loading the body on the JS side. Rust reads,
  // patches, writes. Used by the calendar drag-to-move flow.
  const setFrontmatter = useCallback(async (path: string, patch: Record<string, any>) => {
    await invoke<Note>("set_frontmatter", { path, patch });
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
    // Watcher will pick it up; force an immediate flush just in case.
    pending.current.add(path);
    flushPending();
  }, [vaultPath, flushPending]);

  const publish = useCallback(async () => {
    if (!vaultPath) return 0;
    const count = await invoke<number>("publish_public", { vault: vaultPath });
    setDirty(0);
    return count;
  }, [vaultPath]);

  return {
    vaultPath, setVault,
    notes, loading, rescan,
    readBody, saveNote, setFrontmatter, deleteNote, createLogNote,
    dirty, publish,
  };
}
