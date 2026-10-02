import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, hostIsReadOnly } from "tau";
import type { ILink, ITheme, Terminal } from "@xterm/xterm";
import { terminalFont, terminalKit, terminalServices, terminalStore, onTerminalEvent, onTerminalReconnect, useTerminalFont, watchTerminalOutput } from "./store.js";
import { unseenOutput } from "./output.js";
import { terminalFontStack, type ResolvedTerminalFont } from "./font.js";
import { classifyTerminalLink, findTerminalLinks, positionIn, wrappedLineAt } from "./links.js";
import { terminalKeyOutcome } from "./keys.js";
import { focusPane, isStaged } from "./layout.js";
import { addExcerptToPrompt, openTerminalLink } from "./controller.js";
import { forGround } from "./palette.js";
import { TERMINAL_DATA_EVENT, type TerminalDataEvent, type UiTerminalSession } from "./protocol.js";

/** Lines a view keeps; the host retains as many for a view that reattaches. */
const SCROLLBACK_LINES = 5_000;

const MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);

/**
 * xterm draws with its own palette; the tokens the workbench theme sets are
 * read once per mount. A token may be `light-dark(…)`, which xterm cannot
 * parse, so each is resolved through a probe's computed colour.
 */
function themeFrom(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const probe = document.createElement("span");
  element.append(probe);
  const token = (name: string, fallback: string) => {
    if (!style.getPropertyValue(name).trim()) return fallback;
    probe.style.color = `var(${name})`;
    const value = getComputedStyle(probe).color.trim();
    return value && !value.startsWith("var(") ? value : fallback;
  };
  const theme: ITheme = {
    background: token("--sunken", "#111111"),
    foreground: token("--ink", "#e6e6e6"),
    cursor: token("--ink", "#e6e6e6"),
    selectionBackground: token("--accent", "#3b6ea8"),
  };
  probe.remove();
  // xterm's own ANSI colours are made for a dark ground; on a light one yellow and white vanish.
  return forGround(theme);
}

/** Calls back when the window's colours may have changed: its theme attribute, a theme's style, or the system scheme. */
function watchTheme(changed: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => undefined;
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  scheme?.addEventListener?.("change", changed);
  return () => { observer.disconnect(); scheme?.removeEventListener?.("change", changed); };
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

function linkHint(text: string): string {
  const target = classifyTerminalLink(text);
  const key = MAC ? "⌘" : "Ctrl";
  return target?.kind === "preview" ? `${key}-click to open in the Preview` : `${key}-click to open in the browser`;
}

const activatesLink = (event: MouseEvent) => MAC ? event.metaKey : event.ctrlKey;

export interface TerminalViewProps {
  session: UiTerminalSession;
  /** Where the view is drawn: a panel tab or a stage tab. */
  place: "panel" | "stage";
  /** Draws the focus ring; only meaningful beside other panes. */
  focused?: boolean;
  /** A text size of the view's own (a phone's) instead of the shared one. */
  fontSize?: number;
  /** What a touch client's key bar needs of the view; read on every call, so it may change without a remount. */
  touch?: TerminalTouchBinding;
}

/** The compact terminal's hold on one view: the xterm it drives, and a look at what is typed. */
export interface TerminalTouchBinding {
  /** The xterm once it is drawn, `undefined` when it goes. */
  attach(terminal: Terminal | undefined): void;
  /** Sees each chunk before it reaches the shell, and answers what is sent instead. */
  filterInput(data: string): string;
}

/**
 * One xterm over one host session. The session's output arrives as pushes
 * numbered by byte offset; replay on mount or reconnect and live pushes are
 * reconciled by that number, so nothing is drawn twice or lost in between.
 * A view takes the keyboard only when asked to (`requestFocus`), so a pane
 * that remounts never steals it.
 */
export function TerminalView({ session, place, focused = false, fontSize, touch }: TerminalViewProps) {
  const { id, exitCode } = session;
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const running = useRef(exitCode === undefined);
  const initialSize = useRef({ cols: session.cols, rows: session.rows });
  const refitRef = useRef<() => void>(() => undefined);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [error, setError] = useState("");
  const [selection, setSelection] = useState("");
  const shared = useTerminalFont().resolved;
  const font = useMemo(() => fontSize === undefined || fontSize === shared.size ? shared : { ...shared, size: fontSize }, [shared, fontSize]);
  const touchRef = useRef(touch);
  touchRef.current = touch;
  const sizeRef = useRef(fontSize);
  sizeRef.current = fontSize;

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
      terminal.current.options.disableStdin = !running.current || hostIsReadOnly();
      terminal.current.options.cursorBlink = running.current;
    }
  }, [exitCode]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const sized = (resolved: ResolvedTerminalFont) => sizeRef.current === undefined ? resolved : { ...resolved, size: sizeRef.current };
    const initialFont = sized(terminalFont.getSnapshot().resolved);
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), loadFont(initialFont)]).then(async ([xterm, fit]) => {
      if (disposed || !surface.current) return;
      const element = surface.current;
      const current = sized(terminalFont.getSnapshot().resolved);
      const instance = new xterm.Terminal({
        ...initialSize.current,
        // A Read-only device watches; the host would refuse its keys and its size (ADR 0024).
        disableStdin: !running.current || hostIsReadOnly(),
        cursorBlink: running.current,
        fontSize: current.size,
        fontFamily: monospaceStack(current),
        lineHeight: 1,
        scrollback: SCROLLBACK_LINES,
        theme: themeFrom(element),
        // xterm's screen reader mode ignores text an on-screen keyboard inserts without key events (predictions, dictation).
        screenReaderMode: !touchRef.current,
        // OSC 8 hyperlinks a program prints go the same way as a URL in the text.
        linkHandler: {
          activate: (event, text) => { if (activatesLink(event)) void openTerminalLink(text); },
          hover: (_event, text) => { element.title = linkHint(text); },
          leave: () => { element.title = ""; },
        },
      });
      terminal.current = instance;
      const addon = new fit.FitAddon();
      instance.loadAddon(addon);
      instance.open(element);
      instance.attachCustomKeyEventHandler((event) => terminalKeyOutcome(event, MAC) !== "pass");
      const links = instance.registerLinkProvider({
        provideLinks: (row, callback) => {
          const line = wrappedLineAt(row, (index) => instance.buffer.active.getLine(index));
          if (!line) return callback(undefined);
          const found: ILink[] = findTerminalLinks(line.text)
            .filter((match) => positionIn(line, match.start).y <= row && positionIn(line, match.end - 1).y >= row)
            .map((match) => ({
              text: match.url,
              range: { start: positionIn(line, match.start), end: positionIn(line, match.end - 1) },
              activate: (event, text) => { if (activatesLink(event)) void openTerminalLink(text); },
              hover: (_event, text) => { element.title = linkHint(text); },
              leave: () => { element.title = ""; },
            }));
          callback(found.length > 0 ? found : undefined);
        },
      });
      const selected = instance.onSelectionChange(() => setSelection(instance.hasSelection() ? instance.getSelection() : ""));
      let ready = false;
      // Replayed output may hold a program's terminal queries; xterm's answers
      // to those must not reach today's shell as typed input.
      let replaying = false;
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
      // Before the replay is asked for, so nothing written in between is missed.
      const unwatch = watchTerminalOutput(id);
      const report = (problem: unknown) => { if (!disposed) setError(errorMessage(problem)); };
      const input = instance.onData((data) => {
        if (disposed || !running.current || replaying || hostIsReadOnly()) return;
        const sent = touchRef.current ? touchRef.current.filterInput(data) : data;
        void terminalKit.input({ id, data: sent }).catch(report);
      });
      // A panel host may still be detached when the view mounts, and a detached element has no tokens.
      let themed = element.isConnected;
      const refit = () => {
        if (disposed || !element.clientWidth || !element.clientHeight) return;
        if (!themed) {
          instance.options.theme = themeFrom(element);
          themed = true;
        }
        addon.fit();
        if (running.current && !hostIsReadOnly()) void terminalKit.resize({ id, cols: instance.cols, rows: instance.rows }).catch(report);
      };
      refitRef.current = refit;
      const onFocus = () => terminalStore.updateLayout((layout) => focusPane(layout, id));
      instance.textarea?.addEventListener("focus", onFocus);
      const takeFocus = () => {
        const { focusRequest: request, layout } = terminalStore.getSnapshot();
        if (!ready || request?.id !== id) return;
        // A panel pane about to hand its shell to the stage must leave the request to the tab.
        if ((place === "stage") !== isStaged(layout, id)) return;
        instance.focus();
        // A view in a panel host not attached yet, or in a hidden tab, cannot take it; the request waits until it is shown.
        if (element.contains(document.activeElement)) terminalStore.focusDone(request.seq);
      };
      // Being shown (attached, a tab brought forward, the stage unfolded) resizes the view from nothing.
      const observer = new ResizeObserver(() => { refit(); takeFocus(); });
      observer.observe(element);
      const stopFocus = terminalStore.subscribe(takeFocus);
      // A theme switched while the shell is open repaints it, light or dark.
      const stopTheme = watchTheme(() => { if (!disposed && element.isConnected) instance.options.theme = themeFrom(element); });
      let replayRevision = 0;
      const readReplay = async () => {
        const requested = ++replayRevision;
        ready = false;
        try {
          const replay = await terminalKit.replay({ id });
          if (disposed || requested !== replayRevision) return;
          if (replay) {
            const output = unseenOutput({ id, ...replay }, drawn);
            if (output) {
              replaying = true;
              instance.write(output, () => { replaying = false; });
              drawn = replay.offset;
            }
          }
          setError("");
        } catch (problem) { report(problem); }
        finally {
          if (!disposed && requested === replayRevision) {
            ready = true;
            pending.forEach(write);
            pending.length = 0;
          }
        }
      };
      const stopReconnect = onTerminalReconnect(() => {
        void readReplay().then(() => { if (!disposed) { refit(); takeFocus(); } });
      });
      cleanup = () => {
        stop(); unwatch(); stopReconnect(); input.dispose(); links.dispose(); selected.dispose(); stopFocus(); stopTheme(); observer.disconnect();
        instance.textarea?.removeEventListener("focus", onFocus);
        touchRef.current?.attach(undefined);
        instance.dispose();
        terminal.current = null;
        refitRef.current = () => undefined;
      };
      await readReplay();
      if (disposed) return;
      touchRef.current?.attach(instance);
      refit();
      takeFocus();
    }).catch((problem: unknown) => { if (!disposed) setError(errorMessage(problem)); });
    return () => { disposed = true; cleanup(); };
  }, [id, place]);

  const addSelection = () => {
    if (addExcerptToPrompt(sessionRef.current, selection, terminalServices.actions)) {
      terminal.current?.clearSelection();
      setSelection("");
    }
  };

  return <div className={`terminal-pane-body${focused ? " focused" : ""}`}>
    {error && <p role="alert" className="terminal-error">{error}</p>}
    {selection.trim() && terminalServices.chips ? <button
      type="button"
      className="text-button terminal-excerpt"
      // Keep the selection: a press on the button must not move focus into xterm first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={addSelection}
    >Add to prompt</button> : null}
    <div className="terminal-view" ref={surface} data-terminal-id={id} data-keybinding-context="terminal" />
  </div>;
}
