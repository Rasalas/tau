// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { connectTerminalHost, terminalHostReconnected } from "./store.js";
import { TerminalView } from "./view.js";
import { TERMINAL_DATA_EVENT } from "./protocol.js";

const { writes, calls, keyHandlers, menu, drag } = vi.hoisted(() => ({
  menu: { show: undefined as unknown as (event: unknown, sections: unknown[]) => Promise<string | undefined> },
  // What the fake xterm saw of a selection drag, and the mouse mode an application set.
  drag: { seenY: [] as number[], tracking: "none" },
  writes: [] as string[],
  calls: [] as string[],
  keyHandlers: [] as Array<(event: KeyboardEvent) => boolean>,
}));
vi.mock("tau", async (original) => ({
  ...await original<typeof import("tau")>(),
  useContextMenu: () => (event: unknown, sections: unknown[]) => menu.show(event, sections),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    buffer = { active: { type: "normal", getLine: () => undefined } };
    modes = { get mouseTrackingMode() { return drag.tracking; } };
    loadAddon() {}
    open(element: HTMLElement) {
      // Like xterm: a screen element, and a document listener that reads the pointer.
      element.append(Object.assign(document.createElement("div"), { className: "xterm-screen" }));
      const seen = (event: MouseEvent) => { drag.seenY.push(event.clientY); };
      document.addEventListener("mousemove", seen);
      this.stopSeeing = () => document.removeEventListener("mousemove", seen);
    }
    stopSeeing = () => {};
    write(data: string, done?: () => void) { writes.push(data); done?.(); }
    onData() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { keyHandlers.push(handler); }
    selectAll() { calls.push("selectAll"); }
    scrollToTop() { calls.push("scrollToTop"); }
    scrollToBottom() { calls.push("scrollToBottom"); }
    paste(text: string) { calls.push(`paste:${text}`); }
    focus() { calls.push("focus"); }
    getSelection() { return "picked"; }
    dispose() { this.stopSeeing(); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const disconnects: Array<() => void> = [];
beforeEach(() => {
  writes.length = 0;
  calls.length = 0;
  keyHandlers.length = 0;
  drag.seenY.length = 0;
  drag.tracking = "none";
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  for (const disconnect of disconnects.splice(0)) disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function host() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let resolve!: (value: { data: string; offset: number }) => void;
  let replayed = false;
  const invoke = vi.fn(async (command: string) => {
    if (command === "list") return [];
    if (command !== "replay") return undefined;
    if (!replayed) { replayed = true; return { data: "old", offset: 3 }; }
    return new Promise<{ data: string; offset: number }>((answer) => { resolve = answer; });
  });
  const client: HostExtensionClient = {
    invoke, watch: () => () => undefined,
    onEvent(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => { set.delete(listener); };
    },
  };
  return {
    client, invoke,
    answer(data: string, offset: number) { resolve({ data, offset }); },
    output(data: string, offset: number) { for (const listener of listeners.get(TERMINAL_DATA_EVENT) ?? []) listener({ id: "remote-shell", data, offset }); },
  };
}

describe("mounted terminal reconnect", () => {
  it("replays only missed bytes, queues overlapping live output and releases the reconnect listener on unmount", async () => {
    const fake = host();
    disconnects.push(connectTerminalHost(fake.client));
    const view = render(<TerminalView session={{ id: "remote-shell", label: "Rex", cols: 80, rows: 24 }} place="panel" />);
    await waitFor(() => expect(writes).toEqual(["old"]));
    act(() => terminalHostReconnected());
    await waitFor(() => expect(fake.invoke.mock.calls.filter(([command]) => command === "replay")).toHaveLength(2));
    act(() => fake.output("lostlive", 11));
    expect(writes).toEqual(["old"]);
    await act(async () => fake.answer("oldlost", 7));
    await waitFor(() => expect(writes).toEqual(["old", "lost", "live"]));
    act(() => fake.output("lostlive", 11));
    expect(writes.join("")).toBe("oldlostlive");
    view.unmount();
    act(() => terminalHostReconnected());
    expect(fake.invoke.mock.calls.filter(([command]) => command === "replay")).toHaveLength(2);
  });
});

describe("a terminal's own navigation", () => {
  async function mounted(choose?: string) {
    const fake = host();
    disconnects.push(connectTerminalHost(fake.client));
    const show = vi.fn(async (_event: unknown, _sections: unknown[]) => choose);
    menu.show = show;
    const view = render(<TerminalView session={{ id: "remote-shell", label: "Rex", cols: 80, rows: 24 }} place="panel" />);
    await waitFor(() => expect(keyHandlers).toHaveLength(1));
    return { view, show, handler: keyHandlers[0]! };
  }
  const chord = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

  it("selects everything and jumps through the scrollback, keeping the key from the shell and the window", async () => {
    const { handler } = await mounted();
    const selectAll = chord({ key: "A", ctrlKey: true, shiftKey: true });
    expect(handler(selectAll)).toBe(false);
    expect(selectAll.defaultPrevented).toBe(true);
    handler(chord({ key: "Home", ctrlKey: true, shiftKey: true }));
    handler(chord({ key: "End", ctrlKey: true, shiftKey: true }));
    expect(calls).toEqual(["selectAll", "scrollToTop", "scrollToBottom"]);
    // Ctrl+A alone is the shell's: the line start.
    const plain = chord({ key: "a", ctrlKey: true });
    expect(handler(plain)).toBe(true);
    expect(plain.defaultPrevented).toBe(false);
  });

  it("opens the native menu on a right-click and carries out the choice", async () => {
    const { view, show } = await mounted("scroll-to-bottom");
    fireEvent.contextMenu(view.container.querySelector(".terminal-view")!);
    await waitFor(() => expect(calls).toContain("scrollToBottom"));
    expect(show).toHaveBeenCalledTimes(1);
    const sections = show.mock.calls[0]![1] as Array<{ items: Array<{ id: string }> }>;
    expect(sections.map((section) => section.items.map((item) => item.id))).toEqual([["copy", "paste"], ["select-all", "scroll-to-bottom"]]);
    expect(calls).toContain("focus");
  });

  it("does nothing when the menu is dismissed", async () => {
    const { view, show } = await mounted(undefined);
    fireEvent.contextMenu(view.container.querySelector(".terminal-view")!);
    await waitFor(() => expect(show).toHaveBeenCalled());
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});

describe("a selection drag at the window edge", () => {
  // The screen fills a 768 px window, so the pointer cannot leave it below or above.
  async function mounted() {
    const fake = host();
    disconnects.push(connectTerminalHost(fake.client));
    const view = render(<TerminalView session={{ id: "remote-shell", label: "Rex", cols: 80, rows: 24 }} place="panel" />);
    await waitFor(() => expect(view.container.querySelector(".xterm-screen")).not.toBeNull());
    const screen = view.container.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: window.innerHeight } as DOMRect);
    return { surface: view.container.querySelector<HTMLElement>(".terminal-view")!, screen };
  }
  const move = (clientY: number, buttons = 1) => fireEvent.mouseMove(document.body, { clientY, buttons });

  it("shows xterm a pointer outside its screen, farther the deeper it pushes, so it scrolls and extends the selection", async () => {
    const { surface } = await mounted();
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientY: 300 });
    move(window.innerHeight - 1);
    move(window.innerHeight - 5);
    move(6);
    move(1);
    const [bottomDeep, bottomShallow, topShallow, topDeep] = drag.seenY;
    expect(bottomShallow).toBeGreaterThan(window.innerHeight);
    expect(bottomDeep).toBeGreaterThan(bottomShallow!);
    expect(topShallow).toBeLessThan(0);
    expect(topDeep).toBeLessThan(topShallow!);
  });

  it("leaves the pointer alone away from the edge, without a drag, after the release and while an application has the mouse", async () => {
    const { surface } = await mounted();
    move(window.innerHeight - 1);
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientY: 300 });
    move(window.innerHeight / 2);
    fireEvent.mouseUp(document.body, { button: 0 });
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientY: 300 });
    fireEvent.mouseUp(document.body, { button: 0 });
    move(window.innerHeight - 1);
    drag.tracking = "any";
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientY: 300 });
    move(window.innerHeight - 1);
    const edge = window.innerHeight - 1;
    expect(drag.seenY).toEqual([edge, window.innerHeight / 2, edge, edge]);
  });

  it("leaves a terminal alone that has room below it, where xterm scrolls by itself", async () => {
    const { surface, screen } = await mounted();
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: window.innerHeight - 40 } as DOMRect);
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientY: 300 });
    move(window.innerHeight - 45);
    move(101);
    expect(drag.seenY).toEqual([window.innerHeight - 45, 101]);
  });
});
