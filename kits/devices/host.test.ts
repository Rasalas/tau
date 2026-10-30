import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import host from "./host.js";
import { DEFAULT_SETTINGS, DEVICE_KIT } from "./protocol.js";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
it("publishes the same four tools to Pi and MCP and protects consent, install and project sync", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-device-host-test-")); paths.push(stateDir);
  const registerRuntimeExtension = vi.fn((_name: string, _factory: (pi: unknown, session: { sessionId: string; cwd: string }) => void) => () => undefined);
  const registerTools = vi.fn((_provider: (thread: { sessionId: string; cwd: string }) => readonly { name: string }[] | Promise<readonly { name: string }[]>) => () => undefined);
  const knownWorkspacePath = vi.fn(async (path: string) => { throw new Error(`unknown ${path}`); });
  const registry = await activateHostKit(host, { stateDir, registerRuntimeExtension, knownWorkspacePath, mcp: { registerTools, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined } });
  try {
    expect(registerRuntimeExtension).toHaveBeenCalledWith("tau-devices", expect.any(Function));
    expect(registerTools).toHaveBeenCalledWith(expect.any(Function));
    const registered: { name: string; exposure?: string }[] = [];
    registerRuntimeExtension.mock.calls[0]![1]({ registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool) }, { sessionId: "s1", cwd: "/work/app" });
    expect(registered.map((tool) => [tool.name, tool.exposure])).toEqual([["device_list", "deferred"], ["device_screenshot", "deferred"], ["device_control", "deferred"], ["device_sync_project", "deferred"]]);
    expect((await registerTools.mock.calls[0]![0]({ sessionId: "s1", cwd: "/work/app" })).map((tool) => tool.name)).toEqual(["device_list", "device_screenshot", "device_control", "device_sync_project"]);
    const readOnly = { kind: "workbench-client", connection: "phone", pairedClient: "c1", readOnly: true } as const;
    const paired = { kind: "workbench-client", connection: "phone", pairedClient: "c1" } as const;
    await expect(registry.invoke(DEVICE_KIT, "state", undefined, readOnly)).resolves.toMatchObject({ settings: { agentControl: false } });
    await expect(registry.invoke(DEVICE_KIT, "configure", DEFAULT_SETTINGS, paired)).rejects.toThrow();
    await expect(registry.invoke(DEVICE_KIT, "install", { hostId: "local", tool: "hub" }, paired)).rejects.toThrow();
    await expect(registry.invoke(DEVICE_KIT, "action", { hostId: "local", deviceId: "phone", action: "home" }, readOnly)).rejects.toThrow();
    await expect(registry.invoke(DEVICE_KIT, "sync-project", { hostId: "local" }, readOnly)).rejects.toThrow();
    // Full access reaches the manager, which needs an SSH machine; a named folder must be a project the host knows.
    await expect(registry.invoke(DEVICE_KIT, "sync-project", { hostId: "local" }, paired)).rejects.toThrow("SSH machine");
    await expect(registry.invoke(DEVICE_KIT, "sync-project", { hostId: "local", projectPath: "/etc" }, paired)).rejects.toThrow("not a project open in Tau");
    expect(knownWorkspacePath).toHaveBeenCalledWith("/etc");
  } finally { await registry.deactivate(DEVICE_KIT); }
});
