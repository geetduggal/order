// In-editor Mermaid diagram rendering for ```mermaid fenced code blocks.
//
// Milkdown/Crepe renders a fenced code block as an editable (CodeMirror)
// source block — great for editing, but a ```mermaid block just shows the
// raw diagram source. This plugin walks the doc, finds fenced code blocks
// whose language is `mermaid`, and mounts a widget decoration right after
// each one that renders the diagram as an SVG.
//
// Same shape as the YouTube / video plugins: decorations only, so the
// document is never mutated and the round-trip back to ```mermaid on save
// is untouched. The source stays visible and editable above the render, so
// a diagram that fails to parse can always be fixed (the widget shows the
// Mermaid error rather than trapping you with an uneditable block).
//
// `mermaid` is a large library, so it is dynamically imported the first
// time a mermaid block is actually rendered — it stays out of the main
// bundle for notes that have no diagrams.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

const KEY = new PluginKey("order-mermaid");

// --- lazy mermaid loader -------------------------------------------------

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

function ensureMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default as unknown as MermaidApi;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "neutral",
        fontFamily: "inherit",
        flowchart: { useMaxWidth: true, htmlLabels: true },
        sequence: { useMaxWidth: true },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

// --- render cache (keyed by exact source) --------------------------------

const svgCache = new Map<string, string>();

function buildMermaid(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "order-mermaid";
  wrap.setAttribute("contenteditable", "false");
  const cached = svgCache.get(code);
  if (cached) {
    wrap.innerHTML = cached;
    return wrap;
  }
  wrap.classList.add("is-loading");
  void renderInto(wrap, code);
  return wrap;
}

async function renderInto(wrap: HTMLElement, code: string): Promise<void> {
  try {
    const mermaid = await ensureMermaid();
    const id = "order-mmd-" + Math.random().toString(36).slice(2, 10);
    const { svg } = await mermaid.render(id, code);
    svgCache.set(code, svg);
    wrap.innerHTML = svg;
    wrap.classList.remove("is-loading");
  } catch (err) {
    wrap.classList.remove("is-loading");
    wrap.classList.add("is-error");
    const msg = err instanceof Error ? err.message : String(err);
    wrap.textContent = "Mermaid: " + msg.split("\n")[0];
    // mermaid injects a stray error <svg id="d…"> into <body> on a parse
    // failure; drop any such orphan left outside our wrapper.
    document.querySelectorAll('body > [id^="order-mmd-"]').forEach((el) => el.remove());
  }
}

// --- doc scan ------------------------------------------------------------

function isMermaidBlock(node: ProseNode): boolean {
  if (node.type.name !== "code_block" && node.type.name !== "fence") return false;
  const lang = String((node.attrs as { language?: unknown })?.language ?? "")
    .trim()
    .toLowerCase();
  return lang === "mermaid";
}

function findMermaidTargets(doc: ProseNode): { end: number; code: string }[] {
  const out: { end: number; code: string }[] = [];
  doc.descendants((node, pos) => {
    if (isMermaidBlock(node)) {
      const code = node.textContent.trim();
      if (code) out.push({ end: pos + node.nodeSize, code });
      return false; // don't recurse into the code block's text
    }
    return undefined;
  });
  return out;
}

function hashCode(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function mermaidPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          decorations(state) {
            const targets = findMermaidTargets(state.doc);
            if (targets.length === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            targets.forEach(({ end, code }, i) => {
              // Mount the rendered diagram right after the source block.
              // The content-hash key lets ProseMirror reuse the widget
              // across rerenders (and cached SVGs make a remount cheap),
              // so we don't re-render on every keystroke elsewhere.
              decos.push(
                Decoration.widget(end, () => buildMermaid(code), {
                  key: `mmd-${hashCode(code)}-${i}`,
                  side: 1,
                  ignoreSelection: true,
                }),
              );
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );
}
