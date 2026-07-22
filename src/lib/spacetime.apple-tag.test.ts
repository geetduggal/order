// Run: npx tsx src/lib/spacetime.apple-tag.test.ts  → "ALL CHECKS PASS"
// The Apple/system-calendar assignment token `@[Calendar]` on an event line.
import { parseMarkwhenFormat, serializeMarkwhen, spliceMwEvents } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

// Parse: @[Home] is captured as `apple`, leaving a clean title + folder tag.
{
  const st = parseMarkwhenFormat(
    `# Time\n\n## Events\n\n2026-07-20 09:00-09:30 : Sprint sync #[Map Pipeline v2] @[Home]\n`,
  );
  const e = st.events[0];
  assertEq(e.title, "Sprint sync", "title clean of @[…] and #[…]");
  assertEq(e.folder, "#[Map Pipeline v2]", "folder tag captured");
  assertEq(e.apple, "Home", "apple calendar captured");
}

// Parse: @[Cal] coexists with trailing Google emails.
{
  const st = parseMarkwhenFormat(
    `# Time\n\n## Events\n\n2026-07-21 14:00-15:00 : Planning #[Polaris] @[Work] you@example.com dana@example.com\n`,
  );
  const e = st.events[0];
  assertEq(e.title, "Planning", "title clean with apple + emails");
  assertEq(e.apple, "Work", "apple captured before emails");
  assertEq(e.emails, ["you@example.com", "dana@example.com"], "emails still captured");
}

// Parse: a plain event has no apple field.
{
  const st = parseMarkwhenFormat(`# Time\n\n## Events\n\n2026-07-22 : Birthday #[Household]\n`);
  assertEq(st.events[0].apple, undefined, "no apple token → undefined");
}

// Serialize (both writers) emits `@[Cal]` after the folder tag, before emails.
{
  const ev = {
    date: "2026-07-20", time: "09:00", endTime: "09:30",
    title: "Sprint sync", folder: "Map Pipeline v2", apple: "Home",
    emails: ["you@example.com"],
  };
  const mw = serializeMarkwhen({ space: [], seasons: [], events: [ev] });
  assertEq(
    mw.includes("Sprint sync #[Map Pipeline v2] @[Home] you@example.com"),
    true,
    "serializeMarkwhen order: title #[folder] @[cal] emails",
  );
  const spliced = spliceMwEvents("# Time\n\n## Events\n", [ev]);
  assertEq(
    spliced.includes("Sprint sync #[Map Pipeline v2] @[Home] you@example.com"),
    true,
    "spliceMwEvents same order",
  );
}

// Round-trip: parse(serialize(x)) preserves apple.
{
  const ev = { date: "2026-07-25", title: "Furniture day", folder: "Living Room Refresh", apple: "Home", allDay: true };
  const mw = serializeMarkwhen({ space: [], seasons: [], events: [ev] });
  const back = parseMarkwhenFormat(mw).events[0];
  assertEq(back.apple, "Home", "round-trip preserves apple");
  assertEq(back.title, "Furniture day", "round-trip title clean");
}

console.log("\nALL CHECKS PASS");
