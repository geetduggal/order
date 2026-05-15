// Thin React wrapper around CodeMirror 6. Caller provides initial doc + onChange.
// Closing the editor is the parent's responsibility — the user signals "done"
// via Esc or Cmd/Ctrl+Enter, never via accidental focus loss.

import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { buildEditorState } from "../lib/markdown";

type Props = {
  doc: string;
  onChange: (doc: string) => void;
  onDone?: () => void;
  autofocus?: boolean;
};

export function CMEditor({ doc, onChange, onDone, autofocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Always call the latest onDone, even if the component captured an old prop
  // at mount time (the CodeMirror state is only built once per session).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!host.current) return;
    const doneKeymap = Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: () => {
            onDoneRef.current?.();
            return true;
          },
        },
        {
          key: "Mod-Enter",
          run: () => {
            onDoneRef.current?.();
            return true;
          },
        },
      ]),
    );
    const v = new EditorView({
      state: buildEditorState(doc, onChange, doneKeymap),
      parent: host.current,
    });
    view.current = v;
    if (autofocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // We intentionally only mount once per parent change. Doc updates from
    // outside aren't expected during an active edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="cm-host" ref={host} />;
}
