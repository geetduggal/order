// Thin CodeMirror 6 wrapper for editing raw text files with syntax highlighting.
// Used for spacetime.yml (YAML) and spacetime.mw (Markdown). Accepts the same
// basic prop shape as RawTextSurface so callers can swap surfaces by file type.

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";

export type CodeMirrorLang = "markdown" | "yaml";

interface Props {
  value: string;
  onChange: (v: string) => void;
  lang: CodeMirrorLang;
  readOnly?: boolean;
}

export function CodeMirrorSurface({ value, onChange, lang, readOnly }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Mount once
  useEffect(() => {
    if (!host.current) return;
    const langExt = lang === "yaml" ? yaml() : markdown();
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(defaultHighlightStyle),
          lineNumbers(),
          langExt,
          EditorView.lineWrapping,
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "var(--note-font-size, 14px)" },
            ".cm-scroller": { fontFamily: "var(--mono)", overflow: "auto" },
            ".cm-content": { padding: "12px 16px", minHeight: "100%" },
            ".cm-gutters": {
              background: "var(--bg-elev)",
              borderRight: "1px solid var(--rule-soft)",
              color: "var(--ink-ghost)",
            },
            ".cm-activeLineGutter": { background: "transparent" },
            ".cm-activeLine": { background: "var(--royal-soft, rgba(0,0,0,0.04))" },
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]); // remount only when language changes

  // Sync external value changes without disrupting cursor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={host} className="cm-surface" />;
}
