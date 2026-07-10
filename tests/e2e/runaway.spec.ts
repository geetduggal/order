// Regression: an external change to a manual list-folder note must not
// duplicate its bullets. The card's editor holds prose only; the external
// reload used to push the raw body (prose + bullets) into Milkdown, whose
// change event marked the card dirty. The next save wrote
// `editorBody + serializeListItems(items)` — one extra copy of every
// bullet per watcher event, unbounded (Geet Duggal.md hit 1102 copies).

import { test, expect } from "@playwright/test";
import { bootVault, emitTauriEvent } from "./helpers";

const MAIN = `---
list: cards
---
# Geet Duggal

Some prose.

* [[Articles]] · Mostly posts on Medium
* [[Tools]] · Useful-to-me bits of code I made
`;

const SPACETIME = `# Space

## Creative
- Creative Spaces
  - Geet Duggal
  - Articles
  - Tools
`;

const DIR = "Creative/Creative Spaces/Geet Duggal";
const MAIN_PATH = `${DIR}/Geet Duggal.md`;

test("external change to a list folder doesn't duplicate its bullets", async ({ page }) => {
  test.setTimeout(120_000);
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [MAIN_PATH]: MAIN,
      "Creative/Creative Spaces/Articles/Articles.md": "# Articles\n",
      "Creative/Creative Spaces/Tools/Tools.md": "# Tools\n",
    },
  });

  // Sidebar opens at area level: drill Area → Category → Notable Folder.
  // (Area/category tiles carry data-tile-ref but not the .sb-folder-li class.)
  for (const ref of ["Creative", "Creative Spaces", "Geet Duggal"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(500);
  }
  await expect(page.locator(".order-card").first()).toBeVisible({ timeout: 15_000 });

  const bulletCount = () =>
    page.evaluate((rel) => {
      const body = (window as any).__VAULT__.read(rel) as string | undefined;
      return (body?.match(/^\s*[-*+]\s+\[\[/gm) ?? []).length;
    }, MAIN_PATH);

  expect(await bulletCount()).toBe(2);

  // Five external-change events, exactly what the watcher delivers when
  // Dropbox/iCloud touches the file.
  for (let i = 0; i < 5; i++) {
    await emitTauriEvent(page, "vault-changed", [`/Vault/${MAIN_PATH}`]);
    await page.waitForTimeout(1_500);
  }
  await page.waitForTimeout(3_000);

  expect(await bulletCount()).toBe(2);
});
