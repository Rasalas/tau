import { describe, expect, it, vi } from "vitest";
import type { HostMachine, HostMachineServices, HostReadiness, HostResources } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createMachineChooser } from "./chooser.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { CHOOSE_MACHINE_COMMAND, ENVIRONMENTS_EXTENSION_ID } from "./protocol.js";

const GB = 1024 ** 3;

const ready: HostReadiness = {
  checkedAt: 0,
  runtimes: [{ kind: "pi", label: "Pi", state: "ready", models: 1, modelIds: ["openai-codex/gpt-5.6-luna"] }],
  git: { version: "2.50.0", mergeTree: true },
  disk: { path: "/w", free: 100 * GB },
  display: { kind: "screen" },
};

function fakeMachines(list: HostMachine[], load: Record<string, Partial<HostResources>>) {
  const request = vi.fn(async (machine: string, method: string) => {
    if (method === "readiness") return ready;
    const patch = load[machine];
    if (!patch) throw new Error("timed out");
    return { sampledAt: 0, cpuCount: 2, cpuUtilization: 0.1, totalMemory: 8 * GB, availableMemory: 4 * GB, runningTurns: 0, ...patch } satisfies HostResources;
  });
  const machines: HostMachineServices = {
    self: { id: "mac-id", name: "mac", version: "0.7.0" },
    list: () => list,
    subscribe: () => () => undefined,
    call: vi.fn(),
    request,
    watch: vi.fn(() => () => undefined),
    upload: vi.fn(),
  };
  return { machines, request };
}

const rex: HostMachine = { id: "rex-id", name: "rex", status: "connected" };

describe("choose-machine on the host", () => {
  it("sends work to rex while this computer is busy, and keeps it here once rex is loaded", async () => {
    const load: Record<string, Partial<HostResources>> = { "mac-id": { cpuCount: 10, cpuUtilization: 0.6 }, "rex-id": {} };
    const { machines } = fakeMachines([rex], load);
    let now = 0;
    const choose = createMachineChooser({ machines: () => machines, weights: async () => ({}), now: () => now });
    const first = await choose({ purpose: "sub-agent", model: "openai-codex/gpt-5.6-luna" });
    expect(first).toMatchObject({ machine: "rex-id", reason: expect.stringMatching(/^rex has the most room: 45 .*; this computer 10\.$/u) });
    load["rex-id"] = { cpuUtilization: 0.97 };
    now += 11_000;
    expect(await choose({ purpose: "sub-agent" })).toMatchObject({ machine: null, reason: expect.stringContaining("rex left out: CPU 97 %") });
  });

  it("asks each machine again only once its reading is 10 s old, and readiness after a minute", async () => {
    const { machines, request } = fakeMachines([rex], { "mac-id": {}, "rex-id": {} });
    let now = 0;
    const choose = createMachineChooser({ machines: () => machines, weights: async () => ({}), now: () => now });
    await choose({ purpose: "thread" });
    now += 5_000;
    await choose({ purpose: "thread" });
    expect(request).toHaveBeenCalledTimes(4);
    now += 6_000;
    await choose({ purpose: "thread" });
    expect(request.mock.calls.filter(([, method]) => method === "host-resources")).toHaveLength(4);
    expect(request.mock.calls.filter(([, method]) => method === "readiness")).toHaveLength(2);
  });

  it("leaves out a machine that is offline, Read only, silent, outside the caller's list or weighted 0, without asking it", async () => {
    const list: HostMachine[] = [
      rex,
      { id: "ci-id", name: "ci", status: "offline" },
      { id: "ro-id", name: "ro", status: "connected", readOnly: true },
      { id: "mute-id", name: "mute", status: "connected" },
      { id: "far-id", name: "far", status: "connected" },
    ];
    const { machines, request } = fakeMachines(list, { "mac-id": {} });
    const choose = createMachineChooser({ machines: () => machines, weights: async () => ({ "rex-id": 0 }) });
    const answer = await choose({ purpose: "thread", machines: ["rex-id", "ci-id", "ro-id", "mute-id"] });
    expect(answer.machine).toBeNull();
    expect(answer.machines.map((verdict) => [verdict.name, verdict.excluded])).toEqual([
      ["mac", undefined],
      ["rex", "weight 0, never automatically"],
      ["ci", "offline"],
      ["ro", "Read only for this computer's agents"],
      ["mute", "did not answer: timed out"],
    ]);
    expect(request.mock.calls.map(([machine]) => machine).sort()).toEqual(["mac-id", "mac-id", "mute-id", "mute-id"]);
  });

  it("runs here on a host that keeps no machines", async () => {
    const choose = createMachineChooser({ machines: () => undefined, weights: async () => ({}) });
    expect(await choose({ purpose: "sub-agent" })).toEqual({ machine: null, reason: "This host keeps no other machines; this computer runs it.", machines: [] });
  });

  it("reads the weights from Settings → Machines, for any client that may look", async () => {
    const { machines } = fakeMachines([rex], { "mac-id": { cpuCount: 10, cpuUtilization: 0.6 }, "rex-id": {} });
    const settings = vi.fn(async () => ({ options: {}, values: { weights: JSON.stringify({ "mac-id": 100 }) } }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), { machines, settings });
    // mac: 100 × 10 × 0.4 × 0.5 = 200 against rex's 45.
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, CHOOSE_MACHINE_COMMAND, { purpose: "sub-agent" })).toMatchObject({ machine: null, reason: expect.stringMatching(/^This computer has the most room: 200/u) });
    const paired = { kind: "workbench-client" as const, connection: "c1", pairedClient: "d1", readOnly: true as const };
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, CHOOSE_MACHINE_COMMAND, { purpose: "thread" }, paired)).resolves.toMatchObject({ machine: null });
  });
});
