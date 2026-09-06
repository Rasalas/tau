/**
 * Agents Kit: what its host half, its desktop half and its tools agree on.
 * A sub-agent is an ordinary Tau thread in the same project (ADR 0012), so
 * everything here describes a link between two threads, never a nested run.
 */

export const AGENTS_HOST_EXTENSION_ID = "tau.agents";

/** Pushed whenever a link appears, changes status or goes away. */
export const AGENTS_STATE_EVENT = "state";

/** Custom entry the child's session carries: who spawned it. */
export const AGENT_PARENT_ENTRY = "tau.agents/parent";

/** Custom entry the parent's session carries: one thread it spawned. */
export const AGENT_CHILD_ENTRY = "tau.agents/child";

export type AgentThreadStatus = "running" | "waiting" | "idle" | "completed" | "failed";

/** One thread an agent spawned, as the tools and the navigator see it. */
export interface AgentThreadLink {
  threadId: string;
  parentThreadId: string;
  /** The tool that created it. */
  spawnedBy: string;
  spawnedAt: number;
  projectPath: string;
  /** 1 for a thread a user's thread spawned, 2 for its child. */
  depth: number;
  title?: string;
  status: AgentThreadStatus;
}

export interface AgentsState {
  links: AgentThreadLink[];
}

/** Live children one thread may have at a time. */
export const MAX_CHILDREN_PER_PARENT = 8;

/** A user's thread spawns depth 1, that thread spawns depth 2, and there it stops. */
export const MAX_AGENT_DEPTH = 2;

export const DEFAULT_WAIT_MS = 10 * 60_000;
export const MAX_WAIT_MS = 30 * 60_000;

export function isAgentsState(value: unknown): value is AgentsState {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as AgentsState).links);
}
