// Thin React wrapper around CodeMirror 6. Caller provides initial doc + onChange.

import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { buildEditorState } from "../lib/markdown";

type Props = {
  doc: string;
  onChange: (doc: string) => void;
  onBlur?: () => void;
  autofocus?: boolean;
};

export function CMEditor({ doc, onChange, onBlur, autofocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      state: buildEditorState(doc, onChange),
      parent: host.current,
    });
    view.current = v;
    if (autofocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // We intentionally only mount once per parent change. Doc updates from
    // outside aren't expected during an active edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="cm-host" ref={host} onBlur={onBlur} />;
}
