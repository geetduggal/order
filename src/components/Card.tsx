// One Card. Reads ~/Documents/order-test.md (seeding it on first launch),
// renders/edits it through Milkdown Crepe, persists on debounced change
// and on Cmd/Ctrl+S. Width is responsive via CSS; height is intrinsic.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { MilkdownSurface } from "./MilkdownSurface";

const FILENAME = "order-test.md";
const SEED = `# A single card

Write here. **Bold**, *italic*, \`inline code\`, [a link](https://example.com).

- A list item
- Another one
- And a third

1. Ordered too
2. If you want

> Block quote with some thought.

\`\`\`python
def hello():
    print("world")
\`\`\`

That's it.
`;

const SAVE_DEBOUNCE_MS = 600;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; path: string; initial: string }
  | { kind: "error"; message: string };

async function resolveCardPath(): Promise<string> {
  const dir = await documentDir();
  return join(dir, FILENAME);
}

async function loadOrSeed(): Promise<{ path: string; initial: string }> {
  const path = await resolveCardPath();
  try {
    const initial = await invoke<string>("read_text", { path });
    return { path, initial };
  } catch {
    // Treat any read error as "file missing" for the MVP — write the seed
    // and return it as the starting content.
    await invoke("write_text", { path, content: SEED });
    return { path, initial: SEED };
  }
}

export function Card() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const pendingContent = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);

  // Capture the active path in a ref so global handlers (Cmd+S, unmount
  // flush) don't depend on render-time closure of `state`.
  const pathRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadOrSeed()
      .then(({ path, initial }) => {
        if (cancelled) return;
        pathRef.current = path;
        setState({ kind: "ready", path, initial });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: typeof err === "string" ? err : "Failed to load card",
        });
      });
    return () => { cancelled = true; };
  }, []);

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const content = pendingContent.current;
    const path = pathRef.current;
    if (content === null || !path) return;
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
  }, []);

  const handleChange = useCallback((markdown: string) => {
    pendingContent.current = markdown;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushNow();
    }, SAVE_DEBOUNCE_MS);
  }, [flushNow]);

  // Global Cmd/Ctrl+S → flush pending save immediately.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void flushNow();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushNow]);

  // On unmount, flush any pending save synchronously enough to avoid losing
  // the last keystroke. We can't await in a cleanup, so we kick off the
  // write and rely on Tauri's IPC to deliver it before the process exits.
  useEffect(() => {
    return () => { void flushNow(); };
  }, [flushNow]);

  if (state.kind === "loading") {
    return <div className="card-shell"><div className="card-loading">Loading…</div></div>;
  }
  if (state.kind === "error") {
    return (
      <div className="card-shell">
        <article className="order-card">
          <p className="card-error">Couldn't load the card: {state.message}</p>
        </article>
      </div>
    );
  }

  return (
    <div className="card-shell">
      <article className="order-card">
        <MilkdownSurface
          initial={state.initial}
          onChange={handleChange}
          onDone={() => { void flushNow(); }}
        />
        <div className="order-card-status">
          <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
          <span className="order-card-path" title={state.path}>{FILENAME}</span>
        </div>
      </article>
    </div>
  );
}
