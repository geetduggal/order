import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, rmSync } from "node:fs";

// Copy Excalidraw's bundled fonts into public/ so they ship with the app and
// drawings render offline (EXCALIDRAW_ASSET_PATH="/" points here). public/fonts
// is gitignored — this repopulates it on every dev/build start.
function excalidrawFonts() {
  return {
    name: "excalidraw-fonts",
    buildStart() {
      const src = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
      const dest = "public/fonts";
      if (!existsSync(src)) return;
      rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true });
    },
  };
}

// Tauri expects a fixed port and exposes its host on TAURI_DEV_HOST for mobile.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  clearScreen: false,
  // Excalidraw reads these at bundle time; without them Vite leaves bare
  // `process.env` references that throw in the browser.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  optimizeDeps: {
    // Pre-bundle the heavy editors so first flip isn't a long cold compile.
    include: ["react-spreadsheet", "@excalidraw/excalidraw"],
  },
  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
