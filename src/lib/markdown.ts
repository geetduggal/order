// CodeMirror 6 setup with Typora-style cursor-line markdown reveal.
// Off the cursor line, syntax markers (#, *, _, `, [[ ]]) are hidden.
// On the cursor line, raw markdown is visible so you can edit it.

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const HIDE_TOKENS = new Set([
  "HeaderMark",     // # ## ### …
  "EmphasisMark",   // * or _
  "CodeMark",       // ` for inline code
  "QuoteMark",      // > for blockquote
  "LinkMark",       // [ ] ( ) around links
  "URL",            // hide raw URL in [text](url)
]);

const hide = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const ranges: [number, number][] = [];

  // 1. Syntax-tree markers (everything @lezer/markdown understands).
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(node) {
        if (HIDE_TOKENS.has(node.name)) {
          const lineNum = view.state.doc.lineAt(node.from).number;
          if (lineNum !== cursorLine) ranges.push([node.from, node.to]);
        }
      },
    });
  }

  // 2. Wikilink brackets — not in the standard markdown grammar, do via regex.
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (line.number !== cursorLine) {
        for (const m of line.text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          const start = line.from + m.index!;
          ranges.push([start, start + 2]);
          ranges.push([start + m[0].length - 2, start + m[0].length]);
        }
      }
      pos = line.to + 1;
    }
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const [f, t] of ranges) {
    if (f < lastTo) continue;
    builder.add(f, t, hide);
    lastTo = t;
  }
  return builder.finish();
}

const cursorLineReveal = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations }
);

const orderHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "600", color: "#0a0a0a" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "600", color: "#0a0a0a" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "600", color: "#0a0a0a" },
  { tag: t.strong,   fontWeight: "700", color: "#0a0a0a" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link,     color: "#27408B", textDecoration: "none", borderBottom: "1px solid #e7edfb" },
  { tag: t.url,      color: "#4169E1" },
  { tag: t.monospace, fontFamily: "var(--mono)", background: "#f5f5f3", padding: "1px 4px", borderRadius: "3px" },
]);

const editorTheme = EditorView.theme({
  "&": { fontSize: "15px", color: "#1a1a1a" },
  ".cm-content": { fontFamily: "var(--serif)", padding: "0", caretColor: "#FF7F50" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "#FF7F50", borderLeftWidth: "2px" },
});

export function buildEditorState(doc: string, onChange: (doc: string) => void) {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(orderHighlight),
      editorTheme,
      cursorLineReveal,
      EditorView.lineWrapping,
      EditorView.updateListener.of(u => {
        if (u.docChanged) onChange(u.state.doc.toString());
      }),
    ],
  });
}
