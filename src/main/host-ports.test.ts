import { describe, expect, it, vi } from "vitest";
import { importDependency, loadDependencyModule } from "./host-ports.js";

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
