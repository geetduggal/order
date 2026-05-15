// CodeMirror 6 setup with Obsidian-style live-preview markdown reveal.
//
// Within the BLOCK that contains the cursor (paragraph / heading /
// blockquote / list / fenced code), all markdown syntax markers stay
// visible so the user can edit them. Outside that block, the markers are
// hidden and the rendered text picks up styling from syntaxHighlighting.
// This is closer to how Obsidian's live editor feels than the previous
// cursor-LINE reveal, which fragmented multi-line constructs.

import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Pure-syntax nodes whose source text is hidden away from the cursor.
const HIDE_TOKENS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "URL",
  "ListMark",
  "StrikethroughMark",
  "SetextHeading1Mark",
  "SetextHeading2Mark",
  "TaskMarker",
]);

// Block-level nodes — the smallest one containing the cursor is left
// fully visible. We don't include Document so the root never qualifies.
const BLOCK_NODES = new Set([
  "Paragraph",
  "ATXHeading1", "ATXHeading2", "ATXHeading3",
  "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
  "Blockquote",
  "BulletList", "OrderedList", "ListItem",
  "FencedCode", "CodeBlock",
  "HTMLBlock",
  "Table",
]);

const hide = Decoration.replace({});

interface CursorBlock {
  from: number;
  to: number;
}

function findCursorBlock(state: EditorState, pos: number): CursorBlock | null {
  let best: CursorBlock | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (!BLOCK_NODES.has(node.name)) return;
      if (node.from > pos || node.to < pos) return;
      // Pick the smallest enclosing block — list items beat their parent list.
      if (!best || (node.to - node.from) < (best.to - best.from)) {
        best = { from: node.from, to: node.to };
      }
    },
  });
  return best;
}

function isInside(range: { from: number; to: number }, outer: CursorBlock | null): boolean {
  if (!outer) return false;
  return range.from >= outer.from && range.to <= outer.to;
}

function pushSyntaxMarkRanges(
  view: EditorView,
  cursorBlock: CursorBlock | null,
  ranges: [number, number][],
): void {
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        if (!HIDE_TOKENS.has(node.name)) return;
        if (isInside({ from: node.from, to: node.to }, cursorBlock)) return;
        ranges.push([node.from, node.to]);
      },
    });
  }
}

function pushWikilinkBracketRanges(
  view: EditorView,
  cursorBlock: CursorBlock | null,
  ranges: [number, number][],
): void {
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (const m of line.text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
        const start = line.from + m.index!;
        const openRange = { from: start, to: start + 2 };
        const closeRange = { from: start + m[0].length - 2, to: start + m[0].length };
        if (!isInside(openRange, cursorBlock)) ranges.push([openRange.from, openRange.to]);
        if (!isInside(closeRange, cursorBlock)) ranges.push([closeRange.from, closeRange.to]);
      }
      pos = line.to + 1;
    }
  }
}

// Line-class decorations: every line inside a FencedCode block gets
// .cm-codeblock, every line inside a Blockquote gets .cm-blockquote.
// CSS in styles.css handles the surface (bg, monospace, left border, etc.)
interface LineClass { line: number; cls: string }

function collectBlockLines(view: EditorView): LineClass[] {
  const lines: LineClass[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        let cls: string | null = null;
        if (node.name === "FencedCode" || node.name === "CodeBlock") cls = "cm-codeblock";
        else if (node.name === "Blockquote") cls = "cm-blockquote";
        if (!cls) return;
        const startLine = view.state.doc.lineAt(node.from).number;
        const endLine = view.state.doc.lineAt(node.to).number;
        for (let n = startLine; n <= endLine; n++) lines.push({ line: n, cls });
      },
    });
  }
  return lines;
}

// Inline code spans (backtick-delimited, not inside a fenced block) get
// the "pill" styling via a mark decoration with class .cm-inline-code.
const inlineCodeMark = Decoration.mark({ class: "cm-inline-code" });

function collectInlineCodeRanges(view: EditorView): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        if (node.name !== "InlineCode") return;
        out.push({ from: node.from, to: node.to });
      },
    });
  }
  return out;
}

function buildDecorations(view: EditorView): DecorationSet {
  const cursorBlock = findCursorBlock(view.state, view.state.selection.main.head);
  const ranges: [number, number][] = [];

  pushSyntaxMarkRanges(view, cursorBlock, ranges);
  pushWikilinkBracketRanges(view, cursorBlock, ranges);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const lineClasses = collectBlockLines(view);
  const inlineCodes = collectInlineCodeRanges(view);

  // Build a flat entry list: line decorations (from === to at line start),
  // inline-code mark decorations, and hide-replace decorations. Sort by
  // from, then by length (smaller first per CM's RangeSet contract).
  type Entry = { from: number; to: number; deco: Decoration };
  const entries: Entry[] = [];

  for (const lc of lineClasses) {
    const line = view.state.doc.line(lc.line);
    entries.push({ from: line.from, to: line.from, deco: Decoration.line({ attributes: { class: lc.cls } }) });
  }
  for (const ic of inlineCodes) {
    entries.push({ from: ic.from, to: ic.to, deco: inlineCodeMark });
  }
  let lastTo = -1;
  for (const [f, end] of ranges) {
    if (f < lastTo) continue;
    entries.push({ from: f, to: end, deco: hide });
    lastTo = end;
  }

  entries.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) builder.add(e.from, e.to, e.deco);
  return builder.finish();
}

const cursorBlockReveal = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

const orderHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "600", color: "#0a0a0a", lineHeight: "1.2" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "600", color: "#0a0a0a", lineHeight: "1.25" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600", color: "#0a0a0a" },
  { tag: t.heading4, fontWeight: "600", color: "#0a0a0a" },
  { tag: t.heading5, fontWeight: "600", color: "#0a0a0a" },
  { tag: t.heading6, fontWeight: "600", color: "#0a0a0a" },
  { tag: t.strong, fontWeight: "700", color: "#0a0a0a" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#8a8a87" },
  { tag: t.link, color: "#27408B", textDecoration: "none", borderBottom: "1px solid #e7edfb" },
  { tag: t.url, color: "#4169E1" },
  // Only font-family here so the rule doesn't fight with .cm-codeblock's
  // block-level surface. Inline code's "pill" background is applied via
  // a separate mark decoration (see inlineCodeMark below).
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: t.quote, color: "#4f4f4d", fontStyle: "italic" },
]);

const editorTheme = EditorView.theme({
  "&": { fontSize: "15px", color: "#1a1a1a" },
  ".cm-content": { fontFamily: "var(--serif)", padding: "0", caretColor: "#FF7F50" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "#FF7F50", borderLeftWidth: "2px" },
  // Fenced-code lines pick up a subtle background + monospace. Lezer's
  // markdown plugin tags the entire FencedCode block, so we style the
  // contained .cm-line directly via syntax-highlight class is awkward —
  // simplest: rely on .cm-line:has selector against the code content's
  // ProseMirror-ish styling. We can't reliably match here without an
  // extra view plugin, so leave code-block surface plain for now and
  // let the inline t.monospace style cover ` … ` spans.
});

export function buildEditorState(
  doc: string,
  onChange: (doc: string) => void,
  extra: Extension = [],
) {
  return EditorState.create({
    doc,
    extensions: [
      // Caller's extras (e.g. Esc-to-close) get highest precedence so they
      // outrank defaultKeymap's own handlers for the same chords.
      extra,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Use the GFM-aware language so strikethrough, task lists, tables,
      // and autolinks all parse correctly.
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(orderHighlight),
      editorTheme,
      cursorBlockReveal,
      EditorView.lineWrapping,
      EditorView.updateListener.of(u => {
        if (u.docChanged) onChange(u.state.doc.toString());
      }),
    ],
  });
}
