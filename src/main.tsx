import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSystemThemeWatch } from "./lib/theme";
import "./styles.css";

// Follow OS light/dark live while the theme preference is "auto" (the default).
initSystemThemeWatch();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
