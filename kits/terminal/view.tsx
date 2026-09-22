import { useEffect, useRef, useState } from "react";
import { errorMessage } from "tau";
import type { ITheme, Terminal } from "@xterm/xterm";
import { terminalFont, terminalKit, onTerminalEvent, useTerminalFont } from "./store.js";
import { unseenOutput } from "./output.js";
import { terminalFontStack, type ResolvedTerminalFont } from "./font.js";
import { TERMINAL_DATA_EVENT, type TerminalDataEvent } from "./protocol.js";

/** Lines a view keeps; the host retains as many for a view that reattaches. */
const SCROLLBACK_LINES = 5_000;

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

const FONT_SAMPLE = "iMW0@# .─│";

/** Waits for a web font the stack names, so xterm measures its cell in the face it will draw. */
async function loadFont(font: ResolvedTerminalFont): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return;
  const variants = ["normal 400", "normal 700", "italic 400"].map((variant) => fonts.load(`${variant} ${font.size}px ${font.family}`, FONT_SAMPLE));
  await Promise.race([Promise.all(variants).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1500))]);
}

/**
 * A face whose "i" and "W" differ in width draws text narrower than its cells;
 * the platform faces take over rather than leave a ragged grid.
 */
function monospaceStack(font: ResolvedTerminalFont): string {
  const context = typeof document === "undefined" ? undefined : document.createElement("canvas").getContext("2d");
  if (!context) return font.family;
  context.font = `${font.size}px ${font.family}`;
  const narrow = context.measureText("i").width;
  const wide = context.measureText("W").width;
  return Math.abs(narrow - wide) < 0.5 ? font.family : terminalFontStack();
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
  const refitRef = useRef<() => void>(() => undefined);
  const [error, setError] = useState("");
  const font = useTerminalFont().resolved;

  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    instance.options.fontFamily = monospaceStack(font);
    instance.options.fontSize = font.size;
    // A new cell size changes how many columns fit, which no resize reports.
    refitRef.current();
  }, [font]);

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
    const initialFont = terminalFont.getSnapshot().resolved;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), loadFont(initialFont)]).then(async ([xterm, fit]) => {
      if (disposed || !surface.current) return;
      const current = terminalFont.getSnapshot().resolved;
      const instance = new xterm.Terminal({
        ...initialSize.current,
        disableStdin: !running.current,
        cursorBlink: running.current,
        fontSize: current.size,
        fontFamily: monospaceStack(current),
        lineHeight: 1,
        scrollback: SCROLLBACK_LINES,
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
      refitRef.current = refit;
      const observer = new ResizeObserver(refit);
      observer.observe(surface.current);
      cleanup = () => { stop(); input.dispose(); observer.disconnect(); instance.dispose(); terminal.current = null; refitRef.current = () => undefined; };
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
