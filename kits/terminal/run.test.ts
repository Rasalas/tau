import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { runInTerminal } from "./controller.js";
import terminal from "./desktop.js";
import { connectTerminalHost, terminalStore } from "./store.js";
import { TERMINAL_EXITED_EVENT, TERMINAL_LIST_EVENT, TERMINAL_PANEL, TERMINAL_RUN_SERVICE, type TerminalRunService, type UiTerminalSession } from "./protocol.js";

/** A host that opens shells, records what is typed, and pushes what the test says. */
function fakeHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sessions: UiTerminalSession[] = [];
  const push = (name: string, payload: unknown) => listeners.get(name)?.forEach((listener) => listener(payload));
  const typed: Array<{ id: string; data: string }> = [];
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    const fields = (input ?? {}) as Record<string, unknown>;
    if (command === "list") return [...sessions];
    if (command === "input") { typed.push({ id: String(fields.id), data: String(fields.data) }); return undefined; }
    if (command !== "open") return undefined;
    const session: UiTerminalSession = { id: `t${sessions.length + 1}`, label: String(fields.label ?? "zsh"), cols: 80, rows: 24, ...(typeof fields.workspaceId === "string" ? { workspaceId: fields.workspaceId } : {}) };
    sessions.push(session);
    push(TERMINAL_LIST_EVENT, [...sessions]);
    return session;
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
  return {
    host,
    invoke,
    typed,
    exit(id: string, exitCode: number) { push(TERMINAL_EXITED_EVENT, { id, exitCode }); },
    close(id: string) {
      sessions.splice(sessions.findIndex((session) => session.id === id), 1);
      push(TERMINAL_LIST_EVENT, [...sessions]);
    },
  };
}

const disconnects: Array<() => void> = [];
afterEach(() => { for (const disconnect of disconnects.splice(0)) disconnect(); });

function actions() {
  return { openPanel: vi.fn(), activeThread: () => ({ workspaceId: "workspace-one" }) };
}

describe("running a command in a terminal", () => {
  it("opens a shell of its own, shows it, types the command with an exit after it, and answers with its status", async () => {
    const fake = fakeHost();
    disconnects.push(connectTerminalHost(fake.host));
    const app = actions();
    const running = runInTerminal(app, { command: "brew upgrade --cask codex", label: "Update Codex" });
    await vi.waitFor(() => expect(fake.typed).toHaveLength(1));
    expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one", label: "Update Codex" });
    expect(fake.typed).toEqual([{ id: "t1", data: "brew upgrade --cask codex; exit\r" }]);
    expect(app.openPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
    expect(terminalStore.getSnapshot().layout.groups.some((group) => JSON.stringify(group.root).includes("t1"))).toBe(true);
    fake.exit("t1", 3);
    await expect(running).resolves.toEqual({ id: "t1", exitCode: 3 });
  });

  it("answers without a status when the shell was closed before it ended", async () => {
    const fake = fakeHost();
    disconnects.push(connectTerminalHost(fake.host));
    const running = runInTerminal(actions(), { command: "npm install -g @openai/codex@latest" });
    await vi.waitFor(() => expect(fake.typed).toHaveLength(1));
    fake.close("t1");
    await expect(running).resolves.toEqual({ id: "t1" });
  });

  it("is published as a service other kits reach by id", () => {
    const { registry } = createKitHarness();
    registry.activate(terminal);
    let found: TerminalRunService | undefined;
    registry.activate({ id: "acme.user", name: "User", activate: (plugin) => { plugin.useService<TerminalRunService>(TERMINAL_RUN_SERVICE, (service) => { found = service; }); } });
    expect(typeof found?.run).toBe("function");
    registry.deactivate("acme.user");
    registry.deactivate(terminal.id);
  });
});
