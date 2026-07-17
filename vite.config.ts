import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and exposes its host on TAURI_DEV_HOST for mobile.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
