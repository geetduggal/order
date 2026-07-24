// Run: npx tsx src/lib/jd-next-id.test.ts  → "ALL CHECKS PASS"
import { nextJdFolderId, categoryJdNumber, assignMissingJdIds } from "./johnny-decimal";
import type { SpaceNode } from "./spacetime";

let failed = 0;
function eq<T>(a: T, e: T, label: string) {
  if (JSON.stringify(a) === JSON.stringify(e)) console.log(`ok: ${label}`);
  else { failed++; console.error(`FAIL: ${label}\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(e)}`); }
}

// categoryJdNumber
eq(categoryJdNumber("52 Creative Projects"), "52", "cat number 52");
eq(categoryJdNumber("11 Selfish Projects"), "11", "cat number 11");
eq(categoryJdNumber("Creative Projects"), null, "no number → null");
eq(categoryJdNumber("10-19 Creative"), null, "area range is not a category number");

// nextJdFolderId — highest existing NN + 1
eq(nextJdFolderId("52 Creative Projects", ["52.01 A", "52.03 B", "52.02 C"]), "52.04", "next after 03");
eq(nextJdFolderId("52 Creative Projects", []), "52.01", "empty category → .01");
eq(nextJdFolderId("52 Creative Projects", ["Unprefixed", "52.09 X"]), "52.10", "ignores unprefixed sibling");
eq(nextJdFolderId("Creative Projects", ["Foo"]), null, "un-numbered category → null");
eq(nextJdFolderId("11 Selfish Projects", ["11.01 A", "11.14 B"]), "11.15", "gap-aware: max+1 not count+1");

// assignMissingJdIds — only touches un-numbered folders, keeps existing ids
{
  const f = (n: string): SpaceNode => ({ name: n, children: [] });
  const space: SpaceNode[] = [
    { name: "50-59 Creative", children: [
      { name: "52 Creative Projects", children: [f("52.01 Kept"), f("Brand New Article"), f("52.05 Also Kept")] },
      { name: "Uncategorized", children: [f("No Number Cat Folder")] }, // category not numbered → skip
    ] },
  ];
  const out = assignMissingJdIds(space);
  eq(out.length, 1, "one folder assigned (only the un-numbered, numbered category)");
  eq(out[0]?.oldName, "Brand New Article", "  target folder");
  eq(out[0]?.newName, "52.06 Brand New Article", "  next id = max(05)+1");
  eq(out[0]?.category, "52 Creative Projects", "  category");
}

if (failed) { console.error(`\n${failed} FAILURES`); process.exit(1); }
else console.log("\nALL CHECKS PASS");
