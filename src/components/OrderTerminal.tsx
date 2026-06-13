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

    const session = `t${Date.now()}-${Math.floor(performance.now())}`;
    let disposed = false;
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let lastW = 0;
    let lastH = 0;
    let lastCols = 0;
    let lastRows = 0;

    // Fit to the host's CURRENT size and, if the grid changed, tell the
    // PTY. Returns whether anything changed. fit() before layout settles
    // computes the wrong column count (text then runs off the card), so
    // the initial fit is deferred to rAF + a fonts-ready pass below.
    const applyFit = () => {
      try { fit.fit(); } catch { return; }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        void invoke("terminal_resize", { session, cols: term.cols, rows: term.rows })
          .catch(() => { /* closed */ });
      }
    };

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

    // Defer the first fit to the next frame so the card's layout (and
    // the full-bleed margins) have settled, then open the PTY at the
    // correct column count and focus. A second fit after the web font
    // loads corrects the cell width once Menlo replaces the fallback.
    requestAnimationFrame(() => {
      if (disposed) return;
      applyFit();
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      void invoke("terminal_open", { session, cwd, cols: term.cols, rows: term.rows })
        .then(() => term.focus())
        .catch((err) => term.write(`\x1b[38;2;255;127;80m${String(err)}\x1b[0m\r\n`));
    });
    void (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(() => {
      if (!disposed) applyFit();
    });
    // One more fit after the first output settles — when `ls` overflows
    // and the scrollbar gutter is claimed, the usable width changes and
    // the column count must shrink so the last column / right-prompt
    // doesn't end up under the scrollbar.
    const settleTimer = setTimeout(() => { if (!disposed) applyFit(); }, 120);

    // Refit on a real host pixel-size change only (window/width). The
    // host has a definite height, so a masonry re-measure or scroll
    // can't change it — gating on actual size keeps fit() from feeding
    // the growth loop.
    const ro = new ResizeObserver(() => {
      if (host.clientWidth === lastW && host.clientHeight === lastH) return;
      lastW = host.clientWidth;
      lastH = host.clientHeight;
      applyFit();
    });
    ro.observe(host);

    return () => {
      disposed = true;
      clearTimeout(settleTimer);
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
