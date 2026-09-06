import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices, type RuntimeExtensionContribution } from "../host-extensions.js";
import type { RuntimePermissionLevel } from "../runtime-adapters.js";
import { createAccessHostExtension } from "./access-host-extension.js";

function harness() {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  let level: (() => RuntimePermissionLevel) | undefined;
  const services: HostExtensionServices = {
    cwd: () => "/project",
    safeMode: false,
    log: vi.fn(),
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    agentDir: () => "/agent",
    skills: () => [],
    refreshExtensionPackages: async () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: (name, factory) => {
      runtimeExtensions.push({ name, factory });
      return () => { runtimeExtensions.splice(runtimeExtensions.findIndex((entry) => entry.factory === factory), 1); };
    },
    setPermissionLevel: (provider) => { level = provider; },
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
  };
  const registry = new HostExtensionRegistry(services, (event) => events.push(event));
  return { registry, events, runtimeExtensions, policy: () => level?.() };
}

describe("Access Kit host extension", () => {
  it("contributes the gate to Pi runtimes and starts with full access", async () => {
    const { registry, runtimeExtensions, policy } = harness();
    await registry.activate(createAccessHostExtension());
    expect(runtimeExtensions.map((entry) => entry.name)).toEqual(["tau-access"]);
    await expect(registry.invoke("tau.access", "level")).resolves.toBe("full");
    expect(policy()).toBe("full");
  });

  it("changes the level, the external permission policy, and tells the desktop side", async () => {
    const { registry, events, policy } = harness();
    await registry.activate(createAccessHostExtension());
    await expect(registry.invoke("tau.access", "set-level", { level: "read-only" })).resolves.toBe("read-only");
    expect(policy()).toBe("read-only");
    expect(events).toEqual([{ type: "extension-event", extensionId: "tau.access", name: "level", payload: "read-only" }]);
    await registry.invoke("tau.access", "set-level", { level: "read-only" });
    expect(events).toHaveLength(1);
  });

  it("rejects unknown levels and restores full access when deactivated", async () => {
    const { registry, policy } = harness();
    await registry.activate(createAccessHostExtension());
    await expect(registry.invoke("tau.access", "set-level", { level: "root" })).rejects.toThrow("Access level must be read-only, ask or full.");
    await registry.invoke("tau.access", "set-level", { level: "ask" });
    expect(policy()).toBe("ask");
    await registry.deactivate("tau.access");
    expect(policy()).toBeUndefined();
  });
});
