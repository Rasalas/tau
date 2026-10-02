import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { connectTerminalHost, onTerminalEvent, refreshTerminalSessions, onTerminalReconnect, terminalStore } from "./store.js";
import terminal from "./desktop.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { WORKSPACE_STORE_SERVICE, TERMINAL_HOST_EXTENSION_ID, TERMINAL_EXITED_EVENT, TERMINAL_LIST_EVENT, TERMINAL_SESSIONS_TOPIC, type UiTerminalSession } from "./protocol.js";

const disconnects: Array<() => void> = [];
afterEach(() => { for (const disconnect of disconnects.splice(0)) disconnect(); });
const shell: UiTerminalSession = { id: "remote-shell", workspaceId: "rex-workspace", sessionId: "rex~thread", label: "rex shell", cols: 80, rows: 24 };

function host() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const watched = new Set<string>();
  const stopWatch = vi.fn();
  const invoke = vi.fn<HostExtensionClient["invoke"]>(async () => []);
  const watch = vi.fn((topic: string) => {
    watched.add(topic);
    return () => { watched.delete(topic); stopWatch(topic); };
  });
  const client: HostExtensionClient = {
    invoke, watch,
    onEvent(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => { set.delete(listener); };
    },
  };
  return {
    client, invoke, watch, stopWatch, watched,
    emit(name: string, payload: unknown) {
      if (watched.has(TERMINAL_SESSIONS_TOPIC)) for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
}

describe("terminal sessions topic", () => {
  it("follows relayed session and exit changes for the connection's lifetime", async () => {
    const fake = host();
    const disconnect = connectTerminalHost(fake.client);
    disconnects.push(disconnect);
    expect(fake.watch).toHaveBeenCalledWith(TERMINAL_SESSIONS_TOPIC);
    expect(fake.invoke).toHaveBeenCalledWith("list");
    fake.emit(TERMINAL_LIST_EVENT, [shell]);
    expect(terminalStore.getSnapshot().sessions).toEqual([shell]);
    const exited = vi.fn();
    const stopExit = onTerminalEvent(TERMINAL_EXITED_EVENT, exited);
    fake.emit(TERMINAL_EXITED_EVENT, { id: shell.id, exitCode: 3 });
    expect(exited).toHaveBeenCalledExactlyOnceWith({ id: shell.id, exitCode: 3 });
    stopExit();
    disconnects.pop()!();
    expect(fake.stopWatch).toHaveBeenCalledExactlyOnceWith(TERMINAL_SESSIONS_TOPIC);
    expect(fake.watched.size).toBe(0);
    fake.emit(TERMINAL_LIST_EVENT, [shell]);
    expect(terminalStore.getSnapshot().sessions).toEqual([]);
  });

  it("keeps a live remote session update newer than a pending list response", async () => {
    const fake = host();
    let answer!: (value: unknown) => void;
    fake.invoke.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    disconnects.push(connectTerminalHost(fake.client));
    fake.emit(TERMINAL_LIST_EVENT, [shell]);
    answer([]);
    await Promise.resolve();
    expect(terminalStore.getSnapshot().sessions).toEqual([shell]);
  });
});


describe("terminal home refresh", () => {
  it("lets the latest requested home replace a slower previous home list", async () => {
    const fake = host();
    const answers: Array<(value: unknown) => void> = [];
    fake.invoke.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    disconnects.push(connectTerminalHost(fake.client));
    const refreshed = refreshTerminalSessions();
    answers[1]!([shell]);
    await refreshed;
    answers[0]!([]);
    await Promise.resolve();
    expect(terminalStore.getSnapshot().sessions).toEqual([shell]);
  });

  it("reads shells on active-thread and home-workspace changes and releases the workspace subscription", async () => {
    const invoke = vi.fn(async (_extension: string, command: string) => command === "list" ? [shell] : undefined);
    const { registry } = createKitHarness(invoke);
    let workspaceId = "here-workspace";
    const listeners = new Set<() => void>();
    registry.activate({
      id: "tau.workspace", name: "Workspace",
      activate(plugin) {
        return plugin.provideService(WORKSPACE_STORE_SERVICE, {
          getSnapshot: () => ({ cwd: "/same-path", workspaceId }),
          subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
          registerThreadRowAccessory: () => () => undefined,
        });
      },
    });
    registry.activate(terminal);
    disconnects.push(() => { registry.deactivate(terminal.id); registry.deactivate("tau.workspace"); });
    const lists = () => invoke.mock.calls.filter((call) => call[1] === "list").length;
    const before = lists();
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "rex~thread" });
    expect(lists()).toBe(before + 1);
    workspaceId = "rex-workspace";
    for (const listener of listeners) listener();
    expect(lists()).toBe(before + 2);
    for (const listener of listeners) listener();
    expect(lists()).toBe(before + 2);
    const reconnect = vi.fn();
    const stopReconnect = onTerminalReconnect(reconnect);
    registry.dispatchWorkbenchEvent({ type: "host-connection", state: "reconnecting" });
    expect(reconnect).not.toHaveBeenCalled();
    registry.dispatchWorkbenchEvent({ type: "host-connection", state: "connected" });
    expect(lists()).toBe(before + 3);
    expect(reconnect).toHaveBeenCalledOnce();
    stopReconnect();
    await vi.waitFor(() => expect(terminalStore.getSnapshot().sessions).toEqual([shell]));
    expect(invoke).toHaveBeenCalledWith(TERMINAL_HOST_EXTENSION_ID, "list", undefined);
    disconnects.pop()!();
    expect(listeners.size).toBe(0);
  });
});
