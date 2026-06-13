// Inline, Order-branded terminal panel — opens inside a Notable Folder
// card instead of launching the system Terminal. Built on xterm.js for
// the rendering (ANSI colors, cursor, scrollback) and backed by the
// Rust `terminal_run` streaming command runner (see terminal.rs).
//
// It's a line-oriented command runner, not a PTY: type a command, press
// Enter, output streams back. `cd` is handled in-app so the prompt
// tracks the working directory. Full-screen TUIs (vim, htop) won't work
// — that's the deliberate trade for not pulling in a pty dependency.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Order palette → xterm theme. Black field, royal-blue default text,
// coral for the prompt and errors. The 16 ANSI slots map onto the two
// brand accents plus neutral tints so `ls --color` / git output stays
// legible without fighting the theme.
const ORDER_XTERM_THEME = {
  background: "#000000",
  foreground: "#6b8cff",          // royal blue, lightened for contrast on black
  cursor: "#ff7f50",              // coral
  cursorAccent: "#000000",
  selectionBackground: "#23314f",
  black: "#000000",
  red: "#ff7f50",                 // coral
  green: "#7ad6a0",
  yellow: "#e8c372",
  blue: "#6b8cff",                // royal
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

interface Props {
  /** Absolute starting directory (the Notable Folder's path). */
  cwd: string;
  /** Short label shown in the prompt (the folder name). */
  label: string;
}

export function OrderTerminal({ cwd, label }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: ORDER_XTERM_THEME,
      fontFamily: 'var(--mono, "JetBrains Mono", "SF Mono", Menlo, monospace)',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // ---- session state (kept in closures so listeners stay stable) ----
    const session = `t${Date.now()}-${Math.floor(performance.now())}`;
    let dir = cwd;
    let buffer = "";        // current input line
    let running = false;    // a command is in flight

    const promptStr = () => `\x1b[38;2;255;127;80m${label}\x1b[0m \x1b[38;2;107;140;255m❯\x1b[0m `;
    const prompt = () => term.write(promptStr());

    term.writeln("\x1b[38;2;107;140;255mOrder terminal\x1b[0m — runs in this folder. Line commands only (no vim/htop).");
    prompt();

    function runCommand(cmd: string) {
      const trimmed = cmd.trim();
      if (!trimmed) { prompt(); return; }

      // `cd` is interpreted here so the prompt follows the directory.
      // Everything else streams through the Rust runner.
      const cdMatch = trimmed.match(/^cd(?:\s+(.*))?$/);
      if (cdMatch) {
        const arg = (cdMatch[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
        if (!arg || arg === "~") {
          // No HOME resolution here; just no-op to the folder root.
          term.writeln("");
        } else if (arg === "..") {
          dir = dir.replace(/\/[^/]+\/?$/, "") || "/";
        } else if (arg.startsWith("/")) {
          dir = arg;
        } else {
          dir = `${dir.replace(/\/$/, "")}/${arg}`;
        }
        prompt();
        return;
      }
      if (trimmed === "clear") { term.clear(); prompt(); return; }

      running = true;
      void invoke("terminal_run", { session, cwd: dir, command: trimmed })
        .catch((e) => {
          term.writeln(`\x1b[38;2;255;127;80m${String(e)}\x1b[0m`);
          running = false;
          prompt();
        });
    }

    // Minimal line editor: printable chars echo, Enter runs, Backspace
    // deletes, Ctrl+C abandons the line. Input is ignored while a
    // command is running (output is streaming).
    const onData = term.onData((data) => {
      if (running) return;
      for (const ch of data) {
        const code = ch.codePointAt(0)!;
        if (ch === "\r") {                       // Enter
          term.write("\r\n");
          const cmd = buffer;
          buffer = "";
          runCommand(cmd);
        } else if (ch === "\x7f") {              // Backspace
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            term.write("\b \b");
          }
        } else if (ch === "\x03") {              // Ctrl+C
          buffer = "";
          term.write("^C\r\n");
          prompt();
        } else if (code >= 0x20) {               // printable
          buffer += ch;
          term.write(ch);
        }
      }
    });

    // ---- stream listeners ----
    let unlistenOut: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    void listen<{ session: string; stream: string; line: string }>("terminal://output", (e) => {
      if (e.payload.session !== session) return;
      if (e.payload.stream === "stderr") {
        term.writeln(`\x1b[38;2;255;155;120m${e.payload.line}\x1b[0m`);
      } else {
        term.writeln(e.payload.line);
      }
    }).then((u) => { unlistenOut = u; });
    void listen<{ session: string; code: number }>("terminal://exit", (e) => {
      if (e.payload.session !== session) return;
      if (e.payload.code !== 0) {
        term.writeln(`\x1b[38;2;90;100;136m[exit ${e.payload.code}]\x1b[0m`);
      }
      running = false;
      prompt();
    }).then((u) => { unlistenExit = u; });

    // Refit on container resize.
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* detached */ } });
    ro.observe(host);

    return () => {
      onData.dispose();
      ro.disconnect();
      unlistenOut?.();
      unlistenExit?.();
      term.dispose();
    };
  }, [cwd, label]);

  return <div className="order-terminal" ref={hostRef} />;
}
