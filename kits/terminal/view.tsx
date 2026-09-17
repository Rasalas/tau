import { useEffect, useRef, useState } from "react";
import { errorMessage } from "tau";
import type { ITheme, Terminal } from "@xterm/xterm";
import { terminalKit, onTerminalEvent } from "./store.js";
import { unseenOutput } from "./output.js";
import { TERMINAL_DATA_EVENT, type TerminalDataEvent } from "./protocol.js";

/** xterm draws with its own palette; the tokens the workbench theme sets are read once per mount. */
function themeFrom(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--sunken", "#111111"),
    foreground: token("--ink", "#e6e6e6"),
    cursor: token("--ink", "#e6e6e6"),
    selectionBackground: token("--accent", "#3b6ea8"),
  };
}

/**
 * One xterm over one host session. The session's output arrives as pushes
 * numbered by byte offset; the replay on mount and the live pushes are
 * reconciled by that number, so nothing is drawn twice or lost in between.
 */
export function TerminalView({ id, cols, rows, exitCode }: { id: string; cols: number; rows: number; exitCode?: number }) {
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const running = useRef(exitCode === undefined);
  const initialSize = useRef({ cols, rows });
  const [error, setError] = useState("");

  useEffect(() => {
    running.current = exitCode === undefined;
    if (terminal.current) {
      terminal.current.options.disableStdin = !running.current;
      terminal.current.options.cursorBlink = running.current;
    }
  }, [exitCode]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(async ([xterm, fit]) => {
      if (disposed || !surface.current) return;
      const instance = new xterm.Terminal({
        ...initialSize.current,
        disableStdin: !running.current,
        cursorBlink: running.current,
        fontSize: 12,
        fontFamily: "var(--mono, monospace)",
        theme: themeFrom(surface.current),
        screenReaderMode: true,
      });
      terminal.current = instance;
      const addon = new fit.FitAddon();
      instance.loadAddon(addon);
      instance.open(surface.current);
      let ready = false;
      let drawn = 0;
      const pending: TerminalDataEvent[] = [];
      const write = (event: TerminalDataEvent) => {
        const output = unseenOutput(event, drawn);
        if (!output) return;
        instance.write(output);
        drawn = event.offset;
      };
      const stop = onTerminalEvent(TERMINAL_DATA_EVENT, (payload) => {
        const event = payload as TerminalDataEvent;
        if (event?.id !== id || typeof event.data !== "string" || !Number.isFinite(event.offset)) return;
        if (ready) write(event);
        else pending.push(event);
      });
      const report = (problem: unknown) => { if (!disposed) setError(errorMessage(problem)); };
      const input = instance.onData((data) => {
        if (!disposed && running.current) void terminalKit.input({ id, data }).catch(report);
      });
      const refit = () => {
        if (disposed || !surface.current?.clientWidth || !surface.current.clientHeight) return;
        addon.fit();
        if (running.current) void terminalKit.resize({ id, cols: instance.cols, rows: instance.rows }).catch(report);
      };
      const observer = new ResizeObserver(refit);
      observer.observe(surface.current);
      cleanup = () => { stop(); input.dispose(); observer.disconnect(); instance.dispose(); terminal.current = null; };
      const replay = await terminalKit.replay({ id });
      if (disposed) return;
      if (replay) {
        instance.write(replay.data);
        drawn = replay.offset;
      }
      ready = true;
      pending.forEach(write);
      pending.length = 0;
      refit();
      instance.focus();
    }).catch((problem: unknown) => { if (!disposed) setError(errorMessage(problem)); });
    return () => { disposed = true; cleanup(); };
  }, [id]);

  return <>{error && <p role="alert" className="terminal-error">{error}</p>}<div className="terminal-view" ref={surface} /></>;
}
