import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import host from "./host.js";
import { DEFAULT_SETTINGS, DEVICE_KIT } from "./protocol.js";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
it("publishes the same three tools to Pi and MCP and protects consent and install with owner access", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-device-host-test-")); paths.push(stateDir);
  const registerRuntimeExtension = vi.fn(() => () => undefined), registerTools = vi.fn(() => () => undefined);
  const registry = await activateHostKit(host, { stateDir, registerRuntimeExtension, mcp: { registerTools, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined } });
  try {
    expect(registerRuntimeExtension).toHaveBeenCalledWith("tau-devices", expect.any(Function));
    expect(registerTools).toHaveBeenCalledWith(expect.any(Function));
    const readOnly = { kind: "workbench-client", connection: "phone", pairedClient: "c1", readOnly: true } as const;
    const paired = { kind: "workbench-client", connection: "phone", pairedClient: "c1" } as const;
    await expect(registry.invoke(DEVICE_KIT, "state", undefined, readOnly)).resolves.toMatchObject({ settings: { agentControl: false } });
    await expect(registry.invoke(DEVICE_KIT, "configure", DEFAULT_SETTINGS, paired)).rejects.toThrow();
    await expect(registry.invoke(DEVICE_KIT, "install", { hostId: "local", tool: "hub" }, paired)).rejects.toThrow();
    await expect(registry.invoke(DEVICE_KIT, "action", { hostId: "local", deviceId: "phone", action: "home" }, readOnly)).rejects.toThrow();
  } finally { await registry.deactivate(DEVICE_KIT); }
});
