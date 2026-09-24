import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { AArrowDown, AArrowUp, ClipboardPaste, Ellipsis, Keyboard, KeyboardOff, Plus, RotateCcw, Terminal as TerminalIcon, X } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { Empty, errorMessage, getClientStorage, Popover, tooltipProps, useHostCapabilities, type PanelProps } from "tau";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { focusedPane, focusPane, isStaged, paneIds, type TerminalLayout } from "./layout.js";
import { closeTerminals, openTerminal, restartTerminal, TERMINAL_READ_ONLY } from "./controller.js";
import { PLACE_LABEL, placeOf, shellDirectory } from "./panes.js";
import { TerminalView, type TerminalTouchBinding } from "./view.js";
import {
  applyModifiers, arrowSequence, COMPACT_FONT_SIZE_KEY, DRAG_SLOP_PX, dragLines, compactFontSize, INTERRUPT, isTypedInput, MAX_COMPACT_FONT_SIZE, MIN_COMPACT_FONT_SIZE,
  stepCompactFontSize, TOUCH_KEYS, type TouchKey, type TouchModifier,
} from "./touch-keys.js";
import type { UiTerminalSession } from "./protocol.js";

/**
 * The terminal on a phone or a tablet: one shell at a time over the whole
 * sheet, a strip to switch shells, and a bar of the keys a touch keyboard
 * lacks. The sheet follows what the on-screen keyboard leaves, so the view
 * refits (and the pty resizes) when the keyboard opens or closes.
 */

/** Panel tabs first, then shells on the stage, then any the layout has not placed yet. */
export function shellOrder(layout: TerminalLayout, sessions: readonly UiTerminalSession[]): string[] {
  const live = new Set(sessions.map((session) => session.id));
  const placed = [...layout.groups, ...layout.stage].flatMap((group) => paneIds(group.root));
  const ordered = [...placed, ...sessions.map((session) => session.id)];
  return [...new Set(ordered)].filter((id) => live.has(id));
}

/** Names for the strip: a label two shells share gets a number, so the chips tell them apart. */
export function chipLabels(shells: readonly UiTerminalSession[]): Map<string, string> {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const shell of shells) total.set(shell.label, (total.get(shell.label) ?? 0) + 1);
  return new Map(shells.map((shell) => {
    const count = (seen.get(shell.label) ?? 0) + 1;
    seen.set(shell.label, count);
    return [shell.id, (total.get(shell.label) ?? 0) > 1 ? `${shell.label} ${count}` : shell.label];
  }));
}

const fontListeners = new Set<() => void>();
const readFontSize = () => compactFontSize(getClientStorage()?.get(COMPACT_FONT_SIZE_KEY));

function useCompactFontSize(): [number, (size: number) => void] {
  const size = useSyncExternalStore((listener) => {
    fontListeners.add(listener);
    return () => { fontListeners.delete(listener); };
  }, readFontSize, readFontSize);
  const set = (next: number) => {
    try { getClientStorage()?.set(COMPACT_FONT_SIZE_KEY, String(next)); } catch { /* storage is a convenience */ }
    fontListeners.forEach((listener) => listener());
  };
  return [size, set];
}

/** Whether the on-screen keyboard is up, as the compact layout marks it on `<body>` from the visual viewport. */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => typeof document !== "undefined" && document.body.hasAttribute("data-keyboard"));
  useEffect(() => {
    const observer = new MutationObserver(() => setUp(document.body.hasAttribute("data-keyboard")));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-keyboard"] });
    return () => observer.disconnect();
  }, []);
  return up;
}

/** Keeps the keyboard where it is: a press on a bar key must not move focus out of the shell. */
const keepFocus = (event: SyntheticEvent) => event.preventDefault();

/** What the on-screen keyboard must not do to a shell's input: correct, capitalise, suggest. */
function plainInput(field: HTMLTextAreaElement | undefined): void {
  if (!field) return;
  field.setAttribute("autocomplete", "off");
  field.setAttribute("autocorrect", "off");
  field.setAttribute("autocapitalize", "none");
  field.setAttribute("spellcheck", "false");
  field.setAttribute("writingsuggestions", "false");
  field.setAttribute("enterkeyhint", "enter");
}

/**
 * xterm has no touch scrolling of its own. A vertical drag moves through the
 * scrollback; in a full-screen program (less, vim), which has none, it sends
 * the arrow keys instead. A touch that barely moves stays a tap.
 */
function touchScrolling(instance: Terminal): () => void {
  const element = instance.element;
  if (!element) return () => undefined;
  let drag: { y: number; moved: boolean; carry: number } | undefined;
  const cellHeight = () => (element.querySelector(".xterm-screen")?.clientHeight ?? 0) / Math.max(1, instance.rows);
  const onStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    drag = event.touches.length === 1 && touch ? { y: touch.clientY, moved: false, carry: 0 } : undefined;
  };
  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!drag || !touch) return;
    const dy = touch.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < DRAG_SLOP_PX) return;
    drag.moved = true;
    if (event.cancelable) event.preventDefault();
    const step = dragLines(drag.carry, dy, cellHeight());
    drag.y = touch.clientY;
    drag.carry = step.carry;
    if (step.lines === 0) return;
    if (instance.buffer.active.type === "alternate") {
      const arrow = arrowSequence(step.lines < 0 ? "up" : "down", instance.modes.applicationCursorKeysMode);
      instance.input(arrow.repeat(Math.abs(step.lines)), true);
    } else {
      instance.scrollLines(step.lines);
    }
  };
  const onEnd = () => { drag = undefined; };
  element.addEventListener("touchstart", onStart, { passive: true });
  element.addEventListener("touchmove", onMove, { passive: false });
  element.addEventListener("touchend", onEnd);
  element.addEventListener("touchcancel", onEnd);
  return () => {
    element.removeEventListener("touchstart", onStart);
    element.removeEventListener("touchmove", onMove);
    element.removeEventListener("touchend", onEnd);
    element.removeEventListener("touchcancel", onEnd);
  };
}

function IconButton({ label, onClick, disabled, children, pressed }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode; pressed?: boolean }) {
  return <button
    type="button"
    className="terminal-touch-icon"
    aria-label={label}
    {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
    {...tooltipProps(label)}
    disabled={disabled}
    onClick={onClick}
  >{children}</button>;
}

export function CompactTerminalPanel({ actions, active }: PanelProps) {
  const { sessions, layout, activeSessionId: switched, focusRequest } = useTerminalKit();
  const activeSessionId = actions.activeThread()?.sessionId ?? switched;
  const [picked, setPicked] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [typing, setTyping] = useState(false);
  const { readOnly } = useHostCapabilities();
  const keyboardUp = useKeyboardUp();
  const [armed, setArmed] = useState<ReadonlySet<TouchModifier>>(new Set());
  const [fontSize, setFontSize] = useCompactFontSize();
  const more = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const modifiers = useRef<ReadonlySet<TouchModifier>>(new Set());

  useEffect(() => { terminalServices.actions = actions; }, [actions]);
  useEffect(() => {
    terminalStore.setPanelVisible(active);
    return () => terminalStore.setPanelVisible(false);
  }, [active]);
  // A shell someone asked to type into (a new one, a restart, another kit's run) comes to the front.
  useEffect(() => { if (focusRequest) setPicked(focusRequest.id); }, [focusRequest]);

  const ids = shellOrder(layout, sessions);
  const names = chipLabels(ids.map((id) => sessions.find((session) => session.id === id)!));
  const shownId = [picked, focusedPane(layout), ...ids].find((id): id is string => Boolean(id && ids.includes(id)));
  const shown = sessions.find((session) => session.id === shownId);
  const exited = shown?.exitCode !== undefined;
  // The chip of the shell on screen stays in view when the strip overflows.
  useEffect(() => { strip.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [shownId]);

  const arm = (next: ReadonlySet<TouchModifier>) => {
    modifiers.current = next;
    setArmed(next);
  };
  // A modifier armed for one shell is not carried to the next.
  useEffect(() => { arm(new Set()); }, [shownId]);

  const binding = useMemo<TerminalTouchBinding>(() => {
    let stopScrolling = () => {};
    return {
      attach: (instance) => {
        stopScrolling();
        stopScrolling = instance ? touchScrolling(instance) : () => {};
        terminal.current = instance;
        plainInput(instance?.textarea);
      },
      filterInput: (data) => {
        if (modifiers.current.size === 0 || !isTypedInput(data)) return data;
        const sent = applyModifiers(data, modifiers.current);
        arm(new Set());
        return sent;
      },
    };
  }, []);

  const run = (work: () => Promise<unknown> | unknown) => {
    setBusy(true);
    setError("");
    void Promise.resolve().then(work).catch((problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(false));
  };
  const pick = (id: string) => {
    setPicked(id);
    terminalStore.updateLayout((next) => focusPane(next, id));
  };

  const send = (data: string) => {
    terminal.current?.input(data, true);
  };
  const press = (key: TouchKey) => {
    const instance = terminal.current;
    if (!instance) return;
    if (key.kind === "modifier") {
      const next = new Set(modifiers.current);
      if (next.has(key.modifier)) next.delete(key.modifier);
      else next.add(key.modifier);
      arm(next);
      return;
    }
    if (key.kind === "paste") {
      arm(new Set());
      void paste();
      return;
    }
    const data = key.kind === "arrow" ? arrowSequence(key.arrow, instance.modes.applicationCursorKeysMode) : key.data;
    const sent = applyModifiers(data, modifiers.current);
    arm(new Set());
    send(sent);
  };
  const interrupt = () => {
    arm(new Set());
    send(INTERRUPT);
  };
  // The clipboard API needs a secure page and, on iOS, the user's say-so; where it refuses, a field takes the paste.
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) terminal.current?.paste(text);
    } catch {
      setPasting(true);
    }
  };
  // A shell can hold focus with no keyboard shown (iOS ignores a focus the user did not tap for): focus again from the tap.
  const keyboardShown = typing && keyboardUp;
  const toggleKeyboard = () => {
    const field = terminal.current?.textarea;
    field?.blur();
    if (!keyboardShown) terminal.current?.focus();
  };

  const bar = <div className="terminal-touch-keys" role="toolbar" aria-label="Terminal keys" data-sheet-drag="off">
    <div className="terminal-touch-keys-scroll">
      {TOUCH_KEYS.map((key) => {
        const on = key.kind === "modifier" && armed.has(key.modifier);
        return <button
          key={key.id}
          type="button"
          className={`terminal-touch-key${on ? " armed" : ""}`}
          aria-label={key.title}
          {...(key.kind === "modifier" ? { "aria-pressed": on } : {})}
          disabled={exited}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => press(key)}
        >{key.kind === "paste" ? <ClipboardPaste size={18} aria-hidden="true" /> : key.label}</button>;
      })}
    </div>
    <button
      type="button"
      className="terminal-touch-key interrupt"
      aria-label="Send Ctrl-C"
      {...tooltipProps("Send Ctrl-C: stops what runs in the shell")}
      disabled={exited}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={interrupt}
    >^C</button>
    <button
      type="button"
      className="terminal-touch-icon"
      aria-label={keyboardShown ? "Hide keyboard" : "Show keyboard"}
      {...tooltipProps(keyboardShown ? "Hide keyboard" : "Show keyboard")}
      disabled={exited}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={toggleKeyboard}
    >{keyboardShown ? <KeyboardOff size={20} /> : <Keyboard size={20} />}</button>
  </div>;

  return <section className="panel-body terminal-compact">
    <header className="terminal-compact-header">
      <div ref={strip} className="terminal-compact-shells" role="tablist" aria-label="Terminals">
        {ids.map((id) => {
          const session = sessions.find((entry) => entry.id === id)!;
          const place = placeOf(session, activeSessionId);
          const selected = id === shownId;
          return <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`terminal-compact-shell${selected ? " active" : ""} place-${place}`}
            {...tooltipProps(`${shellDirectory(session) ?? session.label} · ${PLACE_LABEL[place]}`)}
            onClick={() => pick(id)}
          >
            {names.get(id)}
            {session.exitCode !== undefined ? <span className="terminal-tab-place">exited</span> : null}
          </button>;
        })}
      </div>
      {readOnly ? null : <IconButton label="New terminal" disabled={busy} onClick={() => run(() => openTerminal(actions))}><Plus size={20} /></IconButton>}
      <button
        ref={more}
        type="button"
        className="terminal-touch-icon"
        aria-label="Terminal options"
        aria-haspopup="dialog"
        aria-expanded={menu}
        {...tooltipProps("Terminal options")}
        onClick={() => setMenu((open) => !open)}
      ><Ellipsis size={20} /></button>
    </header>
    {menu ? <Popover anchor={more} side="bottom" align="end" label="Terminal options" className="terminal-compact-menu" onClose={() => setMenu(false)}>
      <div className="terminal-compact-size" role="group" aria-label="Text size">
        <span>Text size</span>
        <IconButton label="Smaller text" disabled={fontSize <= MIN_COMPACT_FONT_SIZE} onClick={() => setFontSize(stepCompactFontSize(fontSize, -1))}><AArrowDown size={20} /></IconButton>
        <output aria-live="polite">{fontSize} px</output>
        <IconButton label="Larger text" disabled={fontSize >= MAX_COMPACT_FONT_SIZE} onClick={() => setFontSize(stepCompactFontSize(fontSize, 1))}><AArrowUp size={20} /></IconButton>
      </div>
      {shown && !readOnly ? <button
        type="button"
        className="terminal-compact-menu-item destructive"
        disabled={busy}
        onClick={() => { setMenu(false); run(() => closeTerminals([shown.id])); }}
      ><X size={18} aria-hidden="true" />Close {names.get(shown.id)}</button> : null}
    </Popover> : null}
    {error ? <p role="alert" className="terminal-error">{error}</p> : null}
    {readOnly ? <p className="terminal-note" role="note">{TERMINAL_READ_ONLY}</p> : null}
    {shown && exited ? <p className="terminal-compact-exit" role="status">
      <span>The shell exited with {shown.exitCode}.</span>
      {readOnly ? null : <button type="button" className="terminal-compact-button" disabled={busy} onClick={() => run(() => restartTerminal(shown.id))}><RotateCcw size={16} aria-hidden="true" />Restart</button>}
    </p> : null}
    <div
      className="terminal-compact-surface"
      data-sheet-drag="off"
      onFocus={() => setTyping(true)}
      onBlur={() => setTyping(false)}
    >
      {shown
        ? <TerminalView key={shown.id} session={shown} place={isStaged(layout, shown.id) ? "stage" : "panel"} fontSize={fontSize} touch={binding} />
        : <Empty icon={<TerminalIcon size={20} />} title="No terminal open" description={readOnly ? "No shell is open on the host." : "Open a shell to run commands in this workspace."}>
          {readOnly ? null : <button type="button" className="terminal-compact-button" disabled={busy} onClick={() => run(() => openTerminal(actions))}><Plus size={16} aria-hidden="true" />New terminal</button>}
        </Empty>}
    </div>
    {pasting ? <PasteField onPaste={(text) => { setPasting(false); terminal.current?.paste(text); }} onCancel={() => setPasting(false)} /> : null}
    {shown && !readOnly ? bar : null}
  </section>;
}

/** Where the page may not read the clipboard: a field the user pastes into with a long press. */
function PasteField({ onPaste, onCancel }: { onPaste(text: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text) onPaste(text);
  };
  return <form className="terminal-compact-paste" onSubmit={submit} data-sheet-drag="off">
    <label htmlFor="terminal-compact-paste-field">This browser did not let Tau read the clipboard. Paste here, then send it to the shell.</label>
    <textarea
      id="terminal-compact-paste-field"
      autoFocus
      rows={3}
      value={text}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
    />
    <div className="terminal-compact-paste-actions">
      <button type="button" className="terminal-compact-button" onClick={onCancel}>Cancel</button>
      <button type="submit" className="terminal-compact-button primary" disabled={!text}>Send to shell</button>
    </div>
  </form>;
}
