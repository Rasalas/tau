/**
 * Agents Kit: what its host half, its desktop half and its tools agree on.
 * A sub-agent is an ordinary Tau thread in the same project (ADR 0013), so
 * everything here describes a link between two threads, never a nested run.
 */

export const AGENTS_HOST_EXTENSION_ID = "tau.agents";

/** The tool that starts agents, as Pi names it. */
export const SPAWN_TOOL = "tau_spawn_thread";

/** How a runtime other than Pi names Tau's tools: the MCP server's name in front (ADR 0022). */
const MCP_TAU_PREFIX = "mcp__tau__";

/** A tool's name as Pi spells it, whichever runtime reported the call. */
export function tauToolName(name: string): string {
  return name.startsWith(MCP_TAU_PREFIX) ? name.slice(MCP_TAU_PREFIX.length) : name;
}

/** Pushed whenever an agent appears, changes status or goes away. */
export const AGENTS_STATE_EVENT = "state";

/**
 * Thread Rail's threads started together from one prompt. The panel shows a
 * thread's siblings the way it shows its agents; without Thread Rail there are none.
 */
export const THREAD_SIBLINGS_SERVICE = "tau.thread-rail/siblings";

export interface ThreadSiblingsService {
  /** The whole group, the thread itself included, or `[]`. */
  siblingsOf(threadId: string): readonly string[];
  subscribe(listener: () => void): () => void;
}

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
  /** The machines this host's agents may run on, for Settings → Agents. */
  "machines": { input: undefined; output: AgentMachinesView };
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
  /** Where its thread runs: a machine's name or id, `local` or `auto`. */
  machine?: string;
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

/**
 * `pending` is queued behind the parent's running budget; it has no thread yet.
 * `cancelled` was stopped by its parent (`tau_cancel_thread`) until it is sent work again.
 */
export type AgentThreadStatus = "pending" | "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled";

/**
 * How `tau_send_to_thread` delivers: `auto` starts an idle thread, steers a
 * running one and queues when it cannot steer; `queue` waits for the running
 * turn; `steer` joins it now; `restart` stops it and starts over with this.
 */
export type AgentSendMode = "auto" | "queue" | "steer" | "restart";

export const AGENT_SEND_MODES: readonly AgentSendMode[] = ["auto", "queue", "steer", "restart"];

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

/**
 * A child that runs on another machine (ADR 0027): an ordinary thread there,
 * started and followed through Remote Work's `tau.remote-work/threads`.
 */
export interface AgentMachineRef {
  /** That machine's host id. */
  id: string;
  name: string;
  /** Remote Work's link for it; absent while the child is queued. */
  link?: string;
  /** The thread's id on that machine, once it exists. */
  thread?: string;
  /** The machine is unreachable now; the thread may still run there. */
  offline?: boolean;
  /** Money its thread spent there, as that machine last reported. */
  costUsd?: number;
  /** Why it runs there, when Tau chose the machine. */
  reason?: string;
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
  /** Set for an agent that runs on another machine; it then has no `threadId` here. */
  machine?: AgentMachineRef;
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

/** Neither finished, failed nor cancelled: the panel counts these as work in flight. */
export function isOpenStatus(status: AgentThreadStatus): boolean {
  return status !== "completed" && status !== "failed" && status !== "cancelled";
}

export function isAgentsState(value: unknown): value is AgentsState {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as AgentsState).links);
}

// ---------------------------------------------------------------------------
// Sub-agents on other machines (ADR 0027)

/** `machine` values that mean this computer. */
export const LOCAL_MACHINE = "local";
const LOCAL_ALIASES = new Set([LOCAL_MACHINE, "this", "here", "this computer", "this-computer"]);
export const isLocalMachine = (value: string): boolean => LOCAL_ALIASES.has(value.trim().toLowerCase());

/** Tau picks the machine when the agent starts (Machines Kit's `choose-machine`). */
export const AUTO_MACHINE = "auto";

/** `values.tau.agents.machine`: where a spawn that names no machine runs; this computer when unset. */
export const MACHINE_SETTING = "machine";

/**
 * Machines Kit answers where an automatic agent goes. The command names
 * `tau.agents` as its caller; without it, "auto" runs on this computer.
 */
export const MACHINES_KIT_ID = "tau.environments";
export const CHOOSE_MACHINE_COMMAND = "choose-machine";

export interface ChooseMachineInput {
  purpose: "sub-agent";
  /** The project the agent works in, here. */
  cwd: string;
  /** Runtime backend; Pi when absent. */
  backend?: string;
  /** `provider/model-id`. */
  model?: string;
}

export interface ChooseMachineAnswer {
  /** A host id from `services.machines`; absent or null for this computer. */
  machine?: string | null;
  /** One line on why, for the panel's tooltip and the tool's answer. */
  reason: string;
}

/** A machine as Settings → Agents lists it. */
export interface AgentMachineOption {
  id: string;
  name: string;
  status: "connecting" | "connected" | "offline" | "refused";
  readOnly?: boolean;
  /** Agents that may run there at once; known once one started there. */
  budget?: number;
}

export interface AgentMachinesView {
  /** False on a host that keeps no other machines for its agents. */
  available: boolean;
  machines: AgentMachineOption[];
}

export function isAgentMachinesView(value: unknown): value is AgentMachinesView {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as AgentMachinesView).machines);
}

/**
 * The threads other machines run as this host's sub-agents, by machine: the
 * Machines rail leaves them out, since the Agents panel shows them here.
 */
export const REMOTE_AGENT_THREADS_SERVICE = "tau.agents/remote-threads";

export interface RemoteAgentThreadsService {
  /** Thread ids on that machine (its host id). */
  threadsOn(machine: string): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}
