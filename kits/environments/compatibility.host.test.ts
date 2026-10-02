import { expect, it, vi } from "vitest";
import type { HostMachineServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";

it.each(["unknown-method", "failed", "unauthorized", "timeout"])("handles %s from remote start-thread", async (code) => {
  const error = Object.assign(new Error('Unknown method "start-thread".'), { code });
  const machines = {
    self: { id: "mini", name: "mini", version: "1" },
    list: () => [{ id: "rex-id", name: "rex", status: "connected", address: "wss://rex/" }],
    subscribe: () => () => undefined, subscribeIndex: () => () => undefined,
    request: vi.fn(async () => { throw error; }), call: vi.fn(), watch: vi.fn(), upload: vi.fn(),
  } as HostMachineServices;
  const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
  const promise = registry.invoke("tau.environments", "start-there", { machine: "rex-id", workspaceId: "ws-rex", prompt: "Fix it" });
  if (code === "unknown-method") await expect(promise).rejects.toMatchObject({ message: "rex runs an older Tau that cannot start threads yet. Update rex in Settings → Machines.", code, cause: error });
  else await expect(promise).rejects.toBe(error);
});
