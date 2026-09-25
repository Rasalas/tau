import type { HostExtension, HostMachineServices } from "tau/host-extension";
import { AGENTS_EVENT, ENVIRONMENTS_EXTENSION_ID, type AgentMachine, type AgentMachines, type MachineIdentity, type MachineProbe } from "./protocol.js";

function view(machines: HostMachineServices | undefined): AgentMachines {
  if (!machines) return { available: false, machines: [] };
  return {
    available: true,
    machines: machines.list().map((machine): AgentMachine => ({
      id: machine.id,
      name: machine.name,
      status: machine.status,
      ...(machine.detail ? { detail: machine.detail } : {}),
      ...(machine.roundTripMs !== undefined ? { roundTripMs: machine.roundTripMs } : {}),
      ...(machine.readOnly ? { readOnly: true } : {}),
    })),
  };
}

/**
 * Machines Kit's host half (ADR 0027): which machines this host's agents
 * reach and how each connection is doing, for Settings → Machines, and a
 * round trip to the same kit on one of them, which answers with the device
 * its key stands for there.
 */
export function createEnvironmentsHostExtension(): HostExtension {
  return {
    id: ENVIRONMENTS_EXTENSION_ID,
    name: "Machines",
    permissions: ["machines"],
    isolation: "in-process",
    activate(context) {
      const machines = context.services.machines;
      context.registerCommand("agents", () => view(machines), { access: "read" });
      context.registerCommand("whoami", (_input, call): MachineIdentity => ({ device: call.device ?? null, owner: call.owner }), { access: "read" });
      context.registerCommand("probe", async (input): Promise<MachineProbe> => {
        const machine = (input as { machine?: unknown } | undefined)?.machine;
        if (typeof machine !== "string" || !machine) throw new Error("probe: name a machine.");
        if (!machines) throw new Error("This host keeps no machines for its agents.");
        const started = Date.now();
        const identity = await machines.call(machine, ENVIRONMENTS_EXTENSION_ID, "whoami") as MachineIdentity;
        return { ...identity, ms: Date.now() - started };
      }, { audit: { label: "reached another machine as its agents" } });
      const stop = machines?.subscribe(() => context.emit(AGENTS_EVENT, view(machines)));
      return () => stop?.();
    },
  };
}

export default createEnvironmentsHostExtension;
