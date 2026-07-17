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
}

// Order has many themes; Excalidraw only knows light/dark. Map the dark-ish
// ones to "dark", everything else to "light".
const DARK_THEMES = new Set(["dark", "black", "terminal", "wordperfect", "lcars"]);
function currentExcalidrawTheme(): "light" | "dark" {
  const t = document.documentElement.dataset.theme ?? "light";
  return DARK_THEMES.has(t) ? "dark" : "light";
}

export function DrawingSurface({ initial, onChange, readOnly }: DrawingSurfaceProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentExcalidrawTheme);

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
    <div className="order-drawing-surface">
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api; }}
        initialData={initialData}
        onChange={handleChange}
        theme={theme}
        viewModeEnabled={readOnly}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
    </div>
  );
}
