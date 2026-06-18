// Thin CodeMirror 6 wrapper for editing raw text files with syntax highlighting.
// Used for spacetime.yml (YAML) and spacetime.mw (Markdown).

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
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

  // Mount once per language change
  useEffect(() => {
    if (!host.current) return;
    const langExt = lang === "yaml" ? yaml() : markdown();
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          lineNumbers(),
          langExt,
          oneDark,
          // No lineWrapping — horizontal scroll for long lines
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "var(--note-font-size, 14px)" },
            ".cm-scroller": { fontFamily: "var(--mono)", overflow: "auto" },
            ".cm-content": { padding: "12px 16px", minHeight: "100%", whiteSpace: "pre" },
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Sync external value changes without disrupting cursor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className="cm-surface" />;
}
