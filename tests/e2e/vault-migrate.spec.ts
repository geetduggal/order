// Unit tests for the vault migration planner — pure functions, no I/O.
import {
  isEventNote, isChainIndex, stripEventFrontmatter, planVaultMigration,
} from "../../src/lib/vault-migrate";
import assert from "node:assert";

// ---- isEventNote ----

assert(isEventNote(
  { date: "2026-06-15", startTime: "09:00", allDay: false, folder: "[[Geet Duggal]]" },
  "2026-06-15 Standup.md",
), "isEventNote: timed event");

assert(isEventNote(
  { date: "2026-06-15", allDay: true, folder: "[[Order]]", title: "Ship day" },
  "2026-06-15 Ship day.md",
), "isEventNote: all-day event");

assert(!isEventNote({ role: "areas", list: "cards" }, "Areas.md"), "isEventNote: skip Areas.md");
assert(!isEventNote({ role: "seasons" }, "Seasons.md"), "isEventNote: skip Seasons.md");
assert(!isEventNote({ list: "cards" }, "Craft.md"), "isEventNote: skip list index");
assert(!isEventNote({ category: "Projects" }, "Order.md"), "isEventNote: skip NF main doc");
assert(!isEventNote({}, "spacetime.yml"), "isEventNote: skip spacetime.yml");

// ---- isChainIndex ----

assert(isChainIndex({ role: "areas" }, "Areas.md"), "isChainIndex: role:areas");
assert(isChainIndex({ list: "cards" }, "Craft.md"), "isChainIndex: category index");
assert(isChainIndex({ role: "seasons" }, "Seasons.md"), "isChainIndex: seasons");
assert(!isChainIndex({ category: "Projects" }, "Order.md"), "isChainIndex: NF main doc is NOT a chain index");
assert(!isChainIndex({ date: "2026-06-15", allDay: true }, "2026-06-15 Note.md"), "isChainIndex: event note");

// ---- stripEventFrontmatter ----

const withFm = "---\ndate: \"2026-06-15\"\nstartTime: \"09:00\"\nallDay: false\nfolder: \"[[Order]]\"\ntitle: Standup\n---\n# Standup\n\nsome content\n";
const stripped = stripEventFrontmatter(withFm);
assert(!stripped.includes("date:"), "strip: date removed");
assert(!stripped.includes("startTime:"), "strip: startTime removed");
assert(!stripped.includes("folder:"), "strip: folder removed");
assert(!stripped.includes("title:"), "strip: title removed");
assert(stripped.includes("# Standup"), "strip: body preserved");
assert(stripped.includes("some content"), "strip: body content preserved");
// Should have no frontmatter block when nothing is left
assert(!stripped.startsWith("---"), "strip: no empty frontmatter");

// Note with non-event frontmatter retained
const withExtra = "---\ndate: \"2026-06-15\"\nallDay: true\nfolder: \"[[Order]]\"\npublic: true\n---\nbody\n";
const strippedExtra = stripEventFrontmatter(withExtra);
assert(strippedExtra.includes("public: true"), "strip: non-event keys kept");
assert(!strippedExtra.includes("date:"), "strip: date removed with extras");

// ---- planVaultMigration ----

const notes = [
  {
    path: "Areas.md",
    filename: "Areas.md",
    frontmatter: { role: "areas", list: "cards" } as Record<string, unknown>,
    body: "# Areas\n",
    raw: "---\nrole: areas\nlist: cards\n---\n# Areas\n",
  },
  {
    path: "Creative/Creative Projects/Order/2026-06-15 Standup.md",
    filename: "2026-06-15 Standup.md",
    frontmatter: { date: "2026-06-15", startTime: "09:00", allDay: false, folder: "[[Order]]", title: "Standup" } as Record<string, unknown>,
    body: "# Standup\n\nsome content\n",
    raw: "---\ndate: \"2026-06-15\"\nstartTime: \"09:00\"\nallDay: false\nfolder: \"[[Order]]\"\ntitle: Standup\n---\n# Standup\n\nsome content\n",
  },
  {
    path: "Creative/Creative Projects/Order/Order.md",
    filename: "Order.md",
    frontmatter: { category: "Creative Projects" } as Record<string, unknown>,
    body: "# Order\n",
    raw: "---\ncategory: Creative Projects\n---\n# Order\n",
  },
];

const actions = planVaultMigration(notes as Parameters<typeof planVaultMigration>[0]);
assert.equal(actions.length, 2, "plan: 2 actions (archive + strip)");

const archive = actions.find((a) => a.kind === "archiveChainFile");
assert(archive, "plan: archive action");
assert.equal(archive?.path, "Areas.md", "plan: archive source");
assert(archive?.archivePath.startsWith(".order-legacy/chain/"), "plan: archive dest");

const strip = actions.find((a) => a.kind === "stripFrontmatter");
assert(strip, "plan: strip action");
assert.equal(strip?.path, "Creative/Creative Projects/Order/2026-06-15 Standup.md", "plan: strip path");
assert(!strip?.newContent.includes("date:"), "plan: stripped content has no date");
assert(strip?.newContent.includes("# Standup"), "plan: stripped content has body");

// NF main doc (Order.md with category:) should NOT be in actions
assert(!actions.some((a) => a.path === "Creative/Creative Projects/Order/Order.md"), "plan: NF main doc not touched");

console.log("ALL PASS — vault-migrate");
