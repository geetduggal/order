// Run: npx tsx src/lib/gcal-desc-sig.test.ts  → "ALL CHECKS PASS"
//
// Locks the fix for "events resync when nothing changed": the Google-push
// signature must depend on the backing note's DESCRIPTION CONTENT, never on
// its filesystem mtime. A content-neutral touch (Dropbox re-download, a
// self-write) advances mtime but leaves the content — so the signature, and
// therefore the pending-sync decision, must not move.

import { descriptionHash, eventDescriptionFromRaw, type PushIntent } from "./gcal-push";
import { gcalSyncPlan, naturalKey, type SyncRecord } from "./gcal-sync-plan";

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) { console.log(`ok: ${label}`); }
  else { failed++; console.error(`FAIL: ${label}`); }
}

// ---- eventDescriptionFromRaw: strips frontmatter, trims ----
check(
  eventDescriptionFromRaw("---\ndate: 2026-06-26\ntitle: X\n---\n# X\n\nBody here.\n") === "# X\n\nBody here.",
  "description = body without frontmatter, trimmed",
);
// Frontmatter differing (e.g. a date/time edit, tracked separately by the
// schedule sig) does NOT change the description text.
check(
  eventDescriptionFromRaw("---\ndate: 2026-06-27\n---\n# X\n\nBody here.\n")
    === eventDescriptionFromRaw("---\ndate: 2026-06-26\n---\n# X\n\nBody here.\n"),
  "frontmatter-only difference leaves description unchanged",
);

// ---- descriptionHash: stable for identical content, differs on real edits ----
const rawA = "---\ndate: 2026-06-26\n---\n# Meet\n\nAgenda: ship it.\n";
const rawTouchedSameContent = rawA; // an mtime-only touch re-reads identical bytes
const rawEdited = "---\ndate: 2026-06-26\n---\n# Meet\n\nAgenda: ship it TOMORROW.\n";
const hA = descriptionHash(eventDescriptionFromRaw(rawA));
const hTouch = descriptionHash(eventDescriptionFromRaw(rawTouchedSameContent));
const hEdit = descriptionHash(eventDescriptionFromRaw(rawEdited));
check(hA === hTouch, "identical content → identical hash (mtime touch is invisible)");
check(hA !== hEdit, "changed description → changed hash");

// ---- Integration through gcalSyncPlan with the real signature shape ----
// Mirror CardGrid's gcalSig: schedule sig + "|" + descHash.
const schedSig = (it: PushIntent) =>
  [it.host, it.date, it.time ?? "", it.endTime ?? "", it.allDay, it.title, [...it.attendees].sort().join(",")].join("|");
const sig = (it: PushIntent) => schedSig(it) + "|" + (it.descHash ?? "");

const base: PushIntent = {
  host: "you@example.com", date: "2026-06-26", time: "09:00",
  allDay: false, title: "Meet", attendees: ["dana@example.com"], descHash: hA,
};
// The record as it stands right after a successful sync of `base`.
const record: SyncRecord = {
  [naturalKey(base.date, base.time, base.title)]: {
    host: base.host, date: base.date, time: base.time, title: base.title,
    sig: sig(base), schedSig: schedSig(base),
  },
};

// 1) mtime-only touch: same content → same descHash → NO push.
const afterTouch = gcalSyncPlan(record, [{ ...base, descHash: hTouch }], sig);
check(afterTouch.pushes.length === 0 && afterTouch.deletes.length === 0,
  "mtime-only touch (same content) produces no push");

// 2) real description edit: hash changes → exactly one push.
const afterEdit = gcalSyncPlan(record, [{ ...base, descHash: hEdit }], sig);
check(afterEdit.pushes.length === 1, "real description edit produces a push");

// 3) schedule change still pushes (schedule sig covers it independently).
const afterReschedule = gcalSyncPlan(record, [{ ...base, time: "10:00" }], sig);
check(afterReschedule.pushes.length === 1 && afterReschedule.deletes.length === 1,
  "reschedule pushes new key and deletes the old one");

if (failed > 0) { console.error(`\n${failed} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASS");
