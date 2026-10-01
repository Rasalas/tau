import type { HostExtension, HostMachineServices, HostReadiness, HostResources } from "tau/host-extension";
import { readWeights } from "./choice.js";
import { createMachineChooser } from "./chooser.js";
import { createMachineBackendProvider } from "./machine-backend.js";
import { machineMethodError } from "./compatibility.js";
import {
  AGENTS_EVENT,
  AGENTS_KIT_ID,
  CHOOSE_MACHINE_COMMAND,
  ENVIRONMENTS_EXTENSION_ID,
  WEIGHTS_SETTING,
  type AgentMachine,
  type AgentMachines,
  type ChooseMachineInput,
  type MachineIdentity,
  type MachineProbe,
} from "./protocol.js";

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

/** The first reading watches the counters for 5 s; the rest is room for the round trip. */
const REPORT_TIMEOUT_MS = 20_000;

function machineOf(input: unknown, command: string): string {
  const machine = (input as { machine?: unknown } | undefined)?.machine;
  if (typeof machine !== "string" || !machine) throw new Error(`${command}: name a machine.`);
  return machine;
}

function chooseInput(input: unknown): ChooseMachineInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" && raw[key] ? { [key]: raw[key] as string } : {});
  return {
    purpose: raw.purpose === "thread" ? "thread" : "sub-agent",
    ...text("cwd"),
    ...text("backend"),
    ...text("model"),
    ...(Array.isArray(raw.machines) ? { machines: raw.machines.filter((id): id is string => typeof id === "string") } : {}),
  };
}

/**
 * Machines Kit's host half (ADR 0027): which machines this host's agents
 * reach and how each connection is doing, for Settings → Machines, and a
 * round trip to the same kit on one of them, which answers with the device
 * its key stands for there. `resources` and `readiness` ask a machine (this
 * one by its own id) how busy it is and what it could run, only when called.
 * `choose-machine` picks where new work goes by those and Settings → Machines' weights.
 */
export function createEnvironmentsHostExtension(): HostExtension {
  return {
    id: ENVIRONMENTS_EXTENSION_ID,
    name: "Machines",
    permissions: ["machines", "runtime:extend", "sessions"],
    isolation: "in-process",
    activate(context) {
      const machines = context.services.machines;
      const stopBackend = machines?.index && machines.followThread ? context.services.registerRuntimeBackend(createMachineBackendProvider(machines)) : undefined;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      const stopIndex = stopBackend ? machines?.subscribeIndex?.(() => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void context.services.sessions.refreshIndex().catch((error: unknown) => context.services.log("machines.index-refresh-failed", error instanceof Error ? error.message : String(error)));
        }, 1000);
        refreshTimer.unref?.();
      }) : undefined;
      context.registerCommand("agents", () => view(machines), { access: "read" });
      context.registerCommand("start-there", async (input) => {
        const machine = machineOf(input, "start-there");
        if (!machines) throw new Error("This host keeps no machines for its agents.");
        const raw = (input ?? {}) as Record<string, unknown>;
        if (typeof raw.workspaceId !== "string" || !raw.workspaceId) throw new Error("start-there: name a workspace.");
        if (typeof raw.prompt !== "string") throw new Error("start-there: provide a prompt.");
        try { return await machines.request(machine, "start-thread", [{
          cwd: raw.workspaceId, prompt: raw.prompt,
          ...(typeof raw.backend === "string" ? { backend: raw.backend } : {}),
          ...(raw.model ? { model: raw.model } : {}),
          ...(typeof raw.thinkingLevel === "string" ? { thinkingLevel: raw.thinkingLevel } : {}),
          ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
        }]); } catch (error) {
          throw machineMethodError(error, machines.list().find((entry) => entry.id === machine)?.name ?? machine, "start threads");
        }
      }, { audit: { label: "started a thread on another machine" } });
      context.registerCommand("whoami", (_input, call): MachineIdentity => ({ device: call.device ?? null, owner: call.owner }), { access: "read" });
      context.registerCommand("probe", async (input): Promise<MachineProbe> => {
        const machine = machineOf(input, "probe");
        if (!machines) throw new Error("This host keeps no machines for its agents.");
        const started = Date.now();
        const identity = await machines.call(machine, ENVIRONMENTS_EXTENSION_ID, "whoami") as MachineIdentity;
        return { ...identity, ms: Date.now() - started };
      }, { audit: { label: "reached another machine as its agents" } });
      const ask = <T,>(command: string, method: string) => context.registerCommand(command, async (input): Promise<T> => {
        const machine = machineOf(input, command);
        if (!machines) throw new Error("This host keeps no machines for its agents.");
        return await machines.request(machine, method, [], { timeoutMs: REPORT_TIMEOUT_MS }) as T;
      }, { access: "read" });
      ask<HostResources>("resources", "host-resources");
      ask<HostReadiness>("readiness", "readiness");
      const choose = createMachineChooser({
        machines: () => machines,
        weights: async () => readWeights((await context.services.settings?.().catch(() => undefined))?.values[WEIGHTS_SETTING]),
      });
      context.registerCommand(CHOOSE_MACHINE_COMMAND, (input) => choose(chooseInput(input)), { access: "read", callers: [AGENTS_KIT_ID] });
      const stop = machines?.subscribe(() => context.emit(AGENTS_EVENT, view(machines)));
      return () => { stop?.(); stopIndex?.(); clearTimeout(refreshTimer); stopBackend?.(); };
    },
  };
}

export default createEnvironmentsHostExtension;
