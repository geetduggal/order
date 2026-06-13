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

const MONO = '"Menlo", "SF Mono", "JetBrains Mono", "Monaco", "Consolas", monospace';

// Build an xterm theme from the ACTIVE Order theme's CSS variables, so
// the terminal tracks light/dark/typewriter/LCARS/etc. as the user
// cycles themes. background ← --bg, foreground ← --ink, cursor ← --coral,
// blue ← --royal, red ← --coral. The remaining ANSI hues (green, yellow,
// cyan, magenta) come from a light-bg or dark-bg set chosen by the
// background's luminance, so `ls --color` / vim syntax stay legible on a
// cream typewriter field or a black OLED one alike.
function relLuminance(hex: string): number {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildXtermTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => (cs.getPropertyValue(name).trim() || fallback);
  const bg = v("--bg", "#000000");
  const ink = v("--ink", "#9bb0ff");
  const royal = v("--royal", "#6b8cff");
  const coral = v("--coral", "#ff7f50");
  const inkFaint = v("--ink-faint", "#5a6488");
  const royalSoft = v("--royal-soft", "#23314f");
  const light = relLuminance(bg.startsWith("#") ? bg : "#000000") > 0.5;
  // Non-brand ANSI hues, tuned for legibility on light vs dark fields.
  const set = light
    ? { green: "#2e8b57", yellow: "#9a7d00", cyan: "#1f7a7a", magenta: "#8a4fbf" }
    : { green: "#7ad6a0", yellow: "#e8c372", cyan: "#6fd3d3", magenta: "#c08cff" };
  return {
    background: bg,
    foreground: ink,
    cursor: coral,
    cursorAccent: bg,
    selectionBackground: royalSoft,
    black: light ? "#2a2a2a" : "#11151f",
    red: coral,
    green: set.green,
    yellow: set.yellow,
    blue: royal,
    magenta: set.magenta,
    cyan: set.cyan,
    white: ink,
    brightBlack: inkFaint,
    brightRed: coral,
    brightGreen: set.green,
    brightYellow: set.yellow,
    brightBlue: royal,
    brightMagenta: set.magenta,
    brightCyan: set.cyan,
    brightWhite: ink,
  };
}

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
      theme: buildXtermTheme(),
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    // Re-theme live when the user cycles Order themes (Cmd+T). The CSS
    // vars are already updated by the time this event fires.
    const onThemeChange = () => { term.options.theme = buildXtermTheme(); };
    window.addEventListener("order:theme", onThemeChange);
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
      window.removeEventListener("order:theme", onThemeChange);
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
