// Run: npx tsx src/lib/johnny-decimal.test.ts  → "ALL CHECKS PASS"
import { applyJohnnyDecimal, isJohnnyDecimalName, stripJdPrefix } from "./johnny-decimal";
import type { SpaceNode } from "./spacetime";

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.error(`FAIL: ${label}`); }
}
function eq<T>(actual: T, expected: T, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)})`);
}

const space = (): SpaceNode[] => [
  {
    name: "Self-Care",
    children: [
      { name: "Selfish Projects", children: [{ name: "Living Room Refresh", children: [] }] },
      { name: "Selfish Spaces", children: [{ name: "Books", children: [] }, { name: "Reference Shelf", children: [] }] },
    ],
  },
  {
    name: "Craft",
    children: [
      { name: "Craft Projects", children: [{ name: "Map Pipeline v2", children: [] }] },
    ],
  },
];

// ---- detection + stripping ----
check(isJohnnyDecimalName("10-19 Self-Care"), "detect area range");
check(isJohnnyDecimalName("11 Selfish Projects"), "detect category number");
check(isJohnnyDecimalName("11.01 Living Room Refresh"), "detect folder id");
check(!isJohnnyDecimalName("Living Room Refresh"), "plain name not detected");
check(!isJohnnyDecimalName("v2 Rollout"), "non-id leading token not detected");
eq(stripJdPrefix("10-19 Self-Care"), "Self-Care", "strip area");
eq(stripJdPrefix("11.01 Living Room Refresh"), "Living Room Refresh", "strip folder");
eq(stripJdPrefix("Living Room Refresh"), "Living Room Refresh", "strip no-op");
eq(stripJdPrefix(stripJdPrefix("11 Selfish Projects")), "Selfish Projects", "strip idempotent");

// ---- enable ----
{
  const { space: out, folderRenames, renames } = applyJohnnyDecimal(space(), true);
  eq(out[0].name, "10-19 Self-Care", "area 1 id");
  eq(out[0].children[0].name, "11 Selfish Projects", "cat 11");
  eq(out[0].children[0].children[0].name, "11.01 Living Room Refresh", "folder 11.01");
  eq(out[0].children[1].name, "12 Selfish Spaces", "cat 12");
  eq(out[0].children[1].children[1].name, "12.02 Reference Shelf", "folder 12.02");
  eq(out[1].name, "20-29 Craft", "area 2 range");
  eq(out[1].children[0].children[0].name, "21.01 Map Pipeline v2", "folder 21.01");
  eq(folderRenames.get("Living Room Refresh"), "11.01 Living Room Refresh", "folder rename map");

  // deepest-first ordering: every folder rename precedes any category/area one.
  const levels = renames.map((r) => r.level);
  const firstNonFolder = levels.findIndex((l) => l !== "folder");
  const lastFolder = levels.lastIndexOf("folder");
  check(firstNonFolder === -1 || lastFolder < firstNonFolder, "renames deepest-first");
  check(levels.includes("area") && levels.includes("category"), "renames cover all levels");
}

// ---- disable + idempotency ----
{
  const enabled = applyJohnnyDecimal(space(), true).space;
  const disabled = applyJohnnyDecimal(enabled, false).space;
  eq(disabled, space(), "enable→disable round-trips to base names");

  const once = applyJohnnyDecimal(space(), true).space;
  const twice = applyJohnnyDecimal(once, true).space;
  eq(twice, once, "re-enable is idempotent");
  eq(applyJohnnyDecimal(once, true).renames.length, 0, "re-enable produces no renames");
}

if (failed) { console.error(`\n${failed} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nALL CHECKS PASS");
