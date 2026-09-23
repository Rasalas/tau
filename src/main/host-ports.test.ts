import { describe, expect, it, vi } from "vitest";
import { createHostExtensionSeam, importDependency, loadDependencyModule, type ExtensionServicesPort } from "./host-ports.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";

describe("loadDependencyModule", () => {
  it("hands a CommonJS module's exports and an ES module's namespace to the kit", async () => {
    const exports = { spawn: () => undefined };
    expect(await loadDependencyModule("node-pty", async () => ({ default: exports }))).toBe(exports);
    const namespace: { default?: unknown; named: number } = { named: 1 };
    expect(await loadDependencyModule("esm-only", async () => namespace)).toBe(namespace);
  });

  it("loads by package name only, never by path", async () => {
    const load = vi.fn(async () => ({}));
    await expect(loadDependencyModule("../secrets.js", load)).rejects.toThrow(/not a package name/);
    await expect(importDependency("/etc/passwd")).rejects.toThrow(/not a package name/);
    await expect(importDependency("@scope/../x")).rejects.toThrow(/not a package name/);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("registerRuntimeBackend", () => {
  const seam = () => {
    const changed = vi.fn();
    const port = { registerTurnObserver: () => () => undefined, log: () => undefined, runtimeBackendsChanged: changed } as unknown as ExtensionServicesPort;
    return { seam: createHostExtensionSeam(port), changed };
  };
  const provider = (kind: string) => ({
    kind,
    adapter: { id: kind, capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } },
    listThreads: async () => [],
    lookup: async () => undefined,
    open: async () => { throw new Error("unused"); },
    composerCommands: () => [],
  }) as unknown as HostRuntimeBackendProvider;

  it("takes a program's instances as kinds of their own and says when the set changed", () => {
    const { seam: { services, backends }, changed } = seam();
    const stopDefault = services.registerRuntimeBackend(provider("codex"));
    const stopWork = services.registerRuntimeBackend(provider("codex@work"));
    expect([...backends.keys()]).toEqual(["codex", "codex@work"]);
    expect(changed).toHaveBeenCalledTimes(2);
    stopWork();
    stopWork();
    expect([...backends.keys()]).toEqual(["codex"]);
    expect(changed).toHaveBeenCalledTimes(3);
    stopDefault();
  });

  it("refuses Pi's kind, its instances and a kind that is no name", () => {
    const { services } = seam().seam;
    for (const kind of ["pi", "pi@work", "codex@Work", "codex@a@b", "bad kind", "", "@work"]) {
      expect(() => services.registerRuntimeBackend(provider(kind)), kind).toThrow();
    }
  });
});
