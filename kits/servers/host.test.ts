import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostExecutionPolicyProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createServersHostExtension } from "./host.js";
import { SERVERS_EXTENSION_ID, SERVERS_SETTINGS_SCOPE } from "./protocol.js";

const KIT_DIR = join("kits", "servers");

describe("Servers host half", () => {
  it("activates under the permissions its manifest names", async () => {
    const manifest = JSON.parse(readFileSync(join(KIT_DIR, "tau-extension.json"), "utf8")) as { id: string; permissions: string[]; isolation: string };
    const extension = createServersHostExtension();
    expect(extension.id).toBe(manifest.id);
    expect(manifest.id).toBe(SERVERS_EXTENSION_ID);
    expect([...(extension.permissions ?? [])].sort()).toEqual([...manifest.permissions].sort());
    expect(extension.isolation).toBe(manifest.isolation);
    const registry = await activateHostKit(extension);
    await registry.dispose();
  });
});

describe("Servers network limit", () => {
  it("provides the limit as a policy and holds Pi's bash to it, and withdraws both when it stops", async () => {
    let provider: HostExecutionPolicyProvider | undefined;
    const withdraw = vi.fn();
    const policies = { provide: (next: HostExecutionPolicyProvider) => { provider = next; return withdraw; }, changed: vi.fn(), for: vi.fn(), observe: vi.fn() };
    const runtimeExtensions: string[] = [];
    const unregister = vi.fn();
    const registry = await activateHostKit(createServersHostExtension(), {
      executionPolicy: policies as never,
      registerRuntimeExtension: (name: string) => { runtimeExtensions.push(name); return unregister; },
      workspaceRef: () => ({ workspaceId: "ws" }) as never,
    });
    // The tools come first: the network hook rewrites bash, the bypass check reads it as written.
    expect(runtimeExtensions).toEqual(["tau-servers-tools", "tau-servers-network"]);
    // The folder has no sftp.json and no targets: nothing limits it.
    expect(await provider!(process.cwd())).toBeUndefined();
    await registry.dispose();
    expect(unregister).toHaveBeenCalled();
    expect(withdraw).toHaveBeenCalled();
  });
});

// A project level would put a `.tau/config.json` into a server project (ADR 0028).
describe("Servers settings", () => {
  it("live on this machine only: no row, page or read takes a project level", () => {
    expect(SERVERS_SETTINGS_SCOPE).toBe("host");
    const offenders: string[] = [];
    for (const name of readdirSync(KIT_DIR, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/u.test(name) || /\.test\.tsx?$/u.test(name) || name.includes("fixtures")) continue;
      const source = readFileSync(join(KIT_DIR, name), "utf8");
      if (/scope\s*:\s*["'](?:project|both)["']/u.test(source)) offenders.push(`${name}: project scope`);
      if (/\.settings\(\s*[^)\s]/u.test(source)) offenders.push(`${name}: services.settings(cwd) reads the project level`);
      if (/editProject\s*\(/u.test(source)) offenders.push(`${name}: editProject`);
    }
    expect(offenders).toEqual([]);
  });
});
