// One-time, NON-DESTRUCTIVE cleanup of a vault corrupted by look-alike folder
// names (NBSP vs space, em-dash vs hyphen). Everything removed is MOVED into a
// sibling backup folder (outside the vault, so the app never indexes it), so a
// full restore is a simple move-back. Nothing is rm'd.
//
//   node scripts/dedupe-spacetime.mjs "<vault path>"
//
// Steps:
//  1. Back up spacetime.mw + spacetime.yml.
//  2. Dedupe the spacetime.mw space section: collapse folder lines that share a
//     normalized key (keep the first occurrence), rewriting the kept name to the
//     dash form. Time section untouched.
//  3. Dedupe duplicate Notable-Folder directories (same normalized key under one
//     category): keep the cleanest (normal space + hyphen), MOVE the rest into
//     the backup.

import fs from "node:fs";
import path from "node:path";

const VAULT = process.argv[2];
if (!VAULT || !fs.existsSync(VAULT)) { console.error("vault path missing/invalid:", VAULT); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP = `${VAULT.replace(/\/$/, "")}-order-backup-${stamp}`;
fs.mkdirSync(BACKUP, { recursive: true });

// Mirror src/lib/folders.ts folderKey().
const folderKey = (s) => s
  .normalize("NFC")
  .replace(/[   ]/g, " ")
  .replace(/[‒–—―]/g, "-")
  .replace(/\s*-\s*/g, "-")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();
// "Prefer dash": display form keeps spelling but uses hyphen + normal space.
const toDash = (s) => s
  .normalize("NFC")
  .replace(/[   ]/g, " ")
  .replace(/[‒–—―]/g, "-");

const report = [];

// 1. Back up the canonical files.
for (const f of ["spacetime.mw", "spacetime.yml", "spacetime.md"]) {
  const p = path.join(VAULT, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(BACKUP, f));
}

// 2. Dedupe spacetime.mw space-section folder lines (2-space-indented `  - `).
//    CONSERVATIVE: only collapse genuine duplicates (same normalized key).
//    Non-duplicate names keep their ORIGINAL spelling (em-dashes preserved).
//    Among duplicate variants, "prefer dash": keep the cleanest spelling
//    (normal space + spaced hyphen) over NBSP / em-dash / unspaced hyphen.
const dashScore = (s) =>
  (/[   ]/.test(s) ? 4 : 0) +          // NBSP / figure / narrow-no-break space
  (/[‒–—―]/.test(s) ? 2 : 0) +      // em / en / figure / horizontal dash
  (/-/.test(s) && !/ - /.test(s) ? 1 : 0); // unspaced hyphen
const mwPath = path.join(VAULT, "spacetime.mw");
if (fs.existsSync(mwPath)) {
  const lines = fs.readFileSync(mwPath, "utf8").split("\n");
  const folderLine = (line, inSpace) => (inSpace ? line.match(/^  - (.+)$/) : null);

  // Pass 1: choose the best-spelled variant per key.
  const best = new Map();
  { let inSpace = false;
    for (const line of lines) {
      if (line.startsWith("# Space")) { inSpace = true; continue; }
      if (line.startsWith("# Time")) { inSpace = false; continue; }
      const m = folderLine(line, inSpace);
      if (!m) continue;
      const k = folderKey(m[1]), sc = dashScore(m[1]);
      const cur = best.get(k);
      if (!cur || sc < cur.sc) best.set(k, { name: m[1], sc });
    }
  }
  // Pass 2: emit the chosen variant once per key, drop the rest.
  let inSpace = false; const emitted = new Set(); const out = []; let dropped = 0;
  for (const line of lines) {
    if (line.startsWith("# Space")) { inSpace = true; out.push(line); continue; }
    if (line.startsWith("# Time")) { inSpace = false; out.push(line); continue; }
    const m = folderLine(line, inSpace);
    if (m) {
      const k = folderKey(m[1]);
      if (emitted.has(k)) { report.push(`mw  drop dup folder line: ${m[1]}`); dropped++; continue; }
      emitted.add(k);
      const keep = best.get(k).name;
      out.push("  - " + keep);
      if (keep !== m[1]) report.push(`mw  keep variant "${keep}" (dropped sibling "${m[1]}")`);
      continue;
    }
    out.push(line);
  }
  if (out.join("\n") !== lines.join("\n")) fs.writeFileSync(mwPath, out.join("\n"));
  report.push(`mw  dropped ${dropped} duplicate folder line(s); non-duplicates left untouched`);
}
void toDash;

// 3. Dedupe duplicate Notable-Folder directories under each Area/Category.
const subdirs = (d) => fs.existsSync(d)
  ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
// Lower score = cleaner = keep. Penalize NBSP and em/en dashes.
const score = (s) => (/[   ]/.test(s) ? 2 : 0) + (/[‒–—―]/.test(s) ? 1 : 0);

for (const area of subdirs(VAULT)) {
  if (area.endsWith(`-order-backup-${stamp}`) || area.startsWith(".")) continue;
  for (const cat of subdirs(path.join(VAULT, area))) {
    const folders = subdirs(path.join(VAULT, area, cat));
    const byKey = new Map();
    for (const f of folders) {
      const k = folderKey(f);
      (byKey.get(k) ?? byKey.set(k, []).get(k)).push(f);
    }
    for (const [, group] of byKey) {
      if (group.length < 2) continue;
      group.sort((a, b) => score(a) - score(b) || a.length - b.length);
      const keep = group[0];
      for (const loser of group.slice(1)) {
        const src = path.join(VAULT, area, cat, loser);
        const dst = path.join(BACKUP, "moved-dirs", area, cat, loser);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        report.push(`dir move dup -> backup: ${area}/${cat}/${loser}   (kept "${keep}")`);
      }
    }
  }
}

console.log("BACKUP:", BACKUP);
console.log(report.join("\n"));
console.log("\nDone. Restore = move items from the backup folder back.");
