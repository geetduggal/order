// Run: npx tsx src/lib/gcal-recipients.test.ts  → "ALL CHECKS PASS"
import { resolveRecipients, distinctEmails } from "./gcal-recipients";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const connected = ["you-personal@example.com", "you@example.com"];
const def = "you-personal@example.com";

// 1. No emails → not a synced event.
assertEq(resolveRecipients([], connected, def), { host: null, invitees: [] }, "no emails");

// 2. Connected email is the host, no invite.
assertEq(resolveRecipients(["you@example.com"], connected, def),
  { host: "you@example.com", invitees: [] }, "connected = host, no invite");

// 3. One contact → host = default, invite the contact.
assertEq(resolveRecipients(["dana@example.com"], connected, def),
  { host: "you-personal@example.com", invitees: ["dana@example.com"] }, "contact → default host + invite");

// 4. Connected host + multiple contacts.
assertEq(resolveRecipients(["you@example.com", "dana@example.com", "sam@example.com"], connected, def),
  { host: "you@example.com", invitees: ["dana@example.com", "sam@example.com"] }, "host + invitees");

// 5. Case-insensitive, normalized to lowercase.
assertEq(resolveRecipients(["YOU@Example.com", "Dana@Example.com"], connected, def),
  { host: "you@example.com", invitees: ["dana@example.com"] }, "case-insensitive");

// 6. No connected match, no default → host null (caller blocks).
assertEq(resolveRecipients(["dana@example.com"], connected, null),
  { host: null, invitees: ["dana@example.com"] }, "no default → host null");

// 7. A second connected email is never invited (it's yours), and host is the first connected.
assertEq(resolveRecipients(["you@example.com", "you-personal@example.com", "sam@example.com"], connected, def),
  { host: "you@example.com", invitees: ["sam@example.com"] }, "second own account not invited");

// distinctEmails: lowercased, de-duplicated, sorted.
{
  const evs: SpacetimeEvent[] = [
    { date: "2026-06-25", title: "A", emails: ["Dana@example.com", "sam@example.com"] },
    { date: "2026-06-25", title: "B", emails: ["dana@example.com"] }, // dup (case-insensitive)
    { date: "2026-06-25", title: "C" }, // no emails
  ];
  assertEq(distinctEmails(evs), ["dana@example.com", "sam@example.com"], "distinctEmails: lowercased, deduped, sorted");
  assertEq(distinctEmails([]), [], "distinctEmails: empty");
}

console.log("ALL CHECKS PASS");
