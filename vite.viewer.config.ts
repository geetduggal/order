import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Second Vite config: builds the read-only published-site bundle from
// src-viewer/. Output lands in dist-viewer/. The Rust publish_site
// command reads from there, copies into the target GitHub repo, and
// writes a sibling data.json that the viewer fetches at runtime.

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "src-viewer"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist-viewer"),
    emptyOutDir: true,
    // The viewer is one HTML + one bundle; no need for nested chunks
    // that complicate the GitHub Pages copy.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
