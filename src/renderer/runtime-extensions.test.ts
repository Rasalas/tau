// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ExtensionRegistry } from "./extension-system";
import { RuntimeExtensions, isDesktopExtension, sharedExportNames, type RuntimeExtensionHost } from "./runtime-extensions";

function host(bundles: Array<{ path: string; module: unknown }>, extra: Partial<RuntimeExtensionHost> = {}) {
  const log = vi.fn();
  const notify = vi.fn();
  const modules = new Map(bundles.map((entry) => [entry.path, entry.module]));
  return {
    log,
    notify,
    host: {
      load: async () => ({ bundles: bundles.map((entry) => ({ path: entry.path, scope: "global" as const, code: "" })), errors: [], skipped: [] }),
      importModule: async (_code: string, path: string) => modules.get(path),
      isEnabled: () => true,
      notify,
      log,
      ...extra,
    },
  };
}

describe("runtime desktop extensions", () => {
  it("activates a loaded module and replaces it on the next sync", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn((plugin: { registerCommand(command: { id: string; label: string; group: string; run(): void }): void }) => {
      plugin.registerCommand({ id: "hello.run", label: "Hello", group: "Extensions", run: () => {} });
    });
    const { host: h, log } = host([{ path: "/x/hello.tsx", module: { default: { id: "x.hello", name: "Hello", activate } } }]);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    expect(registry.getCommands().map((command) => command.id)).toContain("hello.run");
    await runtime.sync("/project");
    expect(activate).toHaveBeenCalledTimes(2);
    expect(registry.getCommands().filter((command) => command.id === "hello.run")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("desktop-extension.loaded", expect.stringContaining("Hello"));
  });

  it("reports a module without a valid default export instead of throwing", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, notify } = host([{ path: "/x/broken.tsx", module: { default: { id: "" } } }]);
    await new RuntimeExtensions(registry, h).sync("/project");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken.tsx"));
    expect(registry.getExtensionSummaries()).toHaveLength(0);
  });

  it("validates the extension shape and lists shared exports", () => {
    expect(isDesktopExtension({ id: "a", name: "A", activate() {} })).toBe(true);
    expect(isDesktopExtension({ id: "a" })).toBe(false);
    const names = sharedExportNames({ react: { useState() {}, useEffect() {} } });
    expect(names.react).toEqual(["useState", "useEffect"]);
  });
});
