// noteTitle: the authoritative, clean title for a note. Frontmatter
// title wins; an image-first body becomes a clean basename, never a URL.

import { test, expect } from "@playwright/test";
import { noteTitle, imageLineTitle } from "../../src/lib/frontmatter";

test("noteTitle — frontmatter title wins", () => {
  expect(noteTitle({ title: "My Event" }, "# Something else\n", "2026-06-17 x")).toBe("My Event");
});

test("noteTitle — image-first body becomes a clean basename, not a URL", () => {
  const body = "![1.00](vaultasset://localhost/Craft/Craft%20Projects/Order/image-2026-06-16-1925.png)\n";
  expect(noteTitle({}, body, "2026-06-16 whatever")).toBe("image-2026-06-16-1925");
});

test("noteTitle — obsidian image embed too", () => {
  expect(imageLineTitle("![[image-2026-06-16-1925.png]]")).toBe("image-2026-06-16-1925");
  expect(imageLineTitle("![[photo.jpg|320]]")).toBe("photo");
});

test("noteTitle — plain H1 body", () => {
  expect(noteTitle({}, "# Quarterly review\nbody\n", "2026-01-01 q")).toBe("Quarterly review");
});

test("noteTitle — falls back to filename minus date prefix", () => {
  expect(noteTitle({}, "", "2026-06-17 Test")).toBe("Test");
});

test("noteTitle — a non-image line is not mistaken for one", () => {
  expect(imageLineTitle("Just some text")).toBeNull();
  expect(imageLineTitle("See ![icon](x.png) inline")).toBeNull(); // not a lone image
});
