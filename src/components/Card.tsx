// One Card. Reads its file, strips frontmatter, hands the body to Milkdown
// Crepe, recombines on save. Frontmatter normalization (seed, auto-inject
// calendar metadata) happens once in CardGrid before the Card ever
// mounts. On save we re-read the file's frontmatter so any out-of-band
// changes (e.g. a drag in the Week view) don't get clobbered.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { dirname, join } from "@tauri-apps/api/path";
import { MilkdownSurface } from "./MilkdownSurface";
import { isoDate, isoTime, joinFrontmatter, splitFrontmatter } from "../lib/frontmatter";

const ATTACHMENTS_DIR = "attachments";

function attachmentName(file: File): string {
  // Strip path components, normalize extension. If the file has no name
  // (paste from screenshot tool usually does), use the mime type to guess.
  const baseName = (file.name || "image").split(/[/\\]/).pop() ?? "image";
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extFromName = dot > 0 ? baseName.slice(dot + 1).toLowerCase() : null;
  const extFromMime = file.type.startsWith("image/") ? file.type.slice("image/".length) : null;
  const ext = (extFromName || extFromMime || "png").replace(/[^a-z0-9]/g, "");
  const stamp = `${isoDate()}-${isoTime().replace(":", "")}`;
  return `${stem}-${stamp}.${ext}`;
}

const SAVE_DEBOUNCE_MS = 600;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; body: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
}

export function Card({ path }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const pendingBody = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("read_text", { path })
      .then((raw) => {
        if (cancelled) return;
        const { body } = splitFrontmatter(raw);
        setState({ kind: "ready", body });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: typeof err === "string" ? err : "Failed to load card",
        });
      });
    return () => { cancelled = true; };
  }, [path]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const body = pendingBody.current;
    if (body === null) return;
    pendingBody.current = null;
    inflight.current += 1;
    setSaving(true);
    try {
      // Re-read latest frontmatter so out-of-band edits (Week view drag)
      // are preserved when we write our body.
      const current = await invoke<string>("read_text", { path });
      const { frontmatter } = splitFrontmatter(current);
      const content = joinFrontmatter(frontmatter, body);
      await invoke("write_text", { path, content });
    } catch (err) {
      console.error("write_text failed:", err);
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setSaving(false);
    }
  }, [path]);

  const handleChange = useCallback((markdown: string) => {
    pendingBody.current = markdown;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow]);

  const handleImageUpload = useCallback(async (file: File): Promise<string> => {
    const dir = await dirname(path);
    const filename = attachmentName(file);
    const absolute = await join(dir, ATTACHMENTS_DIR, filename);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await invoke("write_binary", { path: absolute, data: Array.from(bytes) });
    return convertFileSrc(absolute);
  }, [path]);

  useEffect(() => { return () => { void flushNow(); }; }, [flushNow]);

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
        initial={state.body}
        onChange={handleChange}
        onDone={() => { void flushNow(); }}
        onImageUpload={handleImageUpload}
      />
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
        <span className="order-card-path" title={path}>{filename}</span>
      </div>
    </article>
  );
}
