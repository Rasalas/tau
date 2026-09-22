/**
 * Agents Kit: what its host half, its desktop half and its tools agree on.
 * A sub-agent is an ordinary Tau thread in the same project (ADR 0013), so
 * everything here describes a link between two threads, never a nested run.
 */

export const AGENTS_HOST_EXTENSION_ID = "tau.agents";

/** Pushed whenever an agent appears, changes status or goes away. */
export const AGENTS_STATE_EVENT = "state";

/** Commands the panel's two row actions send to the host half. */
export interface AgentsHostCommands {
  "state": { input: undefined; output: AgentsState };
  /** Takes a child's work into the parent's checkout and removes the child's worktree. */
  "apply-changes": { input: { threadId: string }; output: { detail: string } };
  /** Throws the child's worktree away, work and branch included. */
  "discard-changes": { input: { threadId: string }; output: { detail: string } };
  /** The agent definitions of a thread's checkout, or of the open workspace without one. */
  "definitions": { input: { sessionId?: string }; output: AgentDefinitionsState };
  /** The user starts an agent from a definition, as a child of the thread they are reading. */
  "start": { input: { parentThreadId: string; agent: string; prompt: string }; output: { threadId: string; title: string; status: AgentThreadStatus } };
}

/** An agent definition's `access`: what Access Kit may narrow its thread to. */
export type AgentAccessLevel = "read-only" | "ask" | "full";

/** One `.tau/agents/<name>.md`, without its system prompt. */
export interface AgentDefinitionSummary {
  name: string;
  description: string;
  /** Absolute path of the file it was read from. */
  file: string;
  /** `provider/model-id`. */
  model?: string;
  /** Runtime backend kind; the kit starts Pi threads when it is absent. */
  runtime?: string;
  /** The only tools its thread keeps; Pi only. */
  tools?: string[];
  access?: AgentAccessLevel;
  workspace?: AgentWorkspaceMode;
}

/** A file that could not be used, or a field that was ignored; Settings → Inspector lists them. */
export interface AgentDefinitionProblem {
  file: string;
  message: string;
  level: "error" | "warning";
}

export interface AgentDefinitionsState {
  /** The `.tau/agents` folder these came from. */
  directory: string;
  definitions: AgentDefinitionSummary[];
  problems: AgentDefinitionProblem[];
}

export function isAgentDefinitionsState(value: unknown): value is AgentDefinitionsState {
  return Boolean(value) && typeof value === "object"
    && Array.isArray((value as AgentDefinitionsState).definitions)
    && Array.isArray((value as AgentDefinitionsState).problems);
}

/**
 * Custom entry the parent's session carries: one thread it spawned. The child's
 * half of the link is core's: `sessions.start({ parent })` writes it and the
 * thread index reads it, so it arrives as `PARENT_LINK_ENTRY` from
 * `tau/host-extension`.
 */
export const AGENT_CHILD_ENTRY = "tau.agents/child";

/**
 * The key under which a child's own link entry carries the definition it was
 * started from: name, file, system prompt, tools and access. The kit's Pi
 * extension reads it back on every turn, so the persona outlives a restart.
 */
export const AGENT_PERSONA_FIELD = "persona";

/** `pending` is queued behind the parent's running budget; it has no thread yet. */
export type AgentThreadStatus = "pending" | "running" | "waiting" | "idle" | "completed" | "failed";

/**
 * Where a spawned thread works: in the parent's own checkout, or in a worktree
 * of its own that starts from the parent's current state.
 */
export type AgentWorkspaceMode = "shared" | "worktree";

/** A child's checkout and what it changed there, once it has one. */
export interface AgentWorkspace {
  mode: AgentWorkspaceMode;
  path: string;
  branch?: string;
  /** Reread when the child settles, and after the parent applied its work. */
  changes?: { files: number; added: number; removed: number; commits: number; uncommitted: number };
  /** Set once the parent applied or discarded the work; the worktree is gone then. */
  settled?: "applied" | "discarded";
}

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
  /** The agent definition it was started from, by name. */
  agent?: string;
  /** Model as `provider/id`, when it differs from the host default. */
  model?: string;
  /** The checkout this agent works in; absent while it shares the parent's. */
  workspace?: AgentWorkspace;
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
