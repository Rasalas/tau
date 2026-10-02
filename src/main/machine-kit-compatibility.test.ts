import { describe, expect, it, vi } from "vitest";
import { MachineKitRoute } from "./machine-kit-route.js";
import type { HostMachines } from "./host-machines.js";

describe("routed kit compatibility", () => {
  it.each(["unknown-method", "unknown-extension", "unknown-command"])("turns %s from the destination into the requested kit's update sentence", async (code) => {
    const error = Object.assign(new Error("remote failure"), { code });
    const machines = { list: () => [{ id: "rex-id", name: "rex" }], call: vi.fn(async () => { throw error; }) } as unknown as HostMachines;
    const route = new MachineKitRoute({ machines: () => machines, active: () => undefined });
    await expect(route.call({ machine: "rex-id", input: {} }, "tau.files", "read")).rejects.toMatchObject({
      message: "rex has no Files that can do this yet. Update rex.", code, cause: error,
    });
  });

  it("leaves an installed but inactive destination kit unchanged", async () => {
    const error = Object.assign(new Error("Host extension Files is not active: worker crashed."), { code: "failed" });
    const machines = { list: () => [], call: vi.fn(async () => { throw error; }) } as unknown as HostMachines;
    const route = new MachineKitRoute({ machines: () => machines, active: () => undefined });
    await expect(route.call({ machine: "rex", input: {} }, "tau.files", "read")).rejects.toBe(error);
  });
});
