// One Card. Reads its file (seeding on first launch), strips frontmatter,
// renders/edits the body through Milkdown Crepe, recombines on save.
// If the loaded note has no h1 and no `date` in YAML, calendar-ready
// metadata (Obsidian Full Calendar format) is injected and written back.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MilkdownSurface } from "./MilkdownSurface";
import {
  joinFrontmatter,
  splitFrontmatter,
  suggestCalendarPatch,
  type Frontmatter,
} from "../lib/frontmatter";

const SAVE_DEBOUNCE_MS = 600;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; body: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
  seed: string;
}

/** Result of loading + normalizing a note: the body to hand to the editor,
 *  the frontmatter to preserve for save round-trip. If the file was
 *  missing it gets seeded; if it was a non-h1 note without a `date`, the
 *  calendar metadata is injected and persisted before this resolves. */
async function loadAndNormalize(
  path: string,
  seed: string,
): Promise<{ body: string; frontmatter: Frontmatter }> {
  let raw: string;
  try {
    raw = await invoke<string>("read_text", { path });
  } catch {
    await invoke("write_text", { path, content: seed });
    raw = seed;
  }

  const split = splitFrontmatter(raw);
  let frontmatter = split.frontmatter;
  const body = split.body;

  const patch = suggestCalendarPatch(frontmatter, body);
  if (patch) {
    frontmatter = { ...frontmatter, ...patch };
    const next = joinFrontmatter(frontmatter, body);
    try {
      await invoke("write_text", { path, content: next });
    } catch (err) {
      console.warn("Failed to inject calendar metadata into", path, err);
    }
  }
  return { body, frontmatter };
}

export function Card({ path, seed }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const frontmatterRef = useRef<Frontmatter>({});
  const pendingBody = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadAndNormalize(path, seed)
      .then(({ body, frontmatter }) => {
        if (cancelled) return;
        frontmatterRef.current = frontmatter;
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
  }, [path, seed]);

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
      const content = joinFrontmatter(frontmatterRef.current, body);
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
      />
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
        <span className="order-card-path" title={path}>{filename}</span>
      </div>
    </article>
  );
}
