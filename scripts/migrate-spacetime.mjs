import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseMarkwhenFormat } from "../src/lib/spacetime.ts";
import { splitFrontmatter, joinFrontmatter, toIsoDateValue, firstMajorHeader, noteTitle } from "../src/lib/frontmatter.ts";
import { folderMatchKey } from "../src/lib/folders.ts";

const VAULT = "/Users/studio/Documents/Dropbox/Home";
const APPLY = process.argv.includes("--apply");
const san = (s) => s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 90);
const norm = (s) => s.trim().toLowerCase();

function walkDirs(dir, depth, out=[]) { for (const e of readdirSync(dir)) { if (e===".git"||e.startsWith(".")) continue; const p=join(dir,e); let s; try{s=statSync(p);}catch{continue;} if (s.isDirectory()) { out.push({name:e,path:p,depth}); walkDirs(p,depth+1,out);} } return out; }
function walkFiles(dir, out=[]) { for (const e of readdirSync(dir)) { if (e===".git"||e.startsWith(".")) continue; const p=join(dir,e); let s; try{s=statSync(p);}catch{continue;} if (s.isDirectory()) walkFiles(p,out); else if (e.toLowerCase().endsWith(".md")) out.push(p);} return out; }

const dirs = walkDirs(VAULT, 0);
const folderDir = new Map();
for (const d of dirs) { const k = folderMatchKey(d.name); if (!folderDir.has(k)) folderDir.set(k, d.path); }
const catByNum = new Map();
for (const d of dirs.filter((x)=>x.depth===1)) { const m = d.name.match(/^(\d+)\b/); if (m && !catByNum.has(m[1])) catByNum.set(m[1], d.path); }
// JD NF id (e.g. "43.10") -> existing dir. The id is the IDENTITY, so a stale
// spacetime name like "43.10 Scratchpad" resolves to the real "43.10 Log".
const jdNfIdToDir = new Map();
for (const d of dirs) { const m = d.name.match(/^(\d+\.\d+)\b/); if (m && !jdNfIdToDir.has(m[1])) jdNfIdToDir.set(m[1], d.path); }

// eventKey (date|time|title) -> abs note path, matching buildSpacetime's identity.
const noteByEvent = new Map();
for (const abs of walkFiles(VAULT)) {
  const { frontmatter, body } = splitFrontmatter(readFileSync(abs, "utf8"));
  const date = toIsoDateValue(frontmatter.date); if (!date) continue;
  const start = typeof frontmatter.startTime === "string" ? frontmatter.startTime : undefined;
  const time = start && /^\d{2}:\d{2}$/.test(start) ? start : undefined;
  const allDay = frontmatter.allDay === true || (!!start && !time);
  if (!allDay && !time) continue;
  const base = abs.split("/").pop().replace(/\.md$/i, "");
  const title = firstMajorHeader(body) ?? noteTitle(frontmatter, body, base);
  noteByEvent.set(`${date}|${time ?? ""}|${norm(title)}`, abs);
}

const created = { dirs: 0, notes: 0, patched: 0, unresolved: 0 };
const unresolvedRefs = new Set();
const madeDirs = new Set();
function resolveDir(folderRef) {
  if (!folderRef) return join(VAULT, "90-99 Unfiled", "99 Migrated", "Unfiled");
  const k = folderMatchKey(folderRef);
  if (folderDir.has(k)) return folderDir.get(k);
  const idm = folderRef.match(/^(\d+\.\d+)/);
  if (idm && jdNfIdToDir.has(idm[1])) { const dir = jdNfIdToDir.get(idm[1]); folderDir.set(k, dir); return dir; } // JD-id conflict: id wins
  const m = folderRef.match(/^(\d+)\.\d+/);
  if (m && catByNum.has(m[1])) { const dir = join(catByNum.get(m[1]), san(folderRef)); folderDir.set(k, dir); jdNfIdToDir.set(idm[1], dir); if (!existsSync(dir) && !madeDirs.has(dir)) { madeDirs.add(dir); created.dirs++; if (APPLY) mkdirSync(dir,{recursive:true}); } return dir; }
  const fb = join(VAULT, "90-99 Unfiled", "99 Migrated", san(folderRef) || "Unfiled");
  folderDir.set(k, fb); if (!existsSync(fb) && !madeDirs.has(fb)) { madeDirs.add(fb); created.dirs++; if (APPLY) mkdirSync(fb,{recursive:true}); } created.unresolved++; unresolvedRefs.add(folderRef); return fb;
}

const st = parseMarkwhenFormat(readFileSync(join(VAULT, "spacetime.md"), "utf8"));
const usedNames = new Set();
for (const e of st.events) {
  const emails = (e.emails || []).filter((x) => typeof x === "string" && x.includes("@"));
  const key = `${e.date}|${e.time ?? ""}|${norm(e.title)}`;
  const backing = noteByEvent.get(key);
  if (backing) {
    if (emails.length) {
      const { frontmatter, body } = splitFrontmatter(readFileSync(backing, "utf8"));
      if (!Array.isArray(frontmatter.invitees) || frontmatter.invitees.length === 0) {
        if (APPLY) writeFileSync(backing, joinFrontmatter({ ...frontmatter, invitees: emails }, body));
        created.patched++;
      }
    }
    continue;
  }
  const dir = resolveDir(e.folder);
  const fm = { date: e.date };
  if (e.allDay) fm.allDay = true;
  if (e.time) fm.startTime = e.time;
  if (e.endTime) fm.endTime = e.endTime;
  if (e.endDate) fm.endDate = e.endDate;
  if (emails.length) fm.invitees = emails;
  let base = san(`${e.date} ${e.title}`) || `${e.date} Event`;
  let fn = `${base}.md`, i = 2;
  while (usedNames.has(join(dir, fn)) || existsSync(join(dir, fn))) { fn = `${base} (${i++}).md`; }
  usedNames.add(join(dir, fn));
  if (APPLY) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, fn), joinFrontmatter(fm, `# ${e.title}\n`)); }
  created.notes++;
}
console.log(APPLY ? "APPLIED" : "DRY RUN", "| dirs:", created.dirs, "| notes:", created.notes, "| invitees patched:", created.patched, "| unresolved->Unfiled:", created.unresolved);
console.log("\nNEW dirs to create:"); [...madeDirs].forEach((d)=>console.log("  ", d.replace(VAULT+"/","")));
console.log("\nUnresolved (non-JD) refs -> Unfiled:"); [...unresolvedRefs].forEach((r)=>console.log("  ", r));
