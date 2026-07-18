// Drawing surface: a note flipped to `view: drawing`, backed by Excalidraw and
// persisted to the `<Base>.excalidraw` sidecar (standard Excalidraw JSON).
//
// Heavy dependency — Card lazy-loads this module so the normal note-editing
// path never pays for it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, serializeAsJSON, restore } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

interface DrawingSurfaceProps {
  /** Raw `.excalidraw` JSON (empty string for a new drawing). */
  initial: string;
  /** Persist serialized scene JSON. */
  onChange: (json: string) => void;
  readOnly?: boolean;
  /** Card view (false) shows the drawing minimally — no Excalidraw toolbars,
   *  view-only, centered on the content. Fullscreen (true) is the full editor.
   *  Also drives the re-fit-to-content when the container resizes. */
  fullscreen?: boolean;
}

// Order has many themes; Excalidraw only knows light/dark. Map the dark-ish
// ones to "dark", everything else to "light".
const DARK_THEMES = new Set(["dark", "black", "terminal", "wordperfect", "lcars"]);
function currentExcalidrawTheme(): "light" | "dark" {
  const t = document.documentElement.dataset.theme ?? "light";
  return DARK_THEMES.has(t) ? "dark" : "light";
}

export function DrawingSurface({ initial, onChange, readOnly, fullscreen }: DrawingSurfaceProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentExcalidrawTheme);
  // Card view = minimal, view-only preview centered on the drawing; only
  // fullscreen shows the full editor + toolbars.
  const viewMode = !fullscreen;

  // Re-fit to content whenever the view/size changes (fullscreen toggle, or
  // switching into the minimal card view) — Excalidraw keeps its scroll offset
  // across resizes, which would otherwise leave the drawing off-screen. Skip
  // the first run (initial mount already centers).
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) { firstFit.current = false; return; }
    const api = apiRef.current;
    if (!api) return;
    const id = setTimeout(() => {
      try {
        api.refresh();
        api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false });
      } catch { /* API may not be ready — ignore */ }
    }, 80);
    return () => clearTimeout(id);
  }, [fullscreen]);

  // Follow Order's theme toggle.
  useEffect(() => {
    const sync = () => setTheme(currentExcalidrawTheme());
    window.addEventListener("order:theme", sync);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", sync);
    return () => {
      window.removeEventListener("order:theme", sync);
      mq?.removeEventListener?.("change", sync);
    };
  }, []);

  // Parse the sidecar once into normalized initial data.
  const initialData = useRef(
    (() => {
      try {
        const parsed = initial.trim() ? JSON.parse(initial) : null;
        const r = restore(parsed ?? { elements: [], appState: {} }, null, null);
        return { elements: r.elements, appState: { ...r.appState, collaborators: undefined }, files: r.files };
      } catch {
        return { elements: [], appState: {}, files: {} };
      }
    })(),
  ).current;

  // Excalidraw fires onChange on every pointer move — debounce hard, and only
  // persist when the scene actually changed (ignore pure selection/scroll).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastJson = useRef<string>(initial);
  const handleChange = useCallback((elements: readonly unknown[], appState: unknown, files: unknown) => {
    if (readOnly) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = serializeAsJSON(elements as any, appState as any, files as any, "local");
      if (json === lastJson.current) return;
      lastJson.current = json;
      onChange(json);
    }, 700);
  }, [onChange, readOnly]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  return (
    <div className={"order-drawing-surface" + (viewMode ? " is-preview" : "")}>
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api; }}
        initialData={initialData}
        onChange={handleChange}
        theme={theme}
        // Card view is view-only (a clean, centered preview); editing — moving
        // shapes, text — happens only in fullscreen.
        viewModeEnabled={readOnly || viewMode}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
    </div>
  );
}
