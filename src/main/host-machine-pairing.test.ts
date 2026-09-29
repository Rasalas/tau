import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { SavedEnvironment } from "./environment-catalog.js";
import type { EnvironmentMonitor, EnvironmentMonitorOptions } from "./environment-monitor.js";
import type { PairEnvironmentOptions, PairEnvironmentResult } from "./environment-pairing.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import type { HostLogger } from "./host-log.js";
import { createMachinePairingMethods, localWindowPort, type MachineWindowPort, type WindowMachine } from "./host-machine-pairing.js";
import { HostMachines } from "./host-machines.js";
import { invokeHostMethod, type HostMethodTable } from "./host-methods.js";

const directories: string[] = [];
const opened: HostMachines[] = [];
afterEach(() => {
  for (const machines of opened.splice(0)) machines.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const logger: HostLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const owner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c1", local: true };
const paired: HostInvocationPrincipal = { kind: "workbench-client", connection: "c2", pairedClient: "p" };
const LINK = "https://192.0.2.10:7788/#pair=secret-code&pk=aa&host=rex-id";

/** A host's machines with connections that report connected at once and never dial. */
async function openMachines(): Promise<HostMachines> {
  const directory = mkdtempSync(join(tmpdir(), "tau-machine-pairing-"));
  directories.push(directory);
  const monitor = (options: EnvironmentMonitorOptions) => {
    queueMicrotask(() => options.onChange({ status: "connected", running: new Set(), roundTripMs: 5 }));
    return { close: () => undefined, resubscribe: () => undefined, retryNow: () => undefined, call: async () => undefined } as unknown as EnvironmentMonitor;
  };
  const machines = await HostMachines.open({ path: join(directory, "host-machines.json"), logger, ownId: "mini-id", ownName: "mini", monitor });
  opened.push(machines);
  return machines;
}

const rex = (token: string): SavedEnvironment => ({ id: "rex-id", name: "rex", endpoints: [{ url: "https://192.0.2.10:7788/", kind: "lan" }], publicKey: "AA", token, addedAt: "2026-09-27T00:00:00.000Z" });

/** Core's window half, scripted: what it keeps, and what `pair-environment` answers. */
function fakeWindow(kept: WindowMachine[] = [], answer?: (input: Record<string, unknown>) => unknown): MachineWindowPort & { calls: Array<{ command: string; input: unknown }> } {
  const calls: Array<{ command: string; input: unknown }> = [];
  return {
    calls,
    available: () => true,
    call: async (command, input) => {
      calls.push({ command, input });
      if (command === "environments") return kept;
      if (command === "pair-environment") return (await answer?.(input as Record<string, unknown>)) ?? { state: "added", environment: { id: "rex-id", name: "rex" }, agents: { added: true } };
      if (command === "remove-environment") return { removed: true };
      throw new Error(command);
    },
  };
}

function table(deps: Parameters<typeof createMachinePairingMethods>[0]): HostMethodTable {
  return createMachinePairingMethods(deps) as HostMethodTable;
}

describe("machines-overview", () => {
  it("lists the window's machines and the agents' in one entry per machine, only for the owner", async () => {
    const machines = await openMachines();
    await machines.add(rex("agents-token"));
    await vi.waitFor(() => expect(machines.list()[0]?.status).toBe("connected"));
    const window = fakeWindow([{ id: "rex-id", name: "rex", status: "offline", detail: "no route" }, { id: "studio-id", name: "studio", status: "connected", roundTripMs: 9 }]);
    const methods = table({ machines: () => machines, window: () => window });
    const listed = await invokeHostMethod(methods, "machines-overview", [], owner);
    expect(listed).toEqual({
      window: true,
      machines: [
        { id: "rex-id", name: "rex", window: { status: "offline", detail: "no route" }, agents: { status: "connected", roundTripMs: 5 } },
        { id: "studio-id", name: "studio", window: { status: "connected", roundTripMs: 9 } },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("agents-token");
    await expect(invokeHostMethod(methods, "machines-overview", [], paired)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
  });

  it("says when no window runs, and never asks one that is not there", async () => {
    const window = { ...fakeWindow(), available: () => false };
    expect(await invokeHostMethod(table({ machines: () => undefined, window: () => window }), "machines-overview", [], owner)).toEqual({ window: false, machines: [] });
    expect(window.calls).toEqual([]);
    // A window that keeps no machines (attached to this host by address) counts as none.
    const attached = { available: () => true, call: async () => null };
    expect(await invokeHostMethod(table({ machines: () => undefined, window: () => attached }), "machines-overview", [], owner)).toEqual({ window: false, machines: [] });
  });
});

describe("machines-pair", () => {
  it("lets the window pair for itself and the agents, and names the agents' key as asked", async () => {
    const machines = await openMachines();
    const window = fakeWindow([], async () => {
      // The window hands the agents' key over itself, under the machine's own name.
      await machines.add(rex("agents-token"));
      return { state: "added", environment: { id: "rex-id", name: "Rex" }, agents: { added: true } };
    });
    const methods = table({ machines: () => machines, window: () => window });
    const result = await invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: true, id: "rex-id", name: "Rex" }], owner);
    expect(result).toEqual({ state: "added", machine: { id: "rex-id", name: "Rex" }, window: true, agents: { added: true } });
    expect(window.calls.find((call) => call.command === "pair-environment")?.input).toEqual({ text: LINK, agents: true, name: "Rex" });
    expect(machines.list()[0]?.name).toBe("Rex");
  });

  it("pairs the agents alone on this host when no window runs, as “<name> · Agents”", async () => {
    const machines = await openMachines();
    const pair = vi.fn(async (options: PairEnvironmentOptions): Promise<PairEnvironmentResult> => {
      expect(options).toEqual({ text: LINK, deviceName: "mini · Agents" });
      return { state: "approved", environment: rex("agents-token") };
    });
    const methods = table({ machines: () => machines, window: () => undefined, pair });
    expect(await invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: true, id: "rex-id" }], owner))
      .toEqual({ state: "added", machine: { id: "rex-id", name: "rex" }, window: false, agents: { added: true } });
    expect(machines.list().map((machine) => machine.id)).toEqual(["rex-id"]);

    // Again: the machine is kept, nothing is asked.
    expect(await invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: true, id: "rex-id" }], owner)).toEqual({ state: "known", machine: { id: "rex-id", name: "rex" } });
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("asks for the agents alone when the window keeps the machine already", async () => {
    const machines = await openMachines();
    const window = fakeWindow([{ id: "rex-id", name: "rex", status: "connected" }]);
    const pair = vi.fn(async (): Promise<PairEnvironmentResult> => ({ state: "approved", environment: rex("agents-token") }));
    const result = await invokeHostMethod(table({ machines: () => machines, window: () => window, pair }), "machines-pair", [{ link: LINK, agents: true, id: "rex-id" }], owner);
    expect(result).toMatchObject({ state: "added", window: false });
    expect(window.calls.map((call) => call.command)).toEqual(["environments"]);
  });

  it("refuses a machine that answers as another one, pairing nothing, or no link", async () => {
    const machines = await openMachines();
    const pair = async (): Promise<PairEnvironmentResult> => ({ state: "approved", environment: { ...rex("t"), id: "impostor-id" } });
    const methods = table({ machines: () => machines, window: () => undefined, pair });
    expect(await invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: true, id: "rex-id" }], owner)).toMatchObject({ state: "failed", message: expect.stringMatching(/another machine/u) });
    expect(machines.list()).toEqual([]);
    expect(await invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: false }], owner)).toMatchObject({ state: "failed", message: expect.stringMatching(/No Tau window runs/u) });
    await expect(invokeHostMethod(methods, "machines-pair", [{ link: "https://example.com/", agents: true }], owner)).rejects.toThrow(/pairing link/u);
    await expect(invokeHostMethod(methods, "machines-pair", [{ link: LINK, agents: true }], paired)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
  });

  it("passes the window's refusal on", async () => {
    const window = fakeWindow([], () => ({ state: "denied" }));
    expect(await invokeHostMethod(table({ machines: () => undefined, window: () => window }), "machines-pair", [{ link: LINK }], owner)).toEqual({ state: "denied" });
  });
});

describe("machines-forget", () => {
  it("forgets a machine by name in the window and the agents' list", async () => {
    const machines = await openMachines();
    await machines.add(rex("agents-token"));
    const window = fakeWindow([{ id: "rex-id", name: "rex", status: "connected" }]);
    const methods = table({ machines: () => machines, window: () => window });
    expect(await invokeHostMethod(methods, "machines-forget", ["REX"], owner)).toEqual({ id: "rex-id", name: "rex", window: true, agents: true });
    expect(window.calls.at(-1)).toEqual({ command: "remove-environment", input: { id: "rex-id" } });
    expect(machines.list()).toEqual([]);
    await expect(invokeHostMethod(methods, "machines-forget", ["studio"], owner)).rejects.toThrow(/knows no machine called studio/u);
  });
});

describe("localWindowPort", () => {
  it("asks core's window half on this machine only, and not at all without the client calls", async () => {
    const call = vi.fn(async () => []);
    const port = localWindowPort({ call, hasLocalWindow: (id) => id === "window" });
    expect(port?.available()).toBe(true);
    await port?.call("environments", undefined, 1_000);
    expect(call).toHaveBeenCalledWith("window", "environments", undefined, { window: "host", timeoutMs: 1_000 });
    expect(localWindowPort(undefined)).toBeUndefined();
  });
});

describe("machines-update (K103)", () => {
  const status = { version: "0.7.6", phase: "installing", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", devicesMayInstall: true };

  it("updates a machine through the window's connection there, for the owner only", async () => {
    const window = fakeWindow([{ id: "rex-id", name: "rex", status: "connected", hostVersion: "0.7.6" }]);
    const call = window.call;
    window.call = async (command, input, timeoutMs) => command === "update-environment" ? (window.calls.push({ command, input }), status) : call(command, input, timeoutMs);
    const methods = table({ machines: () => undefined, window: () => window });
    await expect(invokeHostMethod(methods, "machines-update", ["rex"], paired)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    const result = await invokeHostMethod(methods, "machines-update", ["rex"], owner);
    expect(result).toMatchObject({ id: "rex-id", name: "rex", update: { phase: "installing", latest: "0.7.14" } });
    expect(window.calls.at(-1)).toEqual({ command: "update-environment", input: { id: "rex-id", action: "install" } });
    await expect(invokeHostMethod(methods, "machines-update", ["rex", "remove"], owner)).rejects.toMatchObject({ code: HOST_ERROR.invalidRequest });
  });

  it("needs a window that keeps the machine", async () => {
    const machines = await openMachines();
    await machines.add(rex("agents-token"));
    const methods = table({ machines: () => machines, window: () => undefined });
    await expect(invokeHostMethod(methods, "machines-update", ["rex", "status"], owner)).rejects.toThrow(/Tau window on this computer/u);
  });
});
