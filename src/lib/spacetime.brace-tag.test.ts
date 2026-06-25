// Run: npx tsx src/lib/spacetime.brace-tag.test.ts  → "ALL CHECKS PASS"
import { toBraceTag, stripTagToName } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

assertEq(toBraceTag("Geet Duggal"), "#[Geet Duggal]", "toBraceTag multi-word");
assertEq(toBraceTag("order"), "#[order]", "toBraceTag single-word preserves case-as-is");
assertEq(stripTagToName("#[Geet Duggal]"), "Geet Duggal", "stripTagToName brace");
assertEq(stripTagToName("#[ Spaced ]"), "Spaced", "stripTagToName trims inner");
assertEq(stripTagToName("#geet-duggal"), "geet-duggal", "stripTagToName kebab fallback");

console.log("ALL CHECKS PASS");
