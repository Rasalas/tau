import { describe, expect, it } from "vitest";
import type { TauConfig } from "../shared/contracts.js";
import { RuntimeGate, RuntimeOffError } from "./runtime-gate.js";

function gate(configs: Record<string, TauConfig>, machine: TauConfig = {}) {
  return new RuntimeGate({
    config: (path) => (path === undefined ? machine : { ...machine, ...configs[path], runtimeEnabled: { ...machine.runtimeEnabled, ...configs[path]?.runtimeEnabled } }),
    owner: async (cwd) => cwd.endsWith("-wt") ? cwd.slice(0, -3) : cwd,
    label: (kind) => kind === "codex@work" ? "Codex · work" : kind === "codex" ? "Codex" : kind,
    projectName: (path) => path.split("/").pop() ?? path,
    projectPaths: () => Object.keys(configs),
  });
}

describe("RuntimeGate", () => {
  it("lets a runtime without an entry start work", async () => {
    await expect(gate({ "/a": {} }).assert("codex", "/a")).resolves.toBeUndefined();
  });

  it("refuses with one message that names the runtime and the project", async () => {
    const off = gate({ "/work/a": { runtimeEnabled: { codex: false } } });
    await expect(off.assert("codex", "/work/a")).rejects.toThrow(RuntimeOffError);
    await expect(off.assert("codex", "/work/a")).rejects.toThrow("Codex is turned off for “a”. Turn it on under Settings → Runtimes");
    await expect(off.assert("cursor", "/work/a")).resolves.toBeUndefined();
  });

  it("lets the project turn on what the machine turned off, and off what it left on", async () => {
    const machineOff = gate({ "/a": { runtimeEnabled: { codex: true } }, "/b": {} }, { runtimeEnabled: { codex: false } });
    await expect(machineOff.enabled("codex", "/a")).resolves.toBe(true);
    await expect(machineOff.enabled("codex", "/b")).resolves.toBe(false);
    const machineOn = gate({ "/a": { runtimeEnabled: { codex: false } }, "/b": {} });
    await expect(machineOn.enabled("codex", "/a")).resolves.toBe(false);
    await expect(machineOn.enabled("codex", "/b")).resolves.toBe(true);
  });

  it("treats an instance as its own runtime", async () => {
    const instances = gate({ "/a": { runtimeEnabled: { "codex@work": false } } });
    await expect(instances.enabled("codex@work", "/a")).resolves.toBe(false);
    await expect(instances.enabled("codex", "/a")).resolves.toBe(true);
  });

  it("follows a worktree to its project", async () => {
    await expect(gate({ "/a": { runtimeEnabled: { codex: false } } }).enabled("codex", "/a-wt")).resolves.toBe(false);
  });

  it("leaves a thread on another machine to that machine", async () => {
    await expect(gate({ "/a": { runtimeEnabled: { machine: false } } }).enabled("machine", "/a")).resolves.toBe(true);
  });

  it("counts a runtime as used while the machine or any project keeps it on", () => {
    expect(gate({ "/a": { runtimeEnabled: { codex: false } } }, { runtimeEnabled: { codex: false } }).inUse("codex")).toBe(false);
    expect(gate({ "/a": { runtimeEnabled: { codex: true } } }, { runtimeEnabled: { codex: false } }).inUse("codex")).toBe(true);
    expect(gate({ "/a": { runtimeEnabled: { codex: false } } }).inUse("codex")).toBe(true);
    expect(gate({}).inUse("codex")).toBe(true);
  });
});
