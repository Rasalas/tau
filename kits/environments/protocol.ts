import type { ComponentType, ReactElement, ReactNode } from "react";
import type { HostSnapshot, UiSession, WorkbenchActions } from "tau";
import type { MachineRailThread } from "./rail.js";

export const ENVIRONMENTS_EXTENSION_ID = "tau.environments";
export const MACHINES_SETTINGS_PAGE = "environments.machines";

/** Onboarding Kit's desktop service (`kits/onboarding/protocol.ts`); its UI imports on the named machine. */
export const MACHINE_IMPORT_SERVICE = "tau.onboarding/machine-import";
export interface MachineImportProps { machine: string; name: string }
export interface MachineImportService { Component: (props: MachineImportProps) => ReactElement }

/** Workspace Kit's desktop service (`kits/workspace/protocol.ts`); the rail draws what is registered here. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceRailSlice {
  /** Absent in a Workspace Kit before API 1.13.0; the rail then lists this machine's threads only. */
  registerRailSection?(section: ComponentType<{ actions: WorkbenchActions }>): () => void;
  /** Absent in an older Workspace Kit; the other machines' threads are then not listed. */
  registerRailThreads?(source: { subscribe(listener: () => void): () => void; threads(): readonly MachineRailThread[] }): () => void;
  /** Absent before API 1.23.0; the row's hover card then names no machine for this machine's threads. */
  registerThreadCardSection?(section: { place: "row"; order?: number; Component: ComponentType<MachineCardRowProps> }): () => void;
  /** A new thread's Run-on pill: its machine and the machines to pick from. */
  registerDraftMachine?(source: DraftMachineSource): () => void;
}

/** Workspace Kit's `DraftMachineSource` (`kits/workspace/protocol.ts`). */
export interface DraftMachineProps {
  snapshot?: HostSnapshot;
  actions?: WorkbenchActions;
}
export interface DraftMachineSource {
  useMachine(props: DraftMachineProps): { name: string; icon: ReactNode; tooltip?: string; moving?: boolean } | undefined;
  Section: ComponentType<DraftMachineProps & { touch: boolean }>;
  openOnDraft?(): boolean;
}

/** `values.tau.environments.run-on`: where a new thread starts (design 2i); unset is the machine used last. */
export const RUN_ON_DEFAULT_KEY = "run-on";
export type RunOnDefault = "this" | "last" | "ask";

/** The part of Workspace Kit's `ThreadCardSectionProps` the machine's line reads. */
export interface MachineCardRowProps {
  /** The row's index entry, as Workspace Kit supplies it. New in API 1.43.0. */
  session?: UiSession;
  external: boolean;
  Row: ComponentType<{ icon: ReactNode; children: ReactNode }>;
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

/**
 * Where new work goes when the user left it to Tau (plan H §7): Agents Kit
 * asks for a sub-agent (`machine: "auto"`), the "Run on" chip for a new
 * thread. The contract's other copy is in `kits/agents/protocol.ts`.
 */
export const CHOOSE_MACHINE_COMMAND = "choose-machine";
export const AGENTS_KIT_ID = "tau.agents";

/** `values.tau.environments.weights`: a JSON object of host id to a weight from 0 to 100. */
export const WEIGHTS_SETTING = "weights";

export interface ChooseMachineInput {
  purpose: "sub-agent" | "thread";
  cwd?: string;
  /** Runtime backend kind; Pi when absent. */
  backend?: string;
  /** `provider/id`. */
  model?: string;
  /** Host ids the caller could use besides this computer; every machine the agents reach when absent. */
  machines?: string[];
}

export interface ChooseMachineVerdict {
  id: string;
  name: string;
  local?: boolean;
  score?: number;
  facts?: string;
  excluded?: string;
}

export interface ChooseMachineAnswer {
  /** A host id; null for this computer. */
  machine: string | null;
  /** One line on why, for a tooltip. */
  reason: string;
  machines: ChooseMachineVerdict[];
}
