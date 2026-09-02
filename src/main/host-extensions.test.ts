import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { HostExtensionRegistry, type HostExtension, type HostExtensionServices } from "./host-extensions.js";

function services(): HostExtensionServices & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    cwd: () => "/project",
    safeMode: false,
    log: (label, detail) => { logs.push(detail ? `${label} ${detail}` : label); },
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
  };
}

function registry() {
  const events: GlobalHostEvent[] = [];
  const s = services();
  return { registry: new HostExtensionRegistry(s, (event) => events.push(event)), events, services: s };
}

describe("HostExtensionRegistry", () => {
  it("routes commands by extension id and command name", async () => {
    const { registry: r } = registry();
    const extension: HostExtension = {
      id: "demo.kit",
      name: "Demo Kit",
      activate: (ctx) => { ctx.registerCommand("echo", (input) => ({ input })); },
    };
    await expect(r.activate(extension)).resolves.toBe(true);
    await expect(r.invoke("demo.kit", "echo", { a: 1 })).resolves.toEqual({ input: { a: 1 } });
    expect(r.summaries()).toEqual([{ id: "demo.kit", name: "Demo Kit", active: true, commands: ["echo"] }]);
  });

  it("rejects unknown extensions and commands with a readable reason", async () => {
    const { registry: r } = registry();
    await r.activate({ id: "demo.kit", name: "Demo Kit", activate: (ctx) => { ctx.registerCommand("echo", () => 1); } });
    await expect(r.invoke("other.kit", "echo")).rejects.toThrow("Host extension other.kit is not installed.");
    await expect(r.invoke("demo.kit", "missing")).rejects.toThrow('Host extension Demo Kit has no command "missing".');
    await r.deactivate("demo.kit");
    await expect(r.invoke("demo.kit", "echo")).rejects.toThrow("Host extension Demo Kit is not active.");
  });

  it("publishes extension events only while the extension is active", async () => {
    const { registry: r, events } = registry();
    let emit: ((name: string, payload?: unknown) => void) | undefined;
    await r.activate({ id: "demo.kit", name: "Demo Kit", activate: (ctx) => { emit = ctx.emit; } });
    emit?.("changed", { path: "a" });
    await r.deactivate("demo.kit");
    emit?.("changed", { path: "b" });
    expect(events).toEqual([{ type: "extension-event", extensionId: "demo.kit", name: "changed", payload: { path: "a" } }]);
  });

  it("records an activation failure without throwing, and runs partial cleanup", async () => {
    const { registry: r, services: s } = registry();
    const dispose = vi.fn();
    const ok = await r.activate({
      id: "broken.kit",
      name: "Broken Kit",
      activate: (ctx) => {
        const off = ctx.registerCommand("echo", () => 1);
        dispose.mockImplementation(off);
        throw new Error("boom");
      },
    });
    expect(ok).toBe(false);
    expect(r.isActive("broken.kit")).toBe(false);
    expect(r.summaries()).toEqual([{ id: "broken.kit", name: "Broken Kit", active: false, commands: [], error: "boom" }]);
    expect(s.logs.some((line) => line.startsWith("host-extension.failed"))).toBe(true);
  });

  it("refuses invalid ids and command names", async () => {
    const { registry: r } = registry();
    expect(await r.activate({ id: "Bad Id", name: "x", activate: () => undefined })).toBe(false);
    expect(await r.activate({ id: "demo.kit", name: "x", activate: (ctx) => { ctx.registerCommand("Not Valid", () => 1); } })).toBe(false);
    expect(r.summaries().find((entry) => entry.id === "demo.kit")?.error).toContain("invalid command name");
  });

  it("runs disposers in reverse order on deactivate and dispose", async () => {
    const { registry: r } = registry();
    const order: string[] = [];
    await r.activate({ id: "a.kit", name: "A", activate: () => () => { order.push("a"); } });
    await r.activate({ id: "b.kit", name: "B", activate: () => async () => { order.push("b"); } });
    await r.dispose();
    expect(order).toEqual(["b", "a"]);
    expect(r.summaries().every((entry) => !entry.active)).toBe(true);
  });
});
