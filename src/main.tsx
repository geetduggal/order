import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSystemThemeWatch } from "./lib/theme";
import "./styles.css";

// Serve Excalidraw's fonts from the app itself (copied to public/fonts by the
// excalidraw-fonts Vite plugin) instead of its default CDN — so drawings work
// offline. Must be set before Excalidraw loads any font.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/";

// Follow OS light/dark live while the theme preference is "auto" (the default).
initSystemThemeWatch();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
