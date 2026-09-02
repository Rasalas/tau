import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices, type RuntimeExtensionContribution } from "../host-extensions.js";
import type { RuntimePermissionPolicy } from "../runtime-adapters.js";
import { createAccessHostExtension } from "./access-host-extension.js";

function harness() {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  let policy: (() => RuntimePermissionPolicy) | undefined;
  const services: HostExtensionServices = {
    cwd: () => "/project",
    safeMode: false,
    log: vi.fn(),
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    git: {} as never,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    registerRuntimeExtension: (name, factory) => {
      runtimeExtensions.push({ name, factory });
      return () => { runtimeExtensions.splice(runtimeExtensions.findIndex((entry) => entry.factory === factory), 1); };
    },
    setPermissionPolicy: (provider) => { policy = provider; },
  };
  const registry = new HostExtensionRegistry(services, (event) => events.push(event));
  return { registry, events, runtimeExtensions, policy: () => policy?.() };
}

describe("Access Kit host extension", () => {
  it("contributes the gate to Pi runtimes and starts with full access", async () => {
    const { registry, runtimeExtensions, policy } = harness();
    await registry.activate(createAccessHostExtension());
    expect(runtimeExtensions.map((entry) => entry.name)).toEqual(["tau-access"]);
    await expect(registry.invoke("tau.access", "level")).resolves.toBe("full");
    expect(policy()?.permissionMode).toBe("auto");
  });

  it("changes the level, the external permission policy, and tells the desktop side", async () => {
    const { registry, events, policy } = harness();
    await registry.activate(createAccessHostExtension());
    await expect(registry.invoke("tau.access", "set-level", { level: "read-only" })).resolves.toBe("read-only");
    expect(policy()?.permissionMode).toBe("plan");
    expect(events).toEqual([{ type: "extension-event", extensionId: "tau.access", name: "level", payload: "read-only" }]);
    await registry.invoke("tau.access", "set-level", { level: "read-only" });
    expect(events).toHaveLength(1);
  });

  it("rejects unknown levels and restores full access when deactivated", async () => {
    const { registry, policy } = harness();
    await registry.activate(createAccessHostExtension());
    await expect(registry.invoke("tau.access", "set-level", { level: "root" })).rejects.toThrow("Access level must be read-only, ask or full.");
    await registry.invoke("tau.access", "set-level", { level: "ask" });
    expect(policy()?.permissionMode).toBe("manual");
    await registry.deactivate("tau.access");
    expect(policy()).toBeUndefined();
  });
});
