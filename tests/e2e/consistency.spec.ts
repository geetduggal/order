// Vault-on-disk consistency checks (goal 1d + 1e). Pure Node — no
// browser. By default they validate the test fixture vault; point
// ORDER_VAULT at any real vault (e.g. the demo vault) to lint it:
//
//   ORDER_VAULT=~/Dropbox/OrderDemoVault pnpm test:e2e consistency
//
// 1d — structure: the Areas.md → Area → Category → Notable Folder chain
//      described in markdown matches the directory tree, every
//      `folder: [[NF]]` note lives inside its NF's directory, and every
//      `![[image]]` embed resolves to a file in the same NF directory.
// 1e — todo.txt: when a todo.txt exists, every .md calendar event has
//      an identity-matching line, and every line parses cleanly.

import { test, expect } from "@playwright/test";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { parseTodoTxt, eventKey } from "../../src/lib/todo-txt";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT = (process.env.ORDER_VAULT ?? path.join(__dirname, "fixtures", "vault"))
  .replace(/^~(?=\/)/, os.homedir());

// Both the fixture's {{TODAY}} placeholders and the live todo.txt
// comparison use the same date, so fixture and real vaults lint alike.
const TODAY = new Date().toISOString().slice(0, 10);

interface Note { rel: string; fm: Record<string, string>; body: string }

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const BULLET_RE = /^[-*+]\s+\[\[([^\]|]+)\]\]/gm;

function parseFmLite(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function bulletsOf(body: string): string[] {
  return [...body.matchAll(BULLET_RE)].map((m) => m[1].trim());
}

function stripRef(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/\[\[(.+)\]\]/);
  return (m ? m[1] : v).trim() || null;
}

async function loadVault(): Promise<Note[]> {
  const notes: Note[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "Attachments") continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.name.endsWith(".md")) {
        const raw = (await fs.readFile(abs, "utf8")).replaceAll("{{TODAY}}", TODAY);
        const m = raw.match(FM_RE);
        notes.push({
          rel: r,
          fm: m ? parseFmLite(m[1]) : {},
          body: m ? raw.slice(m[0].length) : raw,
        });
      }
    }
  }
  await walk(VAULT, "");
  return notes;
}

test.describe("1d — disk structure matches the markdown chain", () => {
  test("Areas → Categories → Notable Folders chain is consistent", async () => {
    const notes = await loadVault();
    const byRel = new Map(notes.map((n) => [n.rel, n]));
    const areasNote = notes.find((n) => n.fm.role === "areas")
      ?? notes.find((n) => n.rel === "Areas.md");
    expect(areasNote, "vault has an Areas.md (role: areas)").toBeTruthy();

    for (const area of bulletsOf(areasNote!.body)) {
      const areaMd = `${area}/${area}.md`;
      expect(byRel.has(areaMd), `area file ${areaMd} exists`).toBe(true);
      for (const cat of bulletsOf(byRel.get(areaMd)!.body)) {
        const catMd = `${area}/${cat}/${cat}.md`;
        expect(byRel.has(catMd), `category file ${catMd} exists`).toBe(true);
        for (const nf of bulletsOf(byRel.get(catMd)!.body)) {
          const nfMd = `${area}/${cat}/${nf}/${nf}.md`;
          expect(byRel.has(nfMd), `NF main doc ${nfMd} exists`).toBe(true);
          const nfFm = byRel.get(nfMd)!.fm;
          expect(stripRef(nfFm.category), `${nf} category matches parent dir`).toBe(cat);
        }
      }
    }
  });

  test("every folder: note lives inside its Notable Folder directory", async () => {
    const notes = await loadVault();
    // NF name -> directory rel
    const nfDirs = new Map<string, string>();
    for (const n of notes) {
      if (n.fm.category) {
        nfDirs.set(path.basename(n.rel, ".md"), path.dirname(n.rel));
      }
    }
    for (const n of notes) {
      const folder = stripRef(n.fm.folder);
      if (!folder) continue;
      const nfDir = nfDirs.get(folder);
      if (!nfDir) continue; // dangling folder ref — separate lint, not structure
      expect(
        path.dirname(n.rel),
        `${n.rel} lives inside its NF directory (${nfDir})`,
      ).toBe(nfDir);
    }
  });

  test("every ![[image]] embed resolves inside the note's own directory", async () => {
    const notes = await loadVault();
    const EMBED_RE = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
    for (const n of notes) {
      for (const m of n.body.matchAll(EMBED_RE)) {
        const file = m[1].trim();
        if (file.endsWith(".md")) continue;
        const local = path.join(VAULT, path.dirname(n.rel), file);
        const exists = await fs.access(local).then(() => true, () => false);
        expect(exists, `${n.rel} embeds ${file} — must exist next to the note`).toBe(true);
      }
    }
  });
});

test.describe("1e — todo.txt agrees with .md calendar events", () => {
  test("every .md event has a matching todo.txt line; every line parses", async () => {
    const todoPath = path.join(VAULT, "todo.txt");
    const hasTodo = await fs.access(todoPath).then(() => true, () => false);
    test.skip(!hasTodo, "vault has no todo.txt");

    const body = (await fs.readFile(todoPath, "utf8")).replaceAll("{{TODAY}}", TODAY);
    const items = parseTodoTxt(body);

    // Every non-blank line yields a parsed item — no silent garbage.
    const lineCount = body.split(/\r?\n/).filter((l) => l.trim()).length;
    expect(items.length, "all todo.txt lines parse").toBe(lineCount);

    const lineKeys = new Set(items.map((i) =>
      eventKey({ date: i.due, startTime: i.startTime, title: i.text })));

    const notes = await loadVault();
    for (const n of notes) {
      const date = n.fm.date?.slice(0, 10);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const allDay = n.fm.allDay === "true";
      const startTime = /^\d{2}:\d{2}$/.test(n.fm.startTime ?? "") ? n.fm.startTime : undefined;
      if (!allDay && !startTime) continue; // dated reference, not an event
      const title = n.fm.title || path.basename(n.rel, ".md").replace(/^\d{4}-\d{2}-\d{2}\s*/, "");
      const k = eventKey({ date, startTime, title });
      expect(lineKeys.has(k), `.md event "${title}" (${n.rel}) mirrored in todo.txt`).toBe(true);
    }
  });
});
