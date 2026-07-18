import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSystemThemeWatch } from "./lib/theme";
import "./styles.css";
import { initIosImageLoader } from "./lib/ios-images";

// Follow OS light/dark live while the theme preference is "auto" (the default).
initSystemThemeWatch();
// iOS: load attachment images over IPC (the vaultasset:// scheme doesn't reach
// <img> in WKWebView). No-op on desktop.
void initIosImageLoader();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
