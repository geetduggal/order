// Run: npx tsx src/lib/spacetime.brace-tag.test.ts  → "ALL CHECKS PASS"
import { toBraceTag, stripTagToName, serializeMarkwhen, spliceMwEvents } from "./spacetime";
import { parseMarkwhenFormat } from "./spacetime";

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

// Parser captures a brace tag as the raw token when there's no Space to resolve.
{
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n2026-06-25 09:00 : Standup #[Geet Duggal]\n`);
  assertEq(st.events[0].folder, "#[Geet Duggal]", "brace tag captured (unresolved, no space)");
  assertEq(st.events[0].title, "Standup", "title excludes the brace tag");
}
// Brace tag + trailing emails both parse.
{
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n2026-06-25 09:00 : Sync #[Geet Duggal] a@x.com b@y.com\n`);
  assertEq(st.events[0].folder, "#[Geet Duggal]", "brace tag with emails: folder");
  assertEq(st.events[0].emails ?? null, ["a@x.com", "b@y.com"], "brace tag with emails: emails");
  assertEq(st.events[0].title, "Sync", "brace tag with emails: title");
}
// With a Space section, BOTH brace and kebab resolve to the real folder name.
{
  const space = `# Space\n\n## Personal\n\n- Projects\n  - Geet Duggal\n\n`;
  const brace = parseMarkwhenFormat(`${space}# Time\n\n## Events\n\n2026-06-25 09:00 : A #[Geet Duggal]\n`);
  assertEq(brace.events[0].folder, "Geet Duggal", "brace resolves to real name");
  const kebab = parseMarkwhenFormat(`${space}# Time\n\n## Events\n\n2026-06-25 09:00 : A #geet-duggal\n`);
  assertEq(kebab.events[0].folder, "Geet Duggal", "legacy kebab still resolves (back-compat)");
}

// Serializer emits the brace form, preserving the name's case.
{
  const mw = serializeMarkwhen({ space: [], seasons: [], events: [
    { date: "2026-06-25", title: "Standup", folder: "Geet Duggal", time: "09:00" },
  ] });
  if (!mw.includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: serializeMarkwhen should emit brace tag\n" + mw);
  console.log("ok: serializeMarkwhen emits brace tag");
}
// spliceMwEvents emits brace too; a kebab line round-trips to brace.
{
  const spliced = spliceMwEvents("# Time\n\n## Events\n", [
    { date: "2026-06-25", title: "Plan", folder: "Geet Duggal", time: "14:00" },
  ]);
  if (!spliced.includes(": Plan #[Geet Duggal]")) throw new Error("FAIL: spliceMwEvents should emit brace tag\n" + spliced);
  console.log("ok: spliceMwEvents emits brace tag");
}

import { migrateMwTagsToBrace } from "./spacetime";

// Migration rewrites event tags kebab→brace, leaves the Space section intact.
{
  const before = `# Space\n\n## Personal\n\n- Projects\n  - Geet Duggal\n\n# Time\n\n## Events\n\n2026-06-25 09:00: Standup #geet-duggal\n`;
  const after = migrateMwTagsToBrace(before);
  if (!after.includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: migration should produce brace tag\n" + after);
  if (!after.includes("## Personal") || !after.includes("  - Geet Duggal")) throw new Error("FAIL: migration must preserve Space section\n" + after);
  // Idempotent: running again is a no-op on the tag.
  if (!migrateMwTagsToBrace(after).includes(": Standup #[Geet Duggal]")) throw new Error("FAIL: migration not idempotent");
  console.log("ok: migrateMwTagsToBrace converts tags + preserves space + idempotent");
}

console.log("ALL CHECKS PASS");
