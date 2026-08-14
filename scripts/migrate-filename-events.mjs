// One-time migration: make the FILE NAME the source of truth for event date/time.
//
//   - Every event note (has date/startTime/endTime/endDate/allDay frontmatter) is
//     RENAMED to the dated-filename convention and those YAML fields are STRIPPED.
//   - Bare dated reference notes (a `YYYY-MM-DD …` name but no event frontmatter)
//     are converted to NOON timed events (`YYYY-MM-DD 1200 …`).
//   - Inbound [[wikilinks]] to renamed files are rewritten.
//
// EXCLUDED: `.chat.md` (already name-encoded + uses frontmatter for other things),
// season notes (`role: seasons` / `season: true` keep their `date:`).
//
// Dry-run by default (prints the plan). Pass --apply to write.
//
//   npx tsx scripts/migrate-filename-events.mjs          # dry run
//   npx tsx scripts/migrate-filename-events.mjs --apply  # execute

import { readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { splitFrontmatter, joinFrontmatter, toIsoDateValue } from "../src/lib/frontmatter.ts";
import { parseEventFilename, formatEventFilename } from "../src/lib/event-filename.ts";

const VAULT = "/Users/studio/Documents/Dropbox/Home";
const APPLY = process.argv.includes("--apply");
const DATE_FIELDS = ["date", "startTime", "endTime", "endDate", "allDay"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "Attachments") continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith(".md") && !name.endsWith(".chat.md")) out.push(abs);
  }
  return out;
}

const files = walk(VAULT);
const plan = [];              // { abs, dir, oldName, newName, strip }
const renameMap = new Map();  // oldBaseNoExt -> newBaseNoExt (wikilink pass)
const usedPerDir = new Map(); // dir -> Set(lowercased names in use / planned)
let noonCount = 0, stripOnly = 0, skipped = 0;

// Seed per-dir used names with everything currently on disk, so collision suffixes
// avoid real files too (not just planned renames).
for (const abs of files) {
  const d = dirname(abs);
  if (!usedPerDir.has(d)) usedPerDir.set(d, new Set());
  usedPerDir.get(d).add(basename(abs).toLowerCase());
}

function uniqueName(dir, desiredNoExt, ext, selfName) {
  const used = usedPerDir.get(dir) ?? new Set();
  let candidate = `${desiredNoExt}${ext}`;
  if (candidate.toLowerCase() === selfName.toLowerCase()) return candidate; // unchanged
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${desiredNoExt} ${n}${ext}`;
    n++;
  }
  return candidate;
}

for (const abs of files) {
  const name = basename(abs);
  const base = name.replace(/\.md$/i, "");
  const ext = ".md";
  let fm, body;
  try { ({ frontmatter: fm, body } = splitFrontmatter(readFileSync(abs, "utf8"))); }
  catch { skipped++; continue; }

  // Seasons keep their date frontmatter and name.
  if (fm.role === "seasons" || fm.season === true) { skipped++; continue; }

  const fmDate = toIsoDateValue(fm.date);
  const fmStart = typeof fm.startTime === "string" && /^\d{2}:\d{2}$/.test(fm.startTime) ? fm.startTime : undefined;
  const fmEnd = typeof fm.endTime === "string" && /^\d{2}:\d{2}$/.test(fm.endTime) ? fm.endTime : undefined;
  const fmEndDate = typeof fm.endDate === "string" ? String(fm.endDate).slice(0, 10) : undefined;
  // A REAL event has an explicit all-day flag OR a start time. A note with only a
  // `date:` (a Readwise/article save-date, etc.) is NOT an event — leave it alone.
  const isRealEvent = fm.allDay === true || !!fmStart;
  const parsed = parseEventFilename(base);

  let schedule = null;
  let label = parsed ? parsed.title : base;

  if (isRealEvent) {
    const date = fmDate ?? parsed?.date;
    if (!date) { skipped++; continue; }
    schedule = { date, time: fmStart, endTime: fmEnd, endDate: fmEndDate };
    if (parsed) label = parsed.title; // dated name → keep its label
  } else if (parsed) {
    // A DATED NAME with no event frontmatter → the note is on a timeline. Keep an
    // existing time in the name; otherwise convert to NOON (per the settled decision).
    if (parsed.time) {
      schedule = { date: parsed.date, time: parsed.time, endTime: parsed.endTime, endDate: parsed.endDate };
    } else {
      schedule = { date: parsed.date, time: "12:00" };
      noonCount++;
    }
    label = parsed.title;
  } else {
    skipped++; continue; // not an event and no dated name (date-only frontmatter stays)
  }

  // Tidy: drop a redundant leading date (and a matching time) from the label when it
  // equals the event's own date — e.g. "2026-02-08 2026-02-08 1453" collapses to one.
  const lp = parseEventFilename(label);
  if (lp && lp.date === schedule.date) label = lp.title;

  // Cap the on-disk name well under the 255-BYTE filesystem limit by trimming the
  // LABEL (the date/time prefix is always kept intact).
  const MAX = 200;
  let desiredBase = formatEventFilename(schedule, label);
  if (Buffer.byteLength(desiredBase, "utf8") > MAX) {
    const prefixOnly = formatEventFilename(schedule, "");
    const room = MAX - Buffer.byteLength(prefixOnly, "utf8") - 1;
    let trimmed = label;
    while (trimmed.length && Buffer.byteLength(trimmed, "utf8") > Math.max(8, room)) trimmed = trimmed.slice(0, -1);
    label = trimmed.trim();
    desiredBase = formatEventFilename(schedule, label);
  }
  const newName = uniqueName(dirname(abs), desiredBase, ext, name);
  const stripNeeded = DATE_FIELDS.some((f) => f in fm);

  if (newName === name && !stripNeeded) { skipped++; continue; }
  if (newName === name) stripOnly++;

  // reserve the new name so later files in the same dir don't collide with it
  usedPerDir.get(dirname(abs)).add(newName.toLowerCase());
  if (newName !== name) renameMap.set(base, newName.replace(/\.md$/i, ""));
  plan.push({ abs, dir: dirname(abs), oldName: name, newName, stripNeeded, fm, body });
}

// ---- report ----
const renamesOnly = plan.filter((p) => p.oldName !== p.newName);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — filename-as-truth event migration`);
console.log(`  scanned .md (non-chat): ${files.length}`);
console.log(`  to change:              ${plan.length}  (renames: ${renamesOnly.length}, strip-only: ${stripOnly})`);
console.log(`  noon conversions:       ${noonCount}`);
console.log(`  skipped (no change):    ${skipped}`);
console.log(`  wikilink base renames:  ${renameMap.size}`);
console.log("\n  sample renames:");
for (const p of renamesOnly.slice(0, 25)) {
  console.log(`    ${p.oldName}\n      -> ${p.newName}`);
}

if (!APPLY) {
  console.log("\n(dry run — no files changed. Re-run with --apply to execute.)");
  process.exit(0);
}

// ---- apply (resilient: a single bad file logs + continues, never halts) ----
let renamed = 0, stripped = 0;
const errors = [];
for (const p of plan) {
  try {
    let targetAbs = p.abs;
    if (p.oldName !== p.newName) {
      targetAbs = join(p.dir, p.newName);
      renameSync(p.abs, targetAbs);
      renamed++;
    }
    if (p.stripNeeded) {
      const nextFm = { ...p.fm };
      for (const f of DATE_FIELDS) delete nextFm[f];
      writeFileSync(targetAbs, joinFrontmatter(nextFm, p.body));
      stripped++;
    }
  } catch (e) {
    // Drop this file from the wikilink rename map so we don't rewrite links to a
    // rename that didn't happen.
    renameMap.delete(p.oldName.replace(/\.md$/i, ""));
    errors.push(`${p.oldName}: ${e.code || e.message}`);
  }
}
if (errors.length) {
  console.log(`\n  ${errors.length} file(s) could not be migrated (skipped, left as-is):`);
  for (const e of errors.slice(0, 20)) console.log(`    ${e}`);
}

// ---- wikilink rewrite: [[oldBase]] / [[oldBase|alias]] / [[oldBase#heading]] ----
let linksUpdated = 0, filesTouched = 0;
if (renameMap.size > 0) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [...renameMap.entries()].map(([oldB, newB]) => ({
    re: new RegExp(`\\[\\[${escape(oldB)}((?:\\||#)[^\\]]*)?\\]\\]`, "g"),
    newB,
  }));
  for (const abs of walk(VAULT)) {
    let text = readFileSync(abs, "utf8");
    let changed = false;
    for (const { re, newB } of patterns) {
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      text = text.replace(re, (_m, tail) => { linksUpdated++; return `[[${newB}${tail || ""}]]`; });
      changed = true;
    }
    if (changed) { writeFileSync(abs, text); filesTouched++; }
  }
}

console.log(`\nAPPLIED | renamed: ${renamed} | frontmatter stripped: ${stripped} | wikilinks updated: ${linksUpdated} in ${filesTouched} files`);
