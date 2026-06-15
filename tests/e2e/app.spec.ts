// Browser E2E (goals 1a, 1b, 1c, 1f, 1g, 1h). The app runs unmodified
// against a mocked Tauri IPC layer — see helpers.ts. Each interactive
// assertion doubles as the 1h snappiness check: the action must settle
// inside SNAPPY_MS.

import { test, expect, type Page } from "@playwright/test";
import { bootVault, emitTauriEvent, todayIso } from "./helpers";

const SNAPPY_MS = 1000;


test("1a — + from a calendar view creates in the home NF and jumps to it", async ({ page }) => {
  await bootVault(page);
  // Cold boot lands on Week (a calendar view) — + must jump home.
  const t0 = Date.now();
  await page.click(".dock-btn-new");

  // Filter snaps to exactly the home Notable Folder…
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Home Base"]);
  // …and the new note is on screen with the editor focused.
  await page.waitForSelector(".order-card.is-main"); // section centerpiece
  await expect.poll(async () => {
    const files = await page.evaluate(() => Object.keys((window as any).__VAULT__.files));
    return files.filter((f) => f.startsWith("Alpha/Alpha Spaces/Home Base/") && f.endsWith(".md")).length;
  }).toBeGreaterThan(3); // main doc + Standup + Gallery + the new note
  expect(Date.now() - t0, "create+jump is snappy").toBeLessThan(SNAPPY_MS + 500);
});

test("1a — + in the Pile creates in the top-of-pile NF, filters untouched", async ({ page }) => {
  await bootVault(page);
  // Pin Side Quest via the palette — Pile view, pile top = Side Quest.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+o" : "Control+o");
  await page.fill(".cmdk-input", "Side Quest");
  await page.keyboard.press("Enter");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Side Quest"]);

  await page.click(".dock-btn-new");

  // The note lands in Side Quest (Cmd+N semantics: top of the pile),
  // and the filter pile is unchanged.
  await expect.poll(async () => {
    const files = await page.evaluate(() => Object.keys((window as any).__VAULT__.files));
    return files.filter((f) => f.startsWith("Alpha/Alpha Spaces/Side Quest/") && f.endsWith(".md")).length;
  }).toBeGreaterThan(1); // main doc + the new note
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Side Quest"]);
});

test("1b — moving an event to another NF switches filter and jumps", async ({ page }) => {
  await bootVault(page);
  // Default view is Week; the fixture Standup event sits on today.
  const chip = page.locator(".fc-event", { hasText: "Standup" }).first();
  await chip.click();
  await page.waitForSelector(".event-action-menu");

  await page.click(".event-action-folder-chip");
  const t0 = Date.now();
  await page.click(".event-action-folder-option:has-text('Side Quest')");

  // Filter pinned to the destination NF, pile view, note moved on disk.
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Side Quest"]);
  await expect.poll(async () => {
    const files = await page.evaluate(() => Object.keys((window as any).__VAULT__.files));
    return files.some((f) => f.startsWith("Alpha/Alpha Spaces/Side Quest/") && f.includes("Standup"));
  }).toBe(true);
  expect(Date.now() - t0, "folder move is snappy").toBeLessThan(SNAPPY_MS + 500);
});

test("1c — dock toggle: home ⇄ week with no filters", async ({ page }) => {
  await bootVault(page);
  // Cold boot lands on Week with no filters (the "at calendar" state).
  await expect(page.locator(".fc-view-switch")).toBeVisible();

  let t0 = Date.now();
  await page.click(".dock-btn-home");
  // → Home: pile view, single include pill on the home NF.
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Home Base"]);
  expect(Date.now() - t0, "go-home is snappy").toBeLessThan(SNAPPY_MS);

  t0 = Date.now();
  await page.click(".dock-btn-home");
  // → Week again, zero filters.
  await expect(page.locator(".fc-view-switch")).toBeVisible();
  await expect(page.locator(".filter-pill")).toHaveCount(0);
  expect(Date.now() - t0, "back-to-week is snappy").toBeLessThan(SNAPPY_MS);
});

test("list add — plain text becomes a text bullet, not a wikilink", async ({ page }) => {
  await bootVault(page);
  // Pin Side Quest (a list: cards folder) so its main doc renders.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+o" : "Control+o");
  await page.fill(".cmdk-input", "Side Quest");
  await page.keyboard.press("Enter");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Side Quest"]);

  // Open the bottom add tile, type plain text, commit with Enter.
  await page.locator(".basecard-add-text", { hasText: "Add" }).last().click();
  const input = page.locator(".basecard-add-input").last();
  await input.fill("Buy milk");
  await input.press("Enter");

  // Persisted as a plain `- Buy milk` bullet (text item), NOT `- [[Buy milk]]`.
  await expect.poll(async () => {
    const body = await page.evaluate(() =>
      (window as any).__VAULT__.read("Alpha/Alpha Spaces/Side Quest/Side Quest.md") as string);
    return body;
  }).toMatch(/^- Buy milk\s*$/m);
  const body = await page.evaluate(() =>
    (window as any).__VAULT__.read("Alpha/Alpha Spaces/Side Quest/Side Quest.md") as string);
  expect(body).not.toContain("[[Buy milk]]");
});

test("folded — note renders as a spine, click reveals the body", async ({ page }) => {
  await bootVault(page);
  await page.click(".dock-btn-home");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Home Base"]);
  await page.click(".dock-btn-pile-mode"); // show leaf notes

  // The folded note shows its spine (title + "folded" tag), not the body.
  const spine = page.locator(".order-card-spine", { hasText: "Secret Plan" });
  await spine.waitFor();
  await expect(page.locator(".order-card", { hasText: "Secret Plan" }).locator(".ProseMirror")).toHaveCount(0);
  await expect(page.getByText("surprise party details")).toHaveCount(0);

  // Click the spine → the editor mounts and the body shows.
  await spine.click();
  await expect(page.locator(".order-card", { hasText: "Secret Plan" }).locator(".ProseMirror")).toHaveCount(1);
  await expect(page.getByText("surprise party details")).toBeVisible();
});

/** Build a paste event carrying a 1×1 PNG and fire it at the given
 *  editor element (a Playwright locator resolving to a .ProseMirror). */
async function pasteImage(editor: ReturnType<Page["locator"]>): Promise<void> {
  await editor.click();
  await editor.evaluate((target) => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "clipboardData", { value: dt });
    target.dispatchEvent(evt);
  });
}

test("1f — image paste lands in the note's NF directory (Milkdown)", async ({ page }) => {
  await bootVault(page);
  await page.click(".dock-btn-home");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Home Base"]);
  // Home defaults to "Notable folders only" — flip Show to all so the
  // leaf notes (Gallery, Standup) render as cards.
  await page.click(".dock-btn-pile-mode");

  // Paste into the Gallery card's editor.
  const editor = page.locator(".order-card", { hasText: "Gallery" }).locator(".ProseMirror").first();
  await editor.waitFor();
  const t0 = Date.now();
  await pasteImage(editor);

  await expect.poll(async () => {
    const files = await page.evaluate(() => Object.keys((window as any).__VAULT__.files));
    return files.some((f) =>
      f.startsWith("Alpha/Alpha Spaces/Home Base/") && /pasted.*\.png$/i.test(f));
  }, { timeout: 5000 }).toBe(true);
  expect(Date.now() - t0, "paste is snappy").toBeLessThan(SNAPPY_MS + 500);
});

test("1f — image paste appends a card to a list folder", async ({ page }) => {
  await bootVault(page);
  // Pin Side Quest (a list: cards folder) via the command palette.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+o" : "Control+o");
  await page.fill(".cmdk-input", "Side Quest");
  await page.keyboard.press("Enter");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Side Quest"]);

  const editor = page.locator(".order-card.is-main .ProseMirror").first();
  await editor.waitFor();
  await pasteImage(editor);

  // The image file lands in the Side Quest dir AND the main doc body
  // gains an ![[...]] bullet (list-mode paste contract).
  await expect.poll(async () => {
    const v = await page.evaluate(() => (window as any).__VAULT__.files);
    const img = Object.keys(v).some((f) =>
      f.startsWith("Alpha/Alpha Spaces/Side Quest/") && /\.png$/i.test(f));
    const body = v["Alpha/Alpha Spaces/Side Quest/Side Quest.md"] ?? "";
    return img && /!\[\[.*\.png(\|[^\]]*)?\]\]|!\[.*\]\(/.test(body);
  }, { timeout: 5000 }).toBe(true);
});

test("1g — OS file drop imports into the flipped NF folder view", async ({ page }) => {
  await bootVault(page);
  await page.click(".dock-btn-home");
  await expect(page.locator(".filter-pill .filter-pill-name")).toHaveText(["Home Base"]);

  // Flip the Home Base main doc to its file-browser side. The flip
  // affordance is the "Show folder contents" card button; the
  // drag-drop listener mounts with the backside.
  await page.click('.order-card.is-main button[aria-label="Show folder contents"]');

  // Emit the native Tauri event the webview would send for an OS drop
  // and assert the Rust import command fired + the file is listed.
  await emitTauriEvent(page, "tauri://drag-drop", {
    type: "drop",
    paths: ["/tmp/dropped-report.pdf"],
    position: { x: 200, y: 200 },
  });

  await expect.poll(async () => {
    const invoked = await page.evaluate(() => (window as any).__INVOKED as [string, unknown][]);
    return invoked.some(([cmd]) => cmd === "vault_import_files");
  }, { timeout: 3000 }).toBe(true);
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__VAULT__.has("Alpha/Alpha Spaces/Home Base/dropped-report.pdf")),
  ).toBe(true);
});

test("1g — links open through the OS, never in-app", async ({ page }) => {
  await bootVault(page);
  await page.click(".dock-btn-home");
  // Show leaf notes (home defaults to folders-only).
  await page.click(".dock-btn-pile-mode");

  // The Standup note body carries [docs](https://example.com/agenda).
  const link = page.locator(".order-card:has-text('Standup') .ProseMirror a[href*='example.com']").first();
  await link.waitFor({ timeout: 5000 });
  const urlBefore = page.url();
  await link.click();

  await expect.poll(async () =>
    page.evaluate(() => (window as any).__OPENED as { kind: string; value: string }[]),
  ).toContainEqual({ kind: "url", value: "https://example.com/agenda" });
  expect(page.url(), "no in-app navigation").toBe(urlBefore);
});

test("1e (live) — calendar chips agree with todo.txt when enabled", async ({ page }) => {
  await bootVault(page, { todoTxt: true });
  const today = todayIso();

  // Both the .md-backed Standup and the native todo.txt line render.
  await expect(page.locator(".fc-event", { hasText: "Standup" })).toHaveCount(1);
  await expect(page.locator(".fc-event", { hasText: "Native line only" })).toHaveCount(1);

  // After load, the sync has run: todo.txt still holds both lines for
  // today (mirror + native), nothing duplicated.
  const body = await page.evaluate(() =>
    (window as any).__VAULT__.read("todo.txt") as string);
  const todayLines = body.split("\n").filter((l) => l.includes(today));
  expect(todayLines.length).toBe(2);

  // todo.txt lines carry no public flag — under the "Public only"
  // lens they are private and every todo-backed chip disappears.
  await page.click(".dock-btn-settings");
  await page.click(".dock-tools-item:has-text('Public + private')");
  await expect(page.locator(".fc-event", { hasText: "Native line only" })).toHaveCount(0);
});
