import { defineConfig } from "@playwright/test";

// E2E suite: boots the Vite dev server on a dedicated port (1421 so a
// concurrently running `pnpm tauri dev` on 1420 is unaffected) and runs
// the app in Chromium with a mocked Tauri IPC layer (tests/e2e/helpers.ts).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: "http://localhost:1421",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "pnpm exec vite --port 1421 --strictPort",
    url: "http://localhost:1421",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
