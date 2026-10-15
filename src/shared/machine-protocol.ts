import type { PairingEndpoint } from "./connections.js";
import type { ManagedRoute } from "./managed-connections.js";
import type { EnvironmentAgentsOutcome, EnvironmentStatus } from "./environments.js";
import type { HostUpdateStatus } from "./host-updates.js";

/** How one side of this machine reaches a machine: its window, or its agents. */
export interface MachineLinkState {
  status: EnvironmentStatus;
  detail?: string;
  roundTripMs?: number;
  address?: string;
  readOnly?: boolean;
  hostVersion?: string;
  /** The machine's own Tau update, where its host reports one (K103). */
  update?: HostUpdateStatus;
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
  /** False when no Tau window runs on this machine: only the agents' machines are known then. */
  window: boolean;
  machines: MachineOverviewEntry[];
}

export type MachinePairResult =
  | { state: "added"; machine: { id: string; name: string }; window: boolean; agents?: EnvironmentAgentsOutcome }
  | { state: "known"; machine: { id: string; name: string } }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

/** A machine the user paired this window with; `token` is decrypted in memory only. */
export interface SavedEnvironment {
  managed?: ManagedRoute;
  id: string;
  name: string;
  endpoints: PairingEndpoint[];
  /** SHA-256 of its listeners' public key: the pin. A renewed certificate keeps it. */
  publicKey?: string;
  /** SHA-256 of one certificate: the pin of a machine added before key pins, until its next hello. */
  fingerprint?: string;
  token: string;
  addedAt: string;
  /** The address that worked last; tried first. */
  lastUrl?: string;
  readOnly?: boolean;
}

export type HostMachineStatus = "connecting" | "connected" | "offline" | "refused";

/** Another machine this host holds a key for, for its agents. Never the key. */
export interface HostMachine {
  /** That machine's host id. */
  id: string;
  name: string;
  status: HostMachineStatus;
  /** Why it is offline or refused, written for the user. */
  detail?: string;
  roundTripMs?: number;
  lastSeenAt?: number;
  /** The socket URL in use, or the one last used. */
  address?: string;
  hostVersion?: string;
  /** Pinned public host key or certificate fingerprint. Never a device token. */
  trustIdentity?: string;
  /** Its owner let this machine's agents in Read only. */
  readOnly?: boolean;
}
