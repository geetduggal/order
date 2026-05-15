// Live-markdown editor backed by Milkdown Crepe. Crepe is a Prosemirror-
// based what-you-mean-is-what-you-get preset built for live markdown —
// this replaces the hand-rolled CodeMirror cursor-block reveal that was
// fighting CSS for the same effect. The component name is kept (CMEditor)
// so the rest of the app doesn't churn over a wire change.

import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

type Props = {
  doc: string;
  onChange: (doc: string) => void;
  onDone?: () => void;
  autofocus?: boolean;
};

export function CMEditor({ doc, onChange, onDone, autofocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Always call the latest props from inside the imperative Crepe API,
  // even though Crepe is constructed once per mount.
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    if (!host.current) return;
    let crepe: Crepe | null = null;
    let cancelled = false;

    crepe = new Crepe({
      root: host.current,
      defaultValue: doc,
    });

    crepe
      .create()
      .then(() => {
        if (cancelled || !crepe) return;
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        });
        if (autofocus) {
          // Crepe focuses on creation when defaultValue is empty, but we want
          // to be sure: find the contenteditable surface and focus it.
          const editable = host.current?.querySelector<HTMLElement>("[contenteditable=true]");
          editable?.focus();
        }
      })
      .catch((err: unknown) => {
        console.error("Crepe init failed:", err);
      });

    return () => {
      cancelled = true;
      crepe?.destroy();
      crepe = null;
    };
    // We intentionally mount Crepe once per parent change. Doc updates
    // from outside aren't expected during an active edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDoneRef.current?.();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onDoneRef.current?.();
    }
  }

  return <div className="cm-host milkdown-host" ref={host} onKeyDown={onKeyDown} />;
}
