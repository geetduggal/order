// E2E harness: boots Order in a plain browser with a mocked Tauri IPC
// layer backed by an in-memory vault seeded from tests/e2e/fixtures/vault.
//
// The mock implements window.__TAURI_INTERNALS__ — the single seam every
// @tauri-apps/api call goes through — so the React app runs unmodified.
// File writes mutate the in-memory store; tests assert against it via
// page.evaluate(() => window.__VAULT__.files[...]).

import { promises as fs } from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.join(__dirname, "fixtures", "vault");

export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Read the fixture vault into a {relPath: content} map. `{{TODAY}}`
 *  in paths and bodies becomes today's ISO date so calendar events
 *  always land in the visible week. Binary files become `null`
 *  (existence + a fake byte length is all the tests need). */
export async function fixtureFiles(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const today = todayIso();
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, r);
      else if (/\.(md|txt)$/.test(entry.name)) {
        out[r.replaceAll("{{TODAY}}", today)] =
          (await fs.readFile(abs, "utf8")).replaceAll("{{TODAY}}", today);
      } else {
        out[r.replaceAll("{{TODAY}}", today)] = null;
      }
    }
  }
  await walk(FIXTURE_DIR, "");
  return out;
}

export interface BootOptions {
  /** Enable todo.txt mode (Settings toggle) before load. */
  todoTxt?: boolean;
}

/** Install the Tauri IPC mock + seed localStorage, then load the app
 *  and wait for the dock (i.e. notes loaded). */
export async function bootVault(page: Page, opts: BootOptions = {}): Promise<void> {
  const files = await fixtureFiles();
  const seeds: Record<string, string> = {
    "order.vaultPath": "/Vault",
    "order.theme": "light",
    // Sidebar open so the filter-pill stack (the tests' main filter
    // oracle) is in the DOM.
    "order.sidebar.open": "1",
    ...(opts.todoTxt ? { "order.todoTxt.enabled": "1", "order.todoTxt.path": "todo.txt" } : {}),
  };

  await page.addInitScript(installMock, { files, seeds });
  await page.goto("/");
  await page.waitForSelector(".bottom-dock", { timeout: 15_000 });
  // The sidebar always boots closed; the filter-pill stack inside it is
  // the tests' primary "what is filtered right now" oracle, so open it.
  // (The stack itself renders only when ≥1 filter is active, so wait on
  // the sidebar shell, not the pills.)
  await page.click('.bottom-dock button[aria-label="Show sidebar"], .bottom-dock button[title="Show sidebar"]');
  await page.waitForSelector(".shell.sidebar-open", { timeout: 5_000 });
}

/** Fire a Tauri event (e.g. `tauri://drag-drop`) into every listener the
 *  app registered through the mocked event plugin. */
export async function emitTauriEvent(page: Page, event: string, payload: unknown): Promise<void> {
  await page.evaluate(([evt, pl]) => {
    const w = window as any;
    const ids: number[] = w.__TAURI_LISTENERS?.[evt as string] ?? [];
    for (const id of ids) w.__TAURI_CBS?.[id]?.({ event: evt, id: 0, payload: pl });
  }, [event, payload] as const);
}

/** The init script. Runs in the page before any app code. Serialized by
 *  Playwright, so it must be self-contained — no outer-scope capture. */
function installMock(arg: { files: Record<string, string | null>; seeds: Record<string, string> }) {
  const w = window as any;
  for (const [k, v] of Object.entries(arg.seeds)) localStorage.setItem(k, v);

  // ----- in-memory vault -----
  const ROOT = "/Vault";
  const files = new Map<string, string | null>(Object.entries(arg.files));
  w.__VAULT__ = {
    get files() { return Object.fromEntries(files); },
    read: (rel: string) => files.get(rel),
    has: (rel: string) => files.has(rel),
  };
  w.__OPENED = [];     // open_url / open_path invocations
  w.__INVOKED = [];    // every command, for debugging + assertions

  const norm = (rel: string) => rel.replace(/^\.?\//, "");
  const isMd = (p: string) => p.endsWith(".md");
  const base = (p: string) => p.split("/").pop() ?? p;
  const splitFm = (raw: string): [string, number] => {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return ["", raw.length];
    return [m[1], raw.length - m[0].length];
  };
  const childrenOf = (rel: string) => {
    const prefix = rel ? norm(rel) + "/" : "";
    const out = new Map<string, boolean>(); // name -> isDir
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) out.set(rest, false);
      else out.set(rest.slice(0, slash), true);
    }
    return out;
  };

  // ----- event plugin -----
  let cbId = 0;
  w.__TAURI_CBS = {} as Record<number, (e: unknown) => void>;
  w.__TAURI_LISTENERS = {} as Record<string, number[]>;

  const commands: Record<string, (args: any) => unknown> = {
    vault_set_root: () => null,
    vault_is_ios: () => false,
    vault_walk: () =>
      [...files.keys()].filter(isMd).map((p) => ({ path: `${ROOT}/${p}`, name: base(p) })),
    vault_walk_metadata: () =>
      [...files.keys()]
        .filter((p) => isMd(p) || p.endsWith(".txt"))
        .map((p) => {
          const raw = files.get(p) ?? "";
          const [fm, bodyLen] = typeof raw === "string" ? splitFm(raw) : ["", 0];
          return { path: `${ROOT}/${p}`, name: base(p), frontmatter: fm, body_len: bodyLen, mtime_ms: Date.now() };
        }),
    vault_read_text: (a) => {
      const v = files.get(norm(a.rel));
      if (typeof v !== "string") throw new Error(`not found: ${a.rel}`);
      return v;
    },
    vault_write_text: (a) => { files.set(norm(a.rel), a.content); return null; },
    vault_write_binary: (a) => { files.set(norm(a.rel), null); return null; },
    vault_read_dir: (a) =>
      [...childrenOf(a.rel)].map(([name, isDir]) => ({ name, is_dir: isDir })),
    vault_list_dir: (a) =>
      [...childrenOf(a.rel)].map(([name, isDir]) => ({ name, is_dir: isDir, mtime: Date.now() / 1000, size: 64 })),
    vault_import_files: (a) => {
      const written: string[] = [];
      for (const src of a.sources as string[]) {
        const name = base(src);
        files.set(norm(a.destRel ? `${a.destRel}/${name}` : name), null);
        written.push(name);
      }
      return written;
    },
    vault_exists: (a) => {
      const r = norm(a.rel);
      if (files.has(r)) return true;
      const prefix = r + "/";
      for (const p of files.keys()) if (p.startsWith(prefix)) return true;
      return false;
    },
    vault_stat: () => ({ mtime: Date.now() / 1000, size: 64 }),
    vault_rename: (a) => {
      const from = norm(a.from), to = norm(a.to);
      if (files.has(from)) { files.set(to, files.get(from) ?? null); files.delete(from); return null; }
      // dir rename: move every key under the prefix
      const fp = from + "/";
      for (const p of [...files.keys()]) {
        if (p.startsWith(fp)) { files.set(to + "/" + p.slice(fp.length), files.get(p) ?? null); files.delete(p); }
      }
      return null;
    },
    vault_remove: (a) => {
      const r = norm(a.rel);
      files.delete(r);
      const prefix = r + "/";
      for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p);
      return null;
    },
    fts_build_index: () => 0,
    fts_load_index: () => 0,
    fts_search: () => [],
    start_watcher: () => null,
    open_url: (a) => { w.__OPENED.push({ kind: "url", value: a.url }); return null; },
    open_path: (a) => { w.__OPENED.push({ kind: "path", value: a.path }); return null; },
    "plugin:vault|pick_folder": () => ({ path: null, name: null }),
    "plugin:vault|restore": () => ({ path: null, name: null }),
    "plugin:vault|openUrl": (a) => { w.__OPENED.push({ kind: "url", value: a.url }); return null; },
    "plugin:path|resolve_directory": () => "/MockHome",
    "plugin:path|join": (a) => (a.paths as string[]).filter(Boolean).join("/").replace(/\/{2,}/g, "/"),
    "plugin:path|basename": (a) => base(a.path),
    "plugin:path|dirname": (a) => a.path.split("/").slice(0, -1).join("/"),
    "plugin:event|listen": (a) => {
      const evt = a.event as string;
      (w.__TAURI_LISTENERS[evt] ??= []).push(a.handler as number);
      return ++cbId; // event id used by unlisten
    },
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": () => null,
  };

  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb: (e: unknown) => void) => {
      const id = ++cbId;
      w.__TAURI_CBS[id] = cb;
      return id;
    },
    unregisterCallback: (id: number) => { delete w.__TAURI_CBS[id]; },
    convertFileSrc: (p: string, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(p)}`,
    invoke: async (cmd: string, args: any) => {
      w.__INVOKED.push([cmd, args]);
      const fn = commands[cmd];
      if (!fn) {
        console.warn("[tauri-mock] unhandled command:", cmd, args);
        return null;
      }
      return fn(args ?? {});
    },
  };
}
