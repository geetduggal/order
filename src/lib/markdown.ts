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

function buildDecorations(view: EditorView): DecorationSet {
  const cursorBlock = findCursorBlock(view.state, view.state.selection.main.head);
  const ranges: [number, number][] = [];

  pushSyntaxMarkRanges(view, cursorBlock, ranges);
  pushWikilinkBracketRanges(view, cursorBlock, ranges);

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const [f, end] of ranges) {
    if (f < lastTo) continue;
    builder.add(f, end, hide);
    lastTo = end;
  }
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
  { tag: t.monospace, fontFamily: "var(--mono)", background: "#f5f5f3", padding: "1px 4px", borderRadius: "3px" },
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
