// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { connectTerminalHost, terminalHostReconnected } from "./store.js";
import { TerminalView } from "./view.js";
import { TERMINAL_DATA_EVENT } from "./protocol.js";

const { writes } = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    buffer = { active: { getLine: () => undefined } };
    loadAddon() {}
    open() {}
    write(data: string, done?: () => void) { writes.push(data); done?.(); }
    onData() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const disconnects: Array<() => void> = [];
beforeEach(() => {
  writes.length = 0;
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
