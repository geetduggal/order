// Run: npx tsx src/lib/gcal-recipients.test.ts  → "ALL CHECKS PASS"
import { resolveRecipients, distinctEmails } from "./gcal-recipients";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const connected = ["geet.duggal@gmail.com", "geet@verkada.com"];
const def = "geet.duggal@gmail.com";

// 1. No emails → not a synced event.
assertEq(resolveRecipients([], connected, def), { host: null, invitees: [] }, "no emails");

// 2. Connected email is the host, no invite.
assertEq(resolveRecipients(["geet@verkada.com"], connected, def),
  { host: "geet@verkada.com", invitees: [] }, "connected = host, no invite");

// 3. One contact → host = default, invite the contact.
assertEq(resolveRecipients(["rohit@verkada.com"], connected, def),
  { host: "geet.duggal@gmail.com", invitees: ["rohit@verkada.com"] }, "contact → default host + invite");

// 4. Connected host + multiple contacts.
assertEq(resolveRecipients(["geet@verkada.com", "rohit@verkada.com", "bob@acme.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["rohit@verkada.com", "bob@acme.com"] }, "host + invitees");

// 5. Case-insensitive, normalized to lowercase.
assertEq(resolveRecipients(["GEET@Verkada.com", "Rohit@Verkada.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["rohit@verkada.com"] }, "case-insensitive");

// 6. No connected match, no default → host null (caller blocks).
assertEq(resolveRecipients(["rohit@verkada.com"], connected, null),
  { host: null, invitees: ["rohit@verkada.com"] }, "no default → host null");

// 7. A second connected email is never invited (it's yours), and host is the first connected.
assertEq(resolveRecipients(["geet@verkada.com", "geet.duggal@gmail.com", "bob@acme.com"], connected, def),
  { host: "geet@verkada.com", invitees: ["bob@acme.com"] }, "second own account not invited");

// distinctEmails: lowercased, de-duplicated, sorted.
{
  const evs: SpacetimeEvent[] = [
    { date: "2026-06-25", title: "A", emails: ["Rohit@verkada.com", "bob@acme.com"] },
    { date: "2026-06-25", title: "B", emails: ["rohit@verkada.com"] }, // dup (case-insensitive)
    { date: "2026-06-25", title: "C" }, // no emails
  ];
  assertEq(distinctEmails(evs), ["bob@acme.com", "rohit@verkada.com"], "distinctEmails: lowercased, deduped, sorted");
  assertEq(distinctEmails([]), [], "distinctEmails: empty");
}

console.log("ALL CHECKS PASS");
