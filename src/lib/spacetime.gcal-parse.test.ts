// Run: npx tsx src/lib/spacetime.gcal-parse.test.ts  → "ALL CHECKS PASS"
import { parseMarkwhenFormat } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

function ev(line: string) {
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n${line}\n`);
  return st.events[0];
}

// 1. No emails → emails undefined, title intact.
assertEq(ev("2026-06-25 09:00 : Standup #verkada"), { date: "2026-06-25", title: "Standup", folder: "#verkada", time: "09:00" }, "no emails");

// 2. One trailing email after the tag.
assertEq(ev("2026-06-25 09:00 : Standup #verkada geet@verkada.com"),
  { date: "2026-06-25", title: "Standup", folder: "#verkada", time: "09:00", emails: ["geet@verkada.com"] },
  "one email after tag");

// 3. Multiple trailing emails.
assertEq(ev("2026-06-25 14:00 : Planning #verkada a@x.com b@y.com c@z.org"),
  { date: "2026-06-25", title: "Planning", folder: "#verkada", time: "14:00", emails: ["a@x.com", "b@y.com", "c@z.org"] },
  "multiple emails");

// 4. Emails with no folder tag.
assertEq(ev("2026-06-25 14:00 : Planning a@x.com b@y.com"),
  { date: "2026-06-25", title: "Planning", time: "14:00", emails: ["a@x.com", "b@y.com"] },
  "emails, no tag");

// 5. A title word that is not a full email is left alone.
assertEq(ev("2026-06-25 09:00 : Email Bob later #verkada"),
  { date: "2026-06-25", title: "Email Bob later", folder: "#verkada", time: "09:00" },
  "non-email title preserved");

console.log("ALL CHECKS PASS");
