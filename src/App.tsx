import { useEffect } from "react";
import { CardGrid } from "./components/CardGrid";
import {
  applyTextScale,
  getTextScale,
  stepTextScale,
  TEXT_SCALE_STEP,
} from "./lib/text-scale";

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
  return <CardGrid />;
}
