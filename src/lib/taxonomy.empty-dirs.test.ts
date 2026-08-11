// Run: npx tsx src/lib/taxonomy.empty-dirs.test.ts  → "ALL CHECKS PASS"
// Decoupled model: the taxonomy is the directory tree, INCLUDING empty
// Area/Category/Notable-Folder directories that hold no note yet (a freshly
// created Area). taxonomyFromPaths takes the note paths plus a list of all
// directories and unions them.
import { taxonomyFromPaths, buildVaultTaxonomy } from "./taxonomy";

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) { console.log("  ok:", label); }
  else { console.error("  FAIL:", label); failed = 1; }
}

// A vault with one populated Area/Category/NF (via a note) and, separately,
// an EMPTY Area and an EMPTY Category that exist only as directories.
const notes = [
  { filename: "Standup.md", body: "", frontmatter: {}, path: "40-49 Stewardship/43 Spaces/43.10 Log/Standup.md" },
];
const dirs = [
  "40-49 Stewardship",
  "40-49 Stewardship/43 Spaces",
  "40-49 Stewardship/43 Spaces/43.10 Log",
  "70-79 Health",                 // empty Area (no note, no category)
  "40-49 Stewardship/44 Empty Cat", // empty Category under a populated Area
];
// (Dotdirs / Attachments are filtered out in Rust's vault_list_dirs before they
//  ever reach here, so taxonomyFromPaths trusts its dirs input.)

const tax = taxonomyFromPaths(notes, dirs);
const areaRefs = tax.areas.map((a) => a.ref);
check(areaRefs.includes("40-49 Stewardship"), "populated area present");
check(areaRefs.includes("70-79 Health"), "EMPTY area present");

const stew = tax.areas.find((a) => a.ref === "40-49 Stewardship")!;
const stewCats = stew.categories.map((c) => c.ref);
check(stewCats.includes("43 Spaces"), "populated category present");
check(stewCats.includes("44 Empty Cat"), "EMPTY category present");

const log = stew.categories.find((c) => c.ref === "43 Spaces")!;
check(log.folders.includes("43.10 Log"), "notable folder present");

// JD numeric ordering: 43 before 44, 40-49 before 70-79.
check(stewCats.indexOf("43 Spaces") < stewCats.indexOf("44 Empty Cat"), "categories JD-ordered");
check(areaRefs.indexOf("40-49 Stewardship") < areaRefs.indexOf("70-79 Health"), "areas JD-ordered");

// buildVaultTaxonomy should prefer the physical tree (it has areas) even with dirs.
const built = buildVaultTaxonomy(
  notes.map((n) => ({ filename: n.filename, body: n.body, frontmatter: n.frontmatter, path: n.path })),
  undefined,
  dirs,
);
check(built.areas.some((a) => a.ref === "70-79 Health"), "buildVaultTaxonomy surfaces empty area");

// No dirs → behaves exactly like before (note-only derivation).
const noDirs = taxonomyFromPaths(notes);
check(noDirs.areas.length === 1 && noDirs.areas[0].ref === "40-49 Stewardship", "empty dirs arg is backward-compatible");

if (failed) { console.error("SOME CHECKS FAILED"); process.exit(1); }
console.log("ALL CHECKS PASS");
