// Verify sortByBase produces identical orderings on the two shapes
// that desktop and the published web viewer actually see:
//   - Desktop: js-yaml parses unquoted ISO datetimes as JS Date objects.
//     Quoted dates stay as strings. So `published` may be Date OR string
//     depending on YAML quoting.
//   - Web viewer: data.json is JSON-parsed. Every Date that went through
//     JSON.stringify came back as an ISO string. So `published` is always
//     a string.
//
// The fix in normalizeSortKey treats date-looking values (Date instances,
// "YYYY-MM-DD" strings, full ISO datetimes) as the same epoch ms. This
// test feeds both shapes of the SAME logical vault and asserts the
// rendered refs come back in the same order.

import { sortByBase, matchNotes } from "./list-merge";
import type { ParsedBase } from "./list-base";
import type { ListNoteRef } from "./list-folder";

type Sample = { ref: string; publishedIso: string };

const SAMPLES: Sample[] = [
  { ref: "A", publishedIso: "2024-12-30T08:00:00.000Z" },
  { ref: "B", publishedIso: "2025-01-15T00:00:00.000Z" },
  { ref: "C", publishedIso: "2024-06-01T00:00:00.000Z" },
  { ref: "D", publishedIso: "2023-11-04T12:00:00.000Z" },
  { ref: "E", publishedIso: "2024-12-30T08:00:00.000Z" }, // tie with A
  { ref: "F-no-date", publishedIso: "" },                  // missing -> end
  { ref: "G-no-date", publishedIso: "" },                  // missing -> end
  { ref: "H-junk", publishedIso: "Unknown" },              // non-date string -> end
  { ref: "I-junk", publishedIso: "TBD" },                  // non-date string -> end
];

// Shape produced by js-yaml on the desktop. Plain date strings stay
// strings (quoted YAML); ISO datetimes typically parse as Date. Mix
// the two so the comparator sees both types in one list.
function desktopNotes(): ListNoteRef[] {
  return SAMPLES.map((s, i) => ({
    filename: `${s.ref}.md`,
    body: "",
    dir: "Readwise/Full Document Contents/Articles",
    folder: "Articles",
    frontmatter: {
      title: s.ref,
      // Half via Date instance (unquoted YAML), half via string
      // (quoted YAML) so the comparator sees both shapes per run.
      published: s.publishedIso
        ? (i % 2 === 0 ? new Date(s.publishedIso) : s.publishedIso)
        : (i % 2 === 0 ? null : ""),
      type: "articles",
    },
  }));
}

// Shape produced by the viewer after JSON round-trip. All Dates have
// been serialized to ISO strings.
function webNotes(): ListNoteRef[] {
  return SAMPLES.map((s) => ({
    filename: `${s.ref}.md`,
    body: "",
    dir: "Readwise/Full Document Contents/Articles",
    folder: "Articles",
    frontmatter: {
      title: s.ref,
      published: s.publishedIso || "",
      type: "articles",
    },
  }));
}

const BASE: ParsedBase = {
  outerFilters: {
    and: [
      { kind: "contains", prop: "file.folder", needle: "Full Document Contents" },
      { or: [{ kind: "contains", prop: "type", needle: "article" }] },
    ],
  },
  view: {
    type: "cards",
    name: "Recent",
    sort: { prop: "published", dir: "desc" },
  },
  unsupported: [],
};

function order(notes: ListNoteRef[]): string[] {
  const matched = matchNotes(BASE, notes);
  const sorted = sortByBase(BASE, matched);
  return sorted.map((n) => n.filename.replace(/\.md$/i, ""));
}

function assertEq(a: string[], b: string[], label: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) {
    console.error(`FAIL: ${label}`);
    console.error(`  desktop: ${ja}`);
    console.error(`  web:     ${jb}`);
    process.exit(1);
  }
}

const desktopOrder = order(desktopNotes());
const webOrder = order(webNotes());

console.log("desktop:", desktopOrder);
console.log("web:    ", webOrder);

assertEq(desktopOrder, webOrder, "desktop vs web sort agree");

// Sanity asserts on what the order should be, given the fixture:
const expected = [
  "B",         // 2025-01-15 (newest)
  "A", "E",    // 2024-12-30 tie -> alphabetical: A then E
  "C",         // 2024-06-01
  "D",         // 2023-11-04
  // Missing-or-junk bucket at the end, alphabetical by ref/title.
  // "F-no-date" < "G-no-date" < "H-junk" < "I-junk".
  "F-no-date",
  "G-no-date",
  "H-junk",
  "I-junk",
];
assertEq(desktopOrder, expected, "desktop matches expected canonical order");
assertEq(webOrder, expected, "web matches expected canonical order");

// Tiebreak appendix should be stable across direction too.
const ascBase: ParsedBase = {
  ...BASE,
  view: { ...BASE.view, sort: { prop: "published", dir: "asc" } },
};
const ascDesktop = (() => {
  const matched = matchNotes(ascBase, desktopNotes());
  return sortByBase(ascBase, matched).map((n) => n.filename.replace(/\.md$/i, ""));
})();
const ascWeb = (() => {
  const matched = matchNotes(ascBase, webNotes());
  return sortByBase(ascBase, matched).map((n) => n.filename.replace(/\.md$/i, ""));
})();
assertEq(ascDesktop, ascWeb, "asc desktop vs web sort agree");
// In asc order, missing-key bucket still goes to the END (not the
// beginning) — that's the contract.
const ascExpected = [
  "D", "C", "A", "E", "B",                                  // oldest first
  "F-no-date", "G-no-date", "H-junk", "I-junk",             // missing+junk at end
];
assertEq(ascDesktop, ascExpected, "asc desktop matches expected");

console.log("ALL CHECKS PASS");
