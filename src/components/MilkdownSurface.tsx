// Thin imperative wrapper around Milkdown Crepe.
// Crepe owns the document state — we hand it the initial markdown once
// and subscribe to markdownUpdated for changes. We deliberately do NOT
// react to `initial` prop changes after mount: this surface is a
// single-edit-session component. The parent controls its lifetime by
// remounting it (key prop) when it wants a fresh document.

import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

type Props = {
  initial: string;
  onChange: (markdown: string) => void;
  onDone?: () => void;
};

export function MilkdownSurface({ initial, onChange, onDone }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let crepe: Crepe | null = null;

    crepe = new Crepe({ root: host.current, defaultValue: initial });

    crepe
      .create()
      .then(() => {
        if (cancelled || !crepe) return;
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        });
      })
      .catch((err: unknown) => {
        console.error("Crepe init failed:", err);
      });

    return () => {
      cancelled = true;
      crepe?.destroy();
      crepe = null;
    };
    // Single-mount editor; see top-of-file note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      onDoneRef.current?.();
    }
  }

  return <div className="milkdown-host" ref={host} onKeyDown={onKeyDown} />;
}
