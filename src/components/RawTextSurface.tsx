// Plain-text card surface. Used for `.txt` files (today: todo.txt) so
// Crepe doesn't escape `+`, `[`, etc. and corrupt the format. Matches
// MilkdownSurface's callback contract minimally — onChange fires on
// every keystroke, onDone on blur — so the Card's existing debounce-
// save pipeline keeps working unchanged.

import { useEffect, useRef } from "react";

type Props = {
  initial: string;
  onChange: (text: string) => void;
  onDone?: () => void;
  autoFocus?: boolean;
  readOnly?: boolean;
};

export function RawTextSurface({ initial, onChange, onDone, autoFocus, readOnly }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Mirror MilkdownSurface's pattern: callback refs so the textarea
  // listener never goes stale when the Card hands a new function in.
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  // Reflect external edits (file watcher reload) without remounting
  // the textarea — preserves the user's caret as long as the body
  // they're staring at didn't change.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    if (el.value !== initial) el.value = initial;
  }, [initial]);

  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Auto-grow so a long todo list expands the card the way a long
  // markdown note does — without scrolling inside a fixed-height box.
  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => { grow(); }, [initial]);

  return (
    <textarea
      ref={taRef}
      className="raw-text-surface"
      defaultValue={initial}
      readOnly={readOnly}
      spellCheck={false}
      onInput={(e) => {
        onChangeRef.current((e.target as HTMLTextAreaElement).value);
        grow();
      }}
      onBlur={() => onDoneRef.current?.()}
    />
  );
}
