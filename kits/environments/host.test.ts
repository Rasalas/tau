import { describe, expect, it, vi } from "vitest";
import type { HostMachine, HostMachineServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { AGENTS_EVENT, ENVIRONMENTS_EXTENSION_ID } from "./protocol.js";

function fakeMachines(list: HostMachine[]) {
  let listener: ((machines: readonly HostMachine[]) => void) | undefined;
  const machines: HostMachineServices = {
    self: { id: "mini-id", name: "mini", version: "0.7.0" },
    list: () => list,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
    call: vi.fn(async () => ({ device: "agents-device", owner: false })),
    request: vi.fn(async () => undefined),
    watch: vi.fn(() => () => undefined),
    upload: vi.fn(async () => ({ id: "blob", size: 0, sha256: "" })),
  };
  return { machines, changed: () => listener?.(list) };
}

describe("Machines Kit on the host", () => {
  it("reports the machines this host's agents reach, and again when they change", async () => {
    const list: HostMachine[] = [{ id: "rex-id", name: "rex", status: "connected", roundTripMs: 3, address: "wss://rex/" }];
    const { machines, changed } = fakeMachines(list);
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines }, (event) => events.push(event));
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "agents")).toEqual({ available: true, machines: [{ id: "rex-id", name: "rex", status: "connected", roundTripMs: 3 }] });
    list[0] = { ...list[0]!, status: "refused", detail: "revoked" };
    changed();
    expect(events.at(-1)).toMatchObject({ name: AGENTS_EVENT, payload: { machines: [{ status: "refused", detail: "revoked" }] } });
  });

  it("says there are none on a host that keeps no machines", async () => {
    const registry = await activateHostKit(createEnvironmentsHostExtension());
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "agents")).toEqual({ available: false, machines: [] });
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "probe", { machine: "rex" })).rejects.toThrow(/keeps no machines/u);
  });

  it("reaches the same kit on another machine, which names the device the call came as", async () => {
    const { machines } = fakeMachines([]);
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "probe", { machine: "rex" })).toMatchObject({ device: "agents-device", owner: false, ms: expect.any(Number) });
    expect(machines.call).toHaveBeenCalledWith("rex", ENVIRONMENTS_EXTENSION_ID, "whoami");
    const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: "d1" };
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "whoami", undefined, paired)).toEqual({ device: "d1", owner: false });
  });

  it("asks a machine how busy it is and what it could run, only when called", async () => {
    const { machines } = fakeMachines([]);
    machines.request = vi.fn(async (_machine: string, method: string) => ({ method }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    expect(machines.request).not.toHaveBeenCalled();
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", { machine: "rex" })).toEqual({ method: "host-resources" });
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, "readiness", { machine: "mini-id" })).toEqual({ method: "readiness" });
    expect(machines.request).toHaveBeenCalledWith("rex", "host-resources", [], { timeoutMs: 20_000 });
    expect(machines.request).toHaveBeenCalledWith("mini-id", "readiness", [], { timeoutMs: 20_000 });
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", {})).rejects.toThrow(/name a machine/u);
    // A paired device may look.
    const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: "d1", readOnly: true as const };
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "readiness", { machine: "rex" }, paired)).resolves.toEqual({ method: "readiness" });
  });

  it("has nothing to ask on a host that keeps no machines", async () => {
    const registry = await activateHostKit(createEnvironmentsHostExtension());
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, "resources", { machine: "rex" })).rejects.toThrow(/keeps no machines/u);
  });
});
