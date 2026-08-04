import { useEffect } from "react";
import { CardGrid } from "./components/CardGrid";
import {
  applyTextScale,
  getTextScale,
  stepTextScale,
  TEXT_SCALE_STEP,
} from "./lib/text-scale";
import { openExternalUrl, EXTERNAL_SCHEME_RE } from "./lib/open-external";

// Any external link clicked ANYWHERE in the app opens in the user's default
// browser (Safari on iOS), never inside Order's WebView. One document-capture
// listener catches every <a> — note bodies, settings panels, lists — so no
// surface can leak a link into the in-app browser. We listen for click AND
// touchend (iOS taps on anchors inside ProseMirror widgets often never
// escalate to a click) with a short cooldown so desktop's touchend→click pair
// doesn't open twice.
function useExternalLinks(): void {
  useEffect(() => {
    let last = 0;
    const handler = (e: Event) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href") ?? "";
      if (!EXTERNAL_SCHEME_RE.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - last < 600) return;
      last = now;
      openExternalUrl(href);
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("touchend", handler, true);
    return () => {
      document.removeEventListener("click", handler, true);
      document.removeEventListener("touchend", handler, true);
    };
  }, []);
}

// Cmd/Ctrl +/-/0 adjust the note text size, mirroring the rail buttons.
// Scaling is font-size based (see text-scale.ts) so the editor caret
// keeps tracking the pointer.
function useTextZoomShortcuts(): void {
  useEffect(() => {
    applyTextScale(getTextScale()); // restore the persisted size on launch

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        stepTextScale(TEXT_SCALE_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        stepTextScale(-TEXT_SCALE_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        applyTextScale(1);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  useTextZoomShortcuts();
  useExternalLinks();
  return <CardGrid />;
}
