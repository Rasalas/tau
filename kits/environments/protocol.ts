import type { ComponentType } from "react";
import type { WorkbenchActions } from "tau";

export const ENVIRONMENTS_EXTENSION_ID = "tau.environments";
export const MACHINES_SETTINGS_PAGE = "environments.machines";

/** Workspace Kit's desktop service (`kits/workspace/protocol.ts`); the rail draws what is registered here. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceRailSlice {
  /** Absent in a Workspace Kit before API 1.13.0; the rail then lists this machine's threads only. */
  registerRailSection?(section: ComponentType<{ actions: WorkbenchActions }>): () => void;
}

/** The host half's event: the machines this host's agents reach changed (ADR 0027). */
export const AGENTS_EVENT = "agents";

/** One machine this host holds the agents' key for, as the host half reports it (`HostMachine`). */
export interface AgentMachine {
  id: string;
  name: string;
  status: "connecting" | "connected" | "offline" | "refused";
  detail?: string;
  roundTripMs?: number;
  readOnly?: boolean;
}

/** `available` is false on a host that keeps no machines (one in the window's process, or before API 1.15.0). */
export interface AgentMachines {
  available: boolean;
  machines: AgentMachine[];
}

/** What `whoami` answers another machine's host: the device its key stands for there. */
export interface MachineIdentity {
  device: string | null;
  owner: boolean;
}

/** What `probe` answers: that machine's `whoami`, and how long the round trip took. */
export interface MachineProbe extends MachineIdentity {
  ms: number;
}

/**
 * Agents Kit's sub-agents on other machines (`kits/agents/protocol.ts`): the
 * rail leaves those threads out, since the Agents panel shows them here.
 */
export const REMOTE_AGENT_THREADS_SERVICE = "tau.agents/remote-threads";
export interface RemoteAgentThreadsService {
  /** Thread ids on that machine (its host id). */
  threadsOn(machine: string): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}
