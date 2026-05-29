// Parser for the `base` code block subset Order supports inside a
// list folder's body. Matches Obsidian Bases syntax for the pieces we
// care about; anything outside the subset is collected into an
// `unsupported` list so the UI can surface a one-line hint instead of
// failing. Pure module — no I/O.

import yaml from "js-yaml";

export type Predicate = { kind: "contains"; prop: string; needle: string };
export type Filter = Predicate | { and: Filter[] } | { or: Filter[] };

export interface View {
  type: "cards" | "lines";
  name?: string;
  filters?: Filter;
  sort?: { prop: string; dir: "asc" | "desc" };
  image?: string;
}

export interface ParsedBase {
  outerFilters?: Filter;
  view: View;
  unsupported: string[];
}

const FENCE_RE = /^```[ \t]*base[ \t]*\n([\s\S]*?)\n```/m;

export function extractBaseBlock(body: string): string | null {
  const m = body.match(FENCE_RE);
  return m ? m[1] : null;
}

/** Returns the full ```base ... ``` fence (including delimiters) so a
 *  caller can strip it from a prose-only editor view and reattach it
 *  verbatim on save. */
export function extractRawBaseBlock(body: string): string | null {
  const m = body.match(FENCE_RE);
  return m ? m[0] : null;
}

function parsePredicate(s: unknown, ignored: string[]): Predicate | null {
  if (typeof s !== "string") {
    ignored.push(`non-string predicate: ${JSON.stringify(s)}`);
    return null;
  }
  const m = s.match(/^([\w.]+)\.contains\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/);
  if (!m) {
    ignored.push(`unsupported predicate: ${s}`);
    return null;
  }
  return { kind: "contains", prop: m[1], needle: m[2] };
}

function parseFilter(node: unknown, ignored: string[]): Filter | undefined {
  if (node == null) return undefined;
  if (typeof node === "string") {
    const pred = parsePredicate(node, ignored);
    return pred ?? undefined;
  }
  if (Array.isArray(node)) {
    const items = node
      .map((n) => parseFilter(n, ignored))
      .filter((x): x is Filter => !!x);
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : { and: items };
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.and)) {
      const items = obj.and.map((n) => parseFilter(n, ignored)).filter((x): x is Filter => !!x);
      return { and: items };
    }
    if (Array.isArray(obj.or)) {
      const items = obj.or.map((n) => parseFilter(n, ignored)).filter((x): x is Filter => !!x);
      return { or: items };
    }
  }
  ignored.push(`unsupported filter shape: ${JSON.stringify(node)}`);
  return undefined;
}

function parseSort(
  node: unknown, ignored: string[],
): { prop: string; dir: "asc" | "desc" } | undefined {
  if (!Array.isArray(node) || node.length === 0) return undefined;
  if (node.length > 1) ignored.push("multi-key sort: using only the first key");
  const first = node[0];
  if (!first || typeof first !== "object") return undefined;
  const f = first as Record<string, unknown>;
  if (typeof f.property !== "string") return undefined;
  const dir =
    typeof f.direction === "string" && f.direction.toLowerCase() === "desc"
      ? "desc" : "asc";
  return { prop: f.property, dir };
}

function parseImage(node: unknown): string | undefined {
  if (typeof node !== "string") return undefined;
  const m = node.match(/^note\.(.+)$/);
  return m ? m[1] : node;
}

function parseView(node: unknown, ignored: string[]): View {
  const obj = (node && typeof node === "object" ? node : {}) as Record<string, unknown>;
  let type: View["type"] = "cards";
  if (obj.type === "lines") type = "lines";
  else if (typeof obj.type === "string" && obj.type !== "cards") {
    ignored.push(`view.type="${obj.type}" not supported; falling back to lines`);
    type = "lines";
  }
  return {
    type,
    name: typeof obj.name === "string" ? obj.name : undefined,
    filters: parseFilter(obj.filters, ignored),
    sort: parseSort(obj.sort, ignored),
    image: parseImage(obj.image),
  };
}

export function parseBase(blockBody: string): ParsedBase | null {
  let doc: unknown;
  try { doc = yaml.load(blockBody); } catch { return null; }
  if (!doc || typeof doc !== "object") return null;
  const obj = doc as Record<string, unknown>;
  const ignored: string[] = [];

  const outerFilters = parseFilter(obj.filters, ignored);
  const views = Array.isArray(obj.views) ? obj.views : [];
  if (views.length === 0) return null;
  if (views.length > 1) ignored.push(`${views.length - 1} additional view(s) ignored`);
  const view = parseView(views[0], ignored);

  return { outerFilters, view, unsupported: ignored };
}
