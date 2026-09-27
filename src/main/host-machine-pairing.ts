import { parsePairingPayload } from "../shared/connections.js";
import { agentsDeviceName, type EnvironmentAgentsOutcome, type EnvironmentStatus } from "../shared/environments.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { pairEnvironment, type PairEnvironmentOptions, type PairEnvironmentResult } from "./environment-pairing.js";
import type { HostMachines } from "./host-machines.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import { ownerRefusal } from "./host-method-access.js";
import { decodeString } from "./ipc-input.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";
import type { ClientCalls } from "./client-calls.js";

/** How one side of this computer reaches a machine: its window, or its agents. */
export interface MachineLinkState {
  status: EnvironmentStatus;
  detail?: string;
  roundTripMs?: number;
  address?: string;
  readOnly?: boolean;
  hostVersion?: string;
}

/** What core's window half answers `environments` with: the window's machines, no keys, no threads. */
export interface WindowMachine extends MachineLinkState {
  id: string;
  name: string;
}

export interface MachineOverviewEntry {
  id: string;
  name: string;
  /** The window keeps it (Settings → Machines). */
  window?: MachineLinkState;
  /** This host keeps a key for its agents there. */
  agents?: MachineLinkState;
}

export interface MachinesOverview {
  /** False when no Tau window runs on this computer: only the agents' machines are known then. */
  window: boolean;
  machines: MachineOverviewEntry[];
}

export type MachinePairResult =
  | { state: "added"; machine: { id: string; name: string }; window: boolean; agents?: EnvironmentAgentsOutcome }
  | { state: "known"; machine: { id: string; name: string } }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

/** Core's window half on this computer (`WINDOW_SERVICES_ID`), when a Tau window runs here. */
export interface MachineWindowPort {
  available(): boolean;
  call(command: string, input: unknown, timeoutMs: number): Promise<unknown>;
}

export interface MachinePairingDeps {
  machines(): HostMachines | undefined;
  window(): MachineWindowPort | undefined;
  /** Test seam. */
  pair?(options: PairEnvironmentOptions): Promise<PairEnvironmentResult>;
}

/** Core's window half through the host's client calls: only a window on this computer, never one started for it. */
export function localWindowPort(calls: Partial<Pick<ClientCalls, "call" | "hasLocalWindow">> | undefined): MachineWindowPort | undefined {
  const { call, hasLocalWindow } = calls ?? {};
  if (!call || !hasLocalWindow) return undefined;
  return {
    available: () => hasLocalWindow.call(calls, WINDOW_SERVICES_ID),
    call: (command, input, timeoutMs) => call.call(calls, WINDOW_SERVICES_ID, command, input, { window: "host", timeoutMs }),
  };
}

/** A pairing request waits up to two minutes for the other owner; the window's answer comes after it. */
const PAIR_TIMEOUT_MS = 150_000;
const WINDOW_TIMEOUT_MS = 10_000;

const failure = (message: string, code: string = HOST_ERROR.invalidRequest): Error => Object.assign(new Error(message), { code });

function state(entry: MachineLinkState): MachineLinkState {
  return {
    status: entry.status,
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.roundTripMs !== undefined ? { roundTripMs: entry.roundTripMs } : {}),
    ...(entry.address ? { address: entry.address } : {}),
    ...(entry.readOnly ? { readOnly: true } : {}),
    ...(entry.hostVersion ? { hostVersion: entry.hostVersion } : {}),
  };
}

async function overview(deps: MachinePairingDeps): Promise<MachinesOverview> {
  const window = deps.window();
  // `null`: a window that keeps no machines, such as one attached to this host by address.
  const listed = window?.available() ? await window.call("environments", undefined, WINDOW_TIMEOUT_MS) as WindowMachine[] | null : null;
  const open = Array.isArray(listed);
  const byId = new Map<string, MachineOverviewEntry>();
  for (const machine of listed ?? []) byId.set(machine.id, { id: machine.id, name: machine.name, window: state(machine) });
  for (const machine of deps.machines()?.list() ?? []) {
    const known = byId.get(machine.id);
    byId.set(machine.id, { ...(known ?? { id: machine.id, name: machine.name }), agents: state(machine) });
  }
  return { window: open, machines: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function decodePairInput(value: unknown): { link: string; agents: boolean; name?: string; id?: string } {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw failure("machines-pair: expected an object.");
  const link = decodeString("machines-pair", "link", item.link);
  if (link.length > 8_192 || !parsePairingPayload(link)) throw failure("machines-pair: link must be a pairing link.");
  const text = (key: string): string | undefined => typeof item[key] === "string" && (item[key] as string).trim() ? (item[key] as string).trim().slice(0, 200) : undefined;
  const name = text("name");
  const id = text("id");
  return { link, agents: item.agents === true, ...(name ? { name } : {}), ...(id ? { id } : {}) };
}

function matching(list: MachinesOverview, machine: string): MachineOverviewEntry {
  const byId = list.machines.find((entry) => entry.id === machine);
  if (byId) return byId;
  const named = list.machines.filter((entry) => entry.name.toLowerCase() === machine.trim().toLowerCase());
  if (named.length === 1) return named[0]!;
  throw failure(named.length > 1 ? `Several machines are called ${machine}; name one by its id.` : `This computer knows no machine called ${machine}.`);
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/**
 * `tau machines add|list|remove` (the command line): one list of the machines
 * the window and this host's agents keep, and a pairing link from another
 * machine's owner turned into a saved machine. The window pairs when one runs
 * here, as Settings → Machines does; without one, this host pairs its agents alone.
 */
export function createMachinePairingMethods(deps: MachinePairingDeps): Record<string, Method> {
  const owned = (run: (params: readonly unknown[]) => Promise<unknown>): Method => async (params, context) => {
    if (!isHostOwner(context.principal)) throw ownerRefusal();
    return run(params);
  };
  return {
    "machines-overview": owned(() => overview(deps)),
    "machines-pair": owned(async (params): Promise<MachinePairResult> => {
      const input = decodePairInput(params[0]);
      const list = await overview(deps);
      const known = input.id ? list.machines.find((entry) => entry.id === input.id) : undefined;
      const window = list.window ? deps.window() : undefined;
      const needWindow = window !== undefined && !known?.window;
      const needAgents = input.agents && !known?.agents;
      if (!needWindow && !needAgents) {
        if (known) return { state: "known", machine: { id: known.id, name: known.name } };
        return { state: "failed", message: "No Tau window runs on this computer, so only its agents could keep the machine: start Tau, or ask for the agents." };
      }
      if (needWindow) {
        const result = await window.call("pair-environment", { text: input.link, agents: needAgents, ...(input.name ? { name: input.name } : {}) }, PAIR_TIMEOUT_MS) as
          { state: "added"; environment: { id: string; name: string }; agents?: EnvironmentAgentsOutcome } | Exclude<MachinePairResult, { state: "added" | "known" }>;
        if (result.state !== "added") return result;
        // The window hands the agents' key over under the machine's own name.
        if (input.name && result.agents?.added) await deps.machines()?.rename(result.environment.id, input.name);
        return { state: "added", machine: { id: result.environment.id, name: result.environment.name }, window: true, ...(result.agents ? { agents: result.agents } : {}) };
      }
      const machines = deps.machines();
      if (!machines) return { state: "failed", message: "This host keeps no machines for its agents." };
      const result = await (deps.pair ?? pairEnvironment)({ text: input.link, deviceName: agentsDeviceName(machines.self.name) });
      if (result.state !== "approved") return result;
      const { environment } = result;
      if (input.id && environment.id !== input.id) return { state: "failed", message: "The link's address answered as another machine than the one that made it." };
      const name = input.name ?? known?.name ?? environment.name;
      await machines.add({ ...environment, name });
      return { state: "added", machine: { id: environment.id, name }, window: false, agents: { added: true } };
    }),
    "machines-forget": owned(async (params) => {
      const list = await overview(deps);
      const entry = matching(list, decodeString("machines-forget", "machine", params[0]));
      // The window forgets the agents' key with its own.
      const window = entry.window ? await deps.window()?.call("remove-environment", { id: entry.id }, WINDOW_TIMEOUT_MS) as { removed?: boolean } | undefined : undefined;
      const agents = entry.agents ? await deps.machines()?.remove(entry.id) : undefined;
      return { id: entry.id, name: entry.name, window: window?.removed === true, agents: entry.agents !== undefined && (agents === true || window?.removed === true) };
    }),
  };
}
