// Reorder the "Creative Projects" folders in spacetime.mw by date, using
// Creative/Creative Spaces/Articles/Articles.md (newest-first, dated) as the
// guide. Matching is truncation/dash/space-insensitive (folderMatchKey).
// Folders absent from Articles.md keep a manual date and slot in by date.
// Non-destructive: spacetime.mw is backed up to a sibling folder first.

import fs from "node:fs";
import path from "node:path";

const VAULT = "/Users/studio/Documents/Dropbox/Home";
const MW = path.join(VAULT, "spacetime.mw");
const ART = path.join(VAULT, "Creative/Creative Spaces/Articles/Articles.md");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP = `${VAULT}-order-backup-${stamp}`;
fs.mkdirSync(BACKUP, { recursive: true });
fs.copyFileSync(MW, path.join(BACKUP, "spacetime.mw"));

const folderKey = (s) => s.normalize("NFC")
  .replace(/[   ]/g, " ").replace(/[‒–—―]/g, "-")
  .replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const folderDirName = (s) => s.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();
const matchKey = (s) => folderKey(folderDirName(s));

// --- parse Articles.md (file order = newest first) ---
const order = []; // {key, date|null}
for (const l of fs.readFileSync(ART, "utf8").split("\n")) {
  const m = l.match(/^-\s+(?:\[\[(.+?)\]\]|([^·]+?))\s*(?:·\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
  if (!m) continue;
  const name = (m[1] || m[2] || "").trim();
  if (!name) continue;
  order.push({ key: matchKey(name), date: m[3] || null });
}
const idxOf = new Map();
order.forEach((o, i) => { if (!idxOf.has(o.key)) idxOf.set(o.key, i); });
const datedByIdx = order.map((o, i) => ({ i, date: o.date })).filter((o) => o.date);

// Folders not in Articles.md → best-stab dates (drafts, from the event log).
const manual = { "2026-02 th18": "2026-02-01", "th21": "2026-03-15" };
const bracketIndex = (date) => {
  for (const d of datedByIdx) if (d.date < date) return d.i - 0.5;
  return order.length;
};
const sortKey = (name) => {
  const k = matchKey(name);
  if (idxOf.has(k)) return idxOf.get(k);
  const md = manual[k];
  if (md) return bracketIndex(md);
  return order.length + 1;
};

// --- locate the Creative Projects folder block in spacetime.mw ---
const lines = fs.readFileSync(MW, "utf8").split("\n");
let start = -1;
for (let i = 0; i < lines.length; i++) if (lines[i] === "- Creative Projects") { start = i + 1; break; }
if (start < 0) { console.error("Could not find '- Creative Projects'"); process.exit(1); }
let end = start;
while (end < lines.length && /^  - /.test(lines[end])) end++;
const folders = lines.slice(start, end).map((l) => l.replace(/^  - /, ""));

const unmatched = folders.filter((f) => !idxOf.has(matchKey(f)) && !manual[matchKey(f)]);
const sorted = [...folders].sort((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b));

const out = [...lines.slice(0, start), ...sorted.map((f) => "  - " + f), ...lines.slice(end)];
fs.writeFileSync(MW, out.join("\n"));

console.log("BACKUP:", BACKUP);
console.log(`reordered ${folders.length} Creative Projects folders`);
console.log("unmatched (no date found, sorted to end):", unmatched.length ? unmatched : "none");
console.log("\nNew order (newest first):");
sorted.forEach((f, i) => {
  const k = matchKey(f);
  const d = idxOf.has(k) ? (order[idxOf.get(k)].date || "(no date in guide)") : (manual[k] || "?");
  console.log(`${String(i + 1).padStart(2)}. ${d}  ${f}`);
});
