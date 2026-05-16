// One Card. Reads its file (seeding on first launch), renders/edits it
// through Milkdown Crepe on the same surface, persists on debounced change
// + Cmd/Ctrl+S + unmount. The CardGrid owns layout / responsiveness.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MilkdownSurface } from "./MilkdownSurface";

const SAVE_DEBOUNCE_MS = 600;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; initial: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
  seed: string;
}

async function loadOrSeed(path: string, seed: string): Promise<string> {
  try {
    return await invoke<string>("read_text", { path });
  } catch {
    await invoke("write_text", { path, content: seed });
    return seed;
  }
}

export function Card({ path, seed }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const pendingContent = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadOrSeed(path, seed)
      .then((initial) => {
        if (cancelled) return;
        setState({ kind: "ready", initial });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: typeof err === "string" ? err : "Failed to load card",
        });
      });
    return () => { cancelled = true; };
  }, [path, seed]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const content = pendingContent.current;
    if (content === null) return;
    pendingContent.current = null;
    inflight.current += 1;
    setSaving(true);
    try {
      await invoke("write_text", { path, content });
    } catch (err) {
      console.error("write_text failed:", err);
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setSaving(false);
    }
  }, [path]);

  const handleChange = useCallback((markdown: string) => {
    pendingContent.current = markdown;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow]);

  // On unmount, flush any pending save synchronously enough to avoid losing
  // the last keystroke. Tauri's IPC will deliver before the process exits.
  useEffect(() => {
    return () => { void flushNow(); };
  }, [flushNow]);

  const filename = path.split("/").pop() ?? path;

  if (state.kind === "loading") {
    return <article className="order-card is-loading"><div className="card-loading">Loading…</div></article>;
  }
  if (state.kind === "error") {
    return (
      <article className="order-card">
        <p className="card-error">Couldn't load {filename}: {state.message}</p>
      </article>
    );
  }

  return (
    <article className="order-card">
      <MilkdownSurface
        initial={state.initial}
        onChange={handleChange}
        onDone={() => { void flushNow(); }}
      />
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
        <span className="order-card-path" title={path}>{filename}</span>
      </div>
    </article>
  );
}
