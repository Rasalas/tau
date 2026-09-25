import { describe, expect, it, vi } from "vitest";
import type { HostMachine, HostMachineServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { AGENTS_EVENT, ENVIRONMENTS_EXTENSION_ID } from "./protocol.js";

function fakeMachines(list: HostMachine[]) {
  let listener: ((machines: readonly HostMachine[]) => void) | undefined;
  const machines: HostMachineServices = {
    list: () => list,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
    call: vi.fn(async () => ({ device: "agents-device", owner: false })),
    request: vi.fn(async () => undefined),
    watch: vi.fn(() => () => undefined),
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
});
