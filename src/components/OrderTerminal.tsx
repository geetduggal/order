// Inline, Order-branded terminal — a real PTY rendered with xterm.js.
// Backed by src-tauri/terminal.rs (portable-pty), so vim, htop, less,
// colors, and line editing all work like a native terminal. The whole
// card body becomes this when toggled on.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Order palette → xterm theme. Black field; royal-blue default text;
// coral cursor. The 16 ANSI slots lean on the two brand accents plus
// neutral tints so `ls --color`, git, vim syntax stay legible.
const ORDER_XTERM_THEME = {
  background: "#000000",
  foreground: "#9bb0ff",
  cursor: "#ff7f50",
  cursorAccent: "#000000",
  selectionBackground: "#23314f",
  black: "#11151f",
  red: "#ff7f50",
  green: "#7ad6a0",
  yellow: "#e8c372",
  blue: "#6b8cff",
  magenta: "#c08cff",
  cyan: "#6fd3d3",
  white: "#cdd6f4",
  brightBlack: "#5a6488",
  brightRed: "#ff9b78",
  brightGreen: "#9be8bd",
  brightYellow: "#f3d699",
  brightBlue: "#9bb0ff",
  brightMagenta: "#d4b0ff",
  brightCyan: "#9be8e8",
  brightWhite: "#ffffff",
};

const MONO = '"Menlo", "SF Mono", "JetBrains Mono", "Monaco", "Consolas", monospace';

interface Props {
  /** Absolute starting directory (the Notable Folder's path). */
  cwd: string;
}

export function OrderTerminal({ cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: ORDER_XTERM_THEME,
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const session = `t${Date.now()}-${Math.floor(performance.now())}`;
    let disposed = false;
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    // PTY → xterm.
    void listen<{ session: string; data: string }>("terminal://data", (e) => {
      if (e.payload.session === session) term.write(e.payload.data);
    }).then((u) => { if (disposed) u(); else unlistenData = u; });
    void listen<{ session: string }>("terminal://exit", (e) => {
      if (e.payload.session !== session) return;
      term.write("\r\n\x1b[38;2;90;100;136m[session ended]\x1b[0m\r\n");
    }).then((u) => { if (disposed) u(); else unlistenExit = u; });

    // xterm keystrokes → PTY.
    const onData = term.onData((data) => {
      void invoke("terminal_write", { session, data }).catch(() => { /* closed */ });
    });

    // Open the PTY sized to the fitted grid, then focus.
    void invoke("terminal_open", {
      session, cwd, cols: term.cols, rows: term.rows,
    })
      .then(() => term.focus())
      .catch((err) => {
        term.write(`\x1b[38;2;255;127;80m${String(err)}\x1b[0m\r\n`);
      });

    // Refit + tell the PTY on container resize. The host has a definite
    // height, so the only legit resizes are window/width changes — gate
    // fit() on a real pixel-size change so a masonry re-measure or
    // scroll-triggered observer fire can't refit (and can't feed the
    // growth loop). Then only message the PTY when the grid changed.
    let lastW = host.clientWidth;
    let lastH = host.clientHeight;
    let lastCols = term.cols;
    let lastRows = term.rows;
    const ro = new ResizeObserver(() => {
      if (host.clientWidth === lastW && host.clientHeight === lastH) return;
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      try {
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          void invoke("terminal_resize", { session, cols: term.cols, rows: term.rows })
            .catch(() => { /* closed */ });
        }
      } catch { /* detached */ }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      onData.dispose();
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      void invoke("terminal_close", { session }).catch(() => { /* already gone */ });
      term.dispose();
    };
  }, [cwd]);

  return <div className="order-terminal" ref={hostRef} />;
}
