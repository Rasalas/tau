/**
 * Agents Kit: what its host half, its desktop half and its tools agree on.
 * A sub-agent is an ordinary Tau thread in the same project (ADR 0012), so
 * everything here describes a link between two threads, never a nested run.
 */

export const AGENTS_HOST_EXTENSION_ID = "tau.agents";

/** Pushed whenever an agent appears, changes status or goes away. */
export const AGENTS_STATE_EVENT = "state";

/** Custom entry the child's session carries: who spawned it. */
export const AGENT_PARENT_ENTRY = "tau.agents/parent";

/** Custom entry the parent's session carries: one thread it spawned. */
export const AGENT_CHILD_ENTRY = "tau.agents/child";

/** `pending` is queued behind the parent's running budget; it has no thread yet. */
export type AgentThreadStatus = "pending" | "running" | "waiting" | "idle" | "completed" | "failed";

/** One agent a thread spawned, as the tools and the Agents panel see it. */
export interface AgentThreadLink {
  /** Stable handle the tools use, valid from the moment the agent is queued. */
  id: string;
  /** The Tau thread behind it, once a slot freed and it started. */
  threadId?: string;
  parentThreadId: string;
  /** The tool that created it. */
  spawnedBy: string;
  spawnedAt: number;
  startedAt?: number;
  endedAt?: number;
  projectPath: string;
  /** 1 for a thread a user's thread spawned, 2 for its child. */
  depth: number;
  title: string;
  /** Model as `provider/id`, when it differs from the host default. */
  model?: string;
  status: AgentThreadStatus;
  /** Last tool the agent ran, for the panel's progress line. */
  lastTool?: string;
  /** Question the agent is holding on; the user answers it in the agent's thread. */
  pendingToolPrompt?: string;
  /** First lines of the agent's answer, once it has one. */
  result?: string;
  error?: string;
}

export interface AgentsState {
  links: AgentThreadLink[];
  /** How many children of one thread may run at a time. */
  maxRunning: number;
}

/** How many children of one thread run at a time before the rest queue. */
export const DEFAULT_MAX_RUNNING_AGENTS = 8;

/** The most the user may raise that to; beyond this the host thrashes runtimes. */
export const MAX_RUNNING_AGENTS_CAP = 64;

/** A user's thread spawns depth 1, that thread spawns depth 2, and there it stops. */
export const MAX_AGENT_DEPTH = 2;

export const DEFAULT_WAIT_MS = 10 * 60_000;
export const MAX_WAIT_MS = 30 * 60_000;

/** A status that still needs the host: such an agent holds one of its parent's slots. */
export function isBusyStatus(status: AgentThreadStatus): boolean {
  return status === "running" || status === "waiting";
}

/** Neither finished nor failed: the panel counts these as work in flight. */
export function isOpenStatus(status: AgentThreadStatus): boolean {
  return status !== "completed" && status !== "failed";
}

export function isAgentsState(value: unknown): value is AgentsState {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as AgentsState).links);
}
