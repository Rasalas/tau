// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, HostClientProvider, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import terminal from "./desktop.js";
import { chipLabels, CompactTerminalPanel, shellOrder } from "./compact.js";
import { TerminalPanel } from "./panel.js";
import { connectTerminalHost, terminalServices, terminalStore } from "./store.js";
import { EMPTY_LAYOUT } from "./layout.js";
import { COMPACT_FONT_SIZE_KEY } from "./touch-keys.js";
import { FONT_SIZE_SETTING } from "./font.js";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_LIST_EVENT, TERMINAL_PANEL, type UiTerminalSession } from "./protocol.js";

/** The xterm the view draws, as far as the key bar drives it; `input` and `paste` fire `onData` like the real one. */
const { FakeTerminal, FakeFit, drawn, room } = vi.hoisted(() => {
  const views: Array<{
    options: Record<string, unknown>; modes: { applicationCursorKeysMode: boolean }; textarea: HTMLTextAreaElement; pasted: string[]; input(data: string): void;
    element?: HTMLElement; selections: Array<[number, number, number]>; selection: string; changed(): void;
  }> = [];
  class Xterm {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    modes = { applicationCursorKeysMode: false };
    buffer = { active: { getLine: () => undefined, viewportY: 0, type: "normal" } };
    element?: HTMLElement;
    selections: Array<[number, number, number]> = [];
    selection = "";
    private readonly selectionListeners = new Set<() => void>();
    textarea = document.createElement("textarea");
    pasted: string[] = [];
    private readonly listeners = new Set<(data: string) => void>();
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      views.push(this);
    }
    loadAddon(addon: { activate?(owner: unknown): void }) { addon.activate?.(this); }
    open(parent: HTMLElement) { parent.append(this.textarea); this.element = parent; }
    write(_data: string, done?: () => void) { done?.(); }
    onData(listener: (data: string) => void) {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    }
    input(data: string) { this.listeners.forEach((listener) => listener(data)); }
    paste(data: string) { this.pasted.push(data); this.input(data.replace(/\r?\n/gu, "\r")); }
    onSelectionChange(listener: () => void) {
      this.selectionListeners.add(listener);
      return { dispose: () => { this.selectionListeners.delete(listener); } };
    }
    select(column: number, row: number, length: number) { this.selections.push([column, row, length]); this.selection = "selected text"; this.changed(); }
    hasSelection() { return this.selection !== ""; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ""; this.changed(); }
    changed() { this.selectionListeners.forEach((listener) => listener()); }
    registerLinkProvider() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    focus() { this.textarea.focus(); }
    dispose() { this.textarea.remove(); }
  }
  /** What the fit addon measures: the rows the sheet has room for. */
  const space = { rows: 24 };
  class Fit {
    private owner?: { rows: number };
    activate(owner: { rows: number }) { this.owner = owner; }
    fit() { if (this.owner) this.owner.rows = space.rows; }
  }
  return { FakeTerminal: Xterm, FakeFit: Fit, drawn: views, room: space };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFit }));

/** The views' resize observers, so a test can say the sheet changed size. */
const observers: Array<() => void> = [];

function fakeHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sessions: UiTerminalSession[] = [];
  const publish = () => listeners.get(TERMINAL_LIST_EVENT)?.forEach((listener) => listener([...sessions]));
  let next = 1;
  const typed: string[] = [];
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    const fields = (input ?? {}) as Record<string, unknown>;
    switch (command) {
      case "list": return [...sessions];
      case "replay": return { data: "", offset: 0 };
      case "font": return { families: [], files: [], problems: [] };
      case "foreground": return {};
      case "input": typed.push(String(fields.data)); return undefined;
      case "open": {
        const session: UiTerminalSession = {
          id: `t${next++}`, label: `shell ${next - 1}`, shell: "zsh", cols: 80, rows: 24, cwd: "/project",
          ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
        };
        sessions.push(session);
        publish();
        return session;
      }
      case "kill": {
        sessions.splice(sessions.findIndex((session) => session.id === fields.id), 1);
        publish();
        return undefined;
      }
      default: return undefined;
    }
  });
  const host: HostExtensionClient = {
    invoke,
    onEvent: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => { set.delete(listener); };
    },
  };
  const exit = (id: string, exitCode: number) => {
    const session = sessions.find((entry) => entry.id === id);
    if (session) session.exitCode = exitCode;
    publish();
  };
  return { host, typed, invoke, exit };
}

function panelProps(): PanelProps {
  const actions = {
    activeThread: () => ({ sessionId: "s1", workspaceId: "workspace-one", draftPending: false }),
    stageTabs: () => [],
    openPanel: vi.fn(),
    notify: vi.fn(),
    copyText: vi.fn(async () => undefined),
  } as unknown as WorkbenchActions;
  return { active: true, placement: "stage", extensionName: "Terminal", actions };
}

/** Renders the compact panel with one shell open and drawn; answers the host fake and that shell's xterm. */
async function withShell() {
  // The on-screen keyboard is up: the key bar rides on it.
  document.body.setAttribute("data-keyboard", "");
  const fake = fakeHost();
  const disconnect = connectTerminalHost(fake.host);
  const props = panelProps();
  render(<CompactTerminalPanel {...props} />);
  fireEvent.click(screen.getAllByRole("button", { name: "New terminal" })[0]!);
  await screen.findByRole("tab", { name: /shell 1/u });
  await waitFor(() => expect(drawn.length).toBe(1));
  await screen.findByRole("button", { name: "Escape" });
  // The bar drives the xterm once the view has replayed and handed it over.
  await waitFor(() => expect(drawn[0]!.textarea.getAttribute("autocomplete")).toBe("off"));
  return { ...fake, xterm: drawn[0]!, actions: props.actions, disconnect };
}

const key = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  setClientStorage(createMemoryStorage());
  room.rows = 24;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    disconnect() { observers.splice(observers.indexOf(this.callback), 1); }
  });
  // jsdom lays nothing out; a view refits only with room to draw in.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-keyboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.length = 0;
  drawn.length = 0;
  terminalStore.updateLayout(() => EMPTY_LAYOUT);
  delete terminalServices.actions;
});

describe("the terminal on a compact client", () => {
  it("is a panel of its own there, and the dock panel everywhere else", () => {
    const compact = createKitHarness(undefined, "compact").registry;
    compact.activate(terminal);
    expect(compact.getPanels().filter((panel) => panel.id === TERMINAL_PANEL).map((panel) => panel.Component)).toEqual([CompactTerminalPanel]);
    compact.deactivate(terminal.id);
    const desktop = createKitHarness(undefined, "desktop").registry;
    desktop.activate(terminal);
    expect(desktop.getPanels().filter((panel) => panel.id === TERMINAL_PANEL).map((panel) => panel.Component)).toEqual([TerminalPanel]);
    desktop.deactivate(terminal.id);
  });

  it("lists panel shells first, then staged ones, then any not placed yet", () => {
    const sessions = ["a", "b", "c", "d"].map((id) => ({ id, label: id, cols: 80, rows: 24 }));
    const layout = {
      groups: [{ id: "g", root: { kind: "pane" as const, id: "b" }, focused: "b" }],
      stage: [{ id: "s", root: { kind: "pane" as const, id: "d" }, focused: "d" }],
      active: "g",
    };
    expect(shellOrder(layout, sessions)).toEqual(["b", "d", "a", "c"]);
  });

  it("numbers shells that share a name", () => {
    const shell = (id: string, label: string) => ({ id, label, cols: 80, rows: 24 });
    expect([...chipLabels([shell("a", "zsh"), shell("b", "npm"), shell("c", "zsh")]).values()]).toEqual(["zsh 1", "npm", "zsh 2"]);
  });

  it("lets a Read-only device watch a shell, but not open, type in or close one", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    await fake.host.invoke("open");
    const client = createFakeHostClient({ isReadOnly: () => true });
    setHostClient(client);
    try {
      render(<HostClientProvider client={client}><CompactTerminalPanel {...panelProps()} /></HostClientProvider>);
      await screen.findByRole("tab", { name: /shell 1/u });
      await waitFor(() => expect(drawn.length).toBe(1));
      expect(screen.getByRole("note").textContent).toMatch(/paired Read only/u);
      expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
      expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
      await waitFor(() => expect(drawn[0]!.options.disableStdin).toBe(true));
      drawn[0]!.input("ls\r");
      observers.forEach((refit) => refit());
      expect(fake.typed).toEqual([]);
      expect(fake.invoke.mock.calls.some(([command]) => command === "resize")).toBe(false);
    } finally {
      setHostClient(undefined);
      disconnect();
    }
  });

  it("offers a shell to open when there is none", () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    render(<CompactTerminalPanel {...panelProps()} />);
    expect(screen.getByText("No terminal open")).toBeTruthy();
    // No keys without a shell to send them to.
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
    disconnect();
  });

  it("sends the bar's keys, arrows in the cursor mode the program asked for", async () => {
    const { typed, xterm, disconnect } = await withShell();
    fireEvent.click(key("Escape"));
    fireEvent.click(key("Tab"));
    fireEvent.click(key("Up"));
    xterm.modes.applicationCursorKeysMode = true;
    fireEvent.click(key("Left"));
    fireEvent.click(key("Pipe"));
    fireEvent.click(key("Send Ctrl-C"));
    await waitFor(() => expect(typed).toEqual(["\u001b", "\t", "\u001b[A", "\u001bOD", "|", "\u0003"]));
    disconnect();
  });

  it("applies Ctrl and Alt to the next key once, from the bar or the keyboard", async () => {
    const { typed, xterm, disconnect } = await withShell();
    fireEvent.click(key("Ctrl for the next key"));
    expect(key("Ctrl for the next key").getAttribute("aria-pressed")).toBe("true");
    // xterm's answer to a program's query is not typed and leaves the modifier armed.
    act(() => xterm.input("\u001b[?1;2c"));
    act(() => xterm.input("c"));
    expect(key("Ctrl for the next key").getAttribute("aria-pressed")).toBe("false");
    act(() => xterm.input("c"));
    fireEvent.click(key("Alt for the next key"));
    fireEvent.click(key("Left"));
    fireEvent.click(key("Ctrl for the next key"));
    fireEvent.click(key("Ctrl for the next key"));
    act(() => xterm.input("d"));
    await waitFor(() => expect(typed).toEqual(["\u001b[?1;2c", "\u0003", "c", "\u001b[1;3D", "d"]));
    disconnect();
  });

  it("keeps the keyboard up: a press on a key does not take focus from the shell", async () => {
    const { disconnect } = await withShell();
    for (const name of ["Escape", "Ctrl for the next key", "Send Ctrl-C", /^(Show|Hide) keyboard$/u]) {
      const button = screen.getByRole("button", { name });
      const press = createEvent.pointerDown(button);
      fireEvent(button, press);
      expect(press.defaultPrevented).toBe(true);
    }
    disconnect();
  });

  it("shows and hides the keyboard by focusing the shell's input", async () => {
    const { xterm, disconnect } = await withShell();
    act(() => xterm.textarea.focus());
    fireEvent.click(await screen.findByRole("button", { name: "Hide keyboard" }));
    expect(document.activeElement).not.toBe(xterm.textarea);
    fireEvent.click(await screen.findByRole("button", { name: "Show keyboard" }));
    expect(document.activeElement).toBe(xterm.textarea);
    disconnect();
  });

  it("draws the key bar only while the on-screen keyboard is up", async () => {
    const { xterm, disconnect } = await withShell();
    // The keyboard went down with the focus: no bar, and the header offers to type.
    act(() => xterm.textarea.blur());
    act(() => document.body.removeAttribute("data-keyboard"));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull());
    fireEvent.click(key("Type in the shell"));
    expect(document.activeElement).toBe(xterm.textarea);
    // Focused without an on-screen keyboard is a hardware keyboard: it has these keys.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Type in the shell" })).toBeNull());
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
    // An on-screen keyboard brings the bar back.
    act(() => document.body.setAttribute("data-keyboard", ""));
    await screen.findByRole("toolbar", { name: "Terminal keys" });
    disconnect();
  });

  it("selects with a held finger, and copies the selection", async () => {
    const { xterm: view, actions, disconnect } = await withShell();
    const element = view.element!;
    // 80 × 24 cells of 10 × 10 px.
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 240, right: 800, bottom: 240, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const touch = (type: string, x: number, y: number) => fireEvent(element, Object.assign(new Event(type, { bubbles: true, cancelable: true }), { touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }] }));
    vi.useFakeTimers();
    try {
      touch("touchstart", 45, 25);
      // A short touch is a tap: nothing selected yet.
      expect(view.selections).toEqual([]);
      act(() => { vi.advanceTimersByTime(450); });
      expect(view.selections).toEqual([[4, 2, 1]]);
      touch("touchmove", 95, 35);
      touch("touchend", 95, 35);
    } finally {
      vi.useRealTimers();
    }
    expect(view.selections.at(-1)).toEqual([4, 2, 86]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy the selection" }));
    await waitFor(() => expect(actions.copyText).toHaveBeenCalledWith("selected text"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Copy the selection" })).toBeNull());
    disconnect();
  });

  it("types without autocorrect, capitals or suggestions", async () => {
    const { xterm, disconnect } = await withShell();
    const attributes = Object.fromEntries(["autocomplete", "autocorrect", "autocapitalize", "spellcheck", "writingsuggestions"].map((name) => [name, xterm.textarea.getAttribute(name)]));
    expect(attributes).toEqual({ autocomplete: "off", autocorrect: "off", autocapitalize: "none", spellcheck: "false", writingsuggestions: "false" });
    // Screen reader mode would drop what a keyboard inserts without key events.
    expect(xterm.options.screenReaderMode).toBe(false);
    disconnect();
  });

  it("pastes the clipboard, and offers a field where the page may not read it", async () => {
    const { typed, xterm, disconnect } = await withShell();
    const readText = vi.fn(async () => "echo one\n");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    fireEvent.click(key("Paste from the clipboard"));
    await waitFor(() => expect(xterm.pasted).toEqual(["echo one\n"]));
    readText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    fireEvent.click(key("Paste from the clipboard"));
    const field = await screen.findByLabelText(/did not let Tau read the clipboard/u);
    fireEvent.change(field, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to shell" }));
    expect(xterm.pasted).toEqual(["echo one\n", "ls"]);
    expect(screen.queryByLabelText(/did not let Tau read the clipboard/u)).toBeNull();
    await waitFor(() => expect(typed).toEqual(["echo one\r", "ls"]));
    disconnect();
  });

  it("keeps its own text size, which the desktop's shells do not follow", async () => {
    const { xterm, disconnect } = await withShell();
    expect(xterm.options.fontSize).toBe(11);
    fireEvent.click(screen.getByRole("button", { name: "Terminal options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Larger text" }));
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    await waitFor(() => expect(xterm.options.fontSize).toBe(13));
    expect(screen.getByText("13 px")).toBeTruthy();
    const { preferences } = createKitHarness();
    expect(preferences.value(TERMINAL_HOST_EXTENSION_ID, FONT_SIZE_SETTING)).toBeUndefined();
    const { getClientStorage } = await import("../../src/renderer/test-support/kit-harness.js");
    expect(getClientStorage()?.get(COMPACT_FONT_SIZE_KEY)).toBe("13");
    disconnect();
  });

  it("resizes the shell when the keyboard takes room from the sheet, and gives it back", async () => {
    const { invoke, disconnect } = await withShell();
    const resizes = () => invoke.mock.calls.filter(([command]) => command === "resize").map(([, input]) => input);
    await waitFor(() => expect(resizes().at(-1)).toEqual({ id: "t1", cols: 80, rows: 24 }));
    room.rows = 11;
    act(() => observers.forEach((observe) => observe()));
    await waitFor(() => expect(resizes().at(-1)).toEqual({ id: "t1", cols: 80, rows: 11 }));
    room.rows = 24;
    act(() => observers.forEach((observe) => observe()));
    await waitFor(() => expect(resizes().at(-1)).toEqual({ id: "t1", cols: 80, rows: 24 }));
    disconnect();
  });

  it("says why the keys stop when the shell exited, and restarts it", async () => {
    const { exit, invoke, disconnect } = await withShell();
    act(() => exit("t1", 130));
    expect((await screen.findByRole("status")).textContent).toContain("The shell exited with 130.");
    expect((key("Escape") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("restart", { id: "t1" }));
    disconnect();
  });

  it("opens a shell as the sheet opens for a thread that has none", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    await waitFor(() => expect(terminalStore.isKnown()).toBe(true));
    render(<CompactTerminalPanel {...panelProps()} />);
    await screen.findByRole("tab", { name: /shell 1/u });
    expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one", sessionId: "s1" });
    // Its tab carries the × that closes it.
    fireEvent.click(screen.getByRole("button", { name: "Close shell 1" }));
    await screen.findByText("No terminal open");
    disconnect();
  });

  it("keeps another thread's shells off the strip and shows one from the options on request", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    await fake.host.invoke("open", { sessionId: "s2" });
    await waitFor(() => expect(terminalStore.getSnapshot().sessions).toHaveLength(1));
    render(<CompactTerminalPanel {...panelProps()} active={false} />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText(/Other threads' shells are under ⋯/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Terminal options" }));
    fireEvent.click(screen.getByRole("button", { name: "Show shell 1" }));
    const tab = await screen.findByRole("tab", { name: /shell 1/u });
    expect(tab.textContent).toContain("other thread");
    disconnect();
  });

  it("switches between shells, one drawn at a time", async () => {
    const { disconnect } = await withShell();
    fireEvent.click(screen.getAllByRole("button", { name: "New terminal" })[0]!);
    const second = await screen.findByRole("tab", { name: /shell 2/u });
    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(screen.getByRole("tab", { name: /shell 1/u }));
    expect(screen.getByRole("tab", { name: /shell 1/u }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll("[data-terminal-id]")).toHaveLength(1);
    expect(document.querySelector("[data-terminal-id]")?.getAttribute("data-terminal-id")).toBe("t1");
    disconnect();
  });
});
