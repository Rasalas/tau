import {
  AGENT_SEND_MODES,
  DEFAULT_MAX_RUNNING_AGENTS,
  DEFAULT_WAIT_MS,
  MAX_AGENT_DEPTH,
  MAX_RUNNING_AGENTS_CAP,
  MAX_WAIT_MS,
  isBusyStatus,
  type AgentSendMode,
  type AgentThreadLink,
  type AgentWorkspace,
  type AgentWorkspaceMode,
  type AgentThreadStatus,
  type AgentsState,
} from "./protocol.js";

/** What Agents Kit reads from a tool call. The model may send anything. */
export interface SpawnRequest {
  prompt: string;
  title?: string;
  model?: string;
  projectPath?: string;
  /** Where the new thread works; the host decides when the caller says nothing. */
  workspace?: AgentWorkspaceMode;
  /** An agent definition of the project, by name. */
  agent?: string;
}

export interface ThreadLiveness {
  streaming: boolean;
  idle: boolean;
}

/** Everything one agent's status is derived from. */
export interface AgentThreadFacts {
  /** Queued behind the parent's running budget; it has no thread yet. */
  queued: boolean;
  /** Its first prompt is on its way but no turn has been accepted yet. */
  spawning: boolean;
  turns: number;
  lastOutcome?: "completed" | "failed";
  pendingToolPrompt?: string;
  error?: string;
  /** Its parent cancelled it; new work sent to it clears this. */
  cancelled?: boolean;
  /** Absent before the agent starts, and once the host released its runtime. */
  live?: ThreadLiveness;
}

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

function optionalText(value: unknown, field: string, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > limit) throw new Error(`${field} must be ${limit} characters or fewer.`);
  return text;
}

export function decodeSpawnRequest(input: unknown): SpawnRequest {
  const fields = record(input);
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) {
    throw new Error("prompt is required: say what the new thread should do.");
  }
  if (fields.prompt.length > 64_000) throw new Error("prompt must be 64000 characters or fewer.");
  const title = optionalText(fields.title, "title", 120);
  const model = optionalText(fields.model, "model", 200);
  const projectPath = optionalText(fields.projectPath, "projectPath", 4_096);
  const workspace = optionalText(fields.workspace, "workspace", 16);
  const agent = optionalText(fields.agent, "agent", 64);
  if (workspace && workspace !== "shared" && workspace !== "worktree") {
    throw new Error('workspace must be "worktree" or "shared".');
  }
  return {
    prompt: fields.prompt.trim(),
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(workspace ? { workspace: workspace as AgentWorkspaceMode } : {}),
    ...(agent ? { agent } : {}),
  };
}

/** What `tau_send_to_thread` reads from a call. */
export interface SendRequest {
  threadId: string;
  message: string;
  mode: AgentSendMode;
}

export function decodeSendRequest(input: unknown): SendRequest {
  const fields = record(input);
  if (typeof fields.message !== "string" || !fields.message.trim()) throw new Error("message is required: say what the thread should do next.");
  if (fields.message.length > 64_000) throw new Error("message must be 64000 characters or fewer.");
  const mode = optionalText(fields.mode, "mode", 16) ?? "auto";
  if (!AGENT_SEND_MODES.includes(mode as AgentSendMode)) throw new Error(`mode must be one of ${AGENT_SEND_MODES.map((entry) => `"${entry}"`).join(", ")}.`);
  return { threadId: decodeThreadId(input), message: fields.message.trim(), mode: mode as AgentSendMode };
}

/** A caller's retry key: the same key within one thread returns the same work instead of doing it twice. */
export function decodeClientRequestId(input: unknown): string | undefined {
  return optionalText(record(input).clientRequestId, "clientRequestId", 200);
}

export function decodeThreadId(input: unknown): string {
  const value = record(input).threadId;
  if (typeof value !== "string" || !value.trim()) throw new Error("threadId is required.");
  return value.trim();
}

/** The wait bound, clamped so a model cannot park a tool call forever. */
export function decodeTimeout(input: unknown): number {
  const value = record(input).timeoutMs;
  if (value === undefined || value === null) return DEFAULT_WAIT_MS;
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("timeoutMs must be a positive number of milliseconds.");
  return Math.min(Math.round(milliseconds), MAX_WAIT_MS);
}

/** `provider/model-id`, the spelling the model picker shows. */
export function parseModel(model: string): { provider: string; id: string } {
  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator).trim() : "";
  const id = separator > 0 ? model.slice(separator + 1).trim() : "";
  if (!provider || !id) throw new Error(`model must read "provider/model-id", for example "anthropic/claude-sonnet-4-5".`);
  return { provider, id };
}

/** What the user may set for how many children of one thread run at a time. */
export function readMaxRunningAgents(value: unknown): number {
  const requested = record(value).maxRunningAgents;
  const count = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(count) || count < 1) return DEFAULT_MAX_RUNNING_AGENTS;
  return Math.min(Math.floor(count), MAX_RUNNING_AGENTS_CAP);
}

export function deriveStatus(facts: AgentThreadFacts): AgentThreadStatus {
  if (facts.error) return "failed";
  if (facts.cancelled && !facts.live?.streaming) return "cancelled";
  if (facts.queued) return "pending";
  if (facts.live?.streaming) return "running";
  if (facts.pendingToolPrompt) return "waiting";
  // Not streaming and not idle means the runtime is holding something open:
  // a question, an approval, or work an extension still owes the thread.
  if (facts.live && !facts.live.idle) return "waiting";
  if (facts.spawning) return "running";
  if (facts.lastOutcome) return facts.lastOutcome === "failed" ? "failed" : "completed";
  return facts.turns > 0 ? "completed" : "idle";
}

interface AgentRecord {
  link: Omit<AgentThreadLink, "status">;
  facts: Omit<AgentThreadFacts, "live">;
}

/**
 * Every agent a thread spawned in this host, and what became of it. The book
 * holds no host object: liveness arrives through the `live` reader, so the
 * same book answers for an agent whose runtime the host has already released,
 * and for one that has no thread yet because it is still queued.
 */
export class AgentThreadBook {
  private readonly records = new Map<string, AgentRecord>();
  /** Tau thread id to the agent handle, for the observers that only know threads. */
  private readonly byThread = new Map<string, string>();
  private maxRunning = DEFAULT_MAX_RUNNING_AGENTS;

  constructor(private readonly live: (threadId: string) => ThreadLiveness | undefined) {}

  setMaxRunning(count: number): void {
    this.maxRunning = Math.max(1, Math.min(Math.floor(count), MAX_RUNNING_AGENTS_CAP));
  }

  get runningBudget(): number {
    return this.maxRunning;
  }

  /** Depth of any thread: 0 for one the user started. */
  depthOf(threadId: string): number {
    return this.recordFor(threadId)?.link.depth ?? 0;
  }

  /** Refuses a spawn no budget can ever serve; a full budget only queues. */
  assertCanSpawn(parentThreadId: string): void {
    if (this.depthOf(parentThreadId) + 1 > MAX_AGENT_DEPTH) {
      throw new Error(`Sub-agents may nest ${MAX_AGENT_DEPTH} levels deep; do this work in this thread instead.`);
    }
  }

  private recordFor(idOrThreadId: string): AgentRecord | undefined {
    return this.records.get(idOrThreadId) ?? this.records.get(this.byThread.get(idOrThreadId) ?? "");
  }

  add(link: Omit<AgentThreadLink, "status">, facts: Partial<Omit<AgentThreadFacts, "live">> = {}): void {
    const existing = this.records.get(link.id);
    this.records.set(link.id, {
      link: { ...existing?.link, ...link },
      facts: existing?.facts ?? { queued: false, spawning: false, turns: 0, ...facts },
    });
    if (link.threadId) this.byThread.set(link.threadId, link.id);
  }

  has(idOrThreadId: string): boolean {
    return this.recordFor(idOrThreadId) !== undefined;
  }

  /** An agent's link with its status derived now, or undefined when nothing spawned it. */
  linkFor(idOrThreadId: string): AgentThreadLink | undefined {
    const found = this.recordFor(idOrThreadId);
    return found ? { ...found.link, status: deriveStatus(this.factsFor(found.link.id)) } : undefined;
  }

  factsFor(idOrThreadId: string): AgentThreadFacts {
    const found = this.recordFor(idOrThreadId);
    if (!found) return { queued: false, spawning: false, turns: 0 };
    const live = found.link.threadId ? this.live(found.link.threadId) : undefined;
    return { ...found.facts, ...(live ? { live } : {}) };
  }

  childrenOf(parentThreadId: string): AgentThreadLink[] {
    return [...this.records.values()]
      .filter((entry) => entry.link.parentThreadId === parentThreadId)
      .map((entry) => this.linkFor(entry.link.id)!)
      .sort((left, right) => left.spawnedAt - right.spawnedAt);
  }

  /** Children of one thread that hold a slot right now. */
  busyChildren(parentThreadId: string): number {
    return this.childrenOf(parentThreadId).filter((link) => isBusyStatus(link.status)).length;
  }

  /** The queued agents a parent has room to start, oldest first. */
  startable(parentThreadId: string): AgentThreadLink[] {
    const children = this.childrenOf(parentThreadId);
    const free = this.maxRunning - children.filter((link) => isBusyStatus(link.status)).length;
    if (free <= 0) return [];
    return children.filter((link) => link.status === "pending").slice(0, free);
  }

  /** Every thread that currently has queued agents, for the pump to visit. */
  parentsWithQueued(): string[] {
    return [...new Set([...this.records.values()]
      .filter((entry) => entry.facts.queued)
      .map((entry) => entry.link.parentThreadId))];
  }

  state(): AgentsState {
    return { links: [...this.records.keys()].map((id) => this.linkFor(id)!), maxRunning: this.maxRunning };
  }

  private update(idOrThreadId: string, change: (found: AgentRecord) => void): boolean {
    const found = this.recordFor(idOrThreadId);
    if (!found) return false;
    const before = JSON.stringify(this.linkFor(found.link.id));
    change(found);
    return JSON.stringify(this.linkFor(found.link.id)) !== before;
  }

  /**
   * A queued agent took a slot and its thread is being built. It counts against
   * the budget from here, which is what lets the pump dispatch a whole batch
   * without handing the same agent out twice.
   */
  noteStarting(id: string, at: number): boolean {
    return this.update(id, (found) => {
      found.facts.queued = false;
      found.facts.spawning = true;
      found.link = { ...found.link, startedAt: at };
    });
  }

  /** A starting agent got its thread; from here the host drives it. */
  noteStarted(id: string, threadId: string, at: number): boolean {
    return this.update(id, (found) => {
      found.link = { ...found.link, threadId, startedAt: found.link.startedAt ?? at };
      found.facts.queued = false;
      found.facts.spawning = true;
      this.byThread.set(threadId, found.link.id);
    });
  }

  /** A turn of an agent started; it is no longer merely on its way. */
  noteAccepted(idOrThreadId: string): boolean {
    return this.update(idOrThreadId, (found) => { found.facts.spawning = false; });
  }

  noteEnded(idOrThreadId: string, outcome: "completed" | "failed", at: number): boolean {
    return this.update(idOrThreadId, (found) => {
      found.facts.spawning = false;
      found.facts.turns += 1;
      found.facts.lastOutcome = outcome;
      found.link = { ...found.link, endedAt: at };
    });
  }

  /** Its parent cancelled it: a queued one never starts, a running one was stopped. */
  noteCancelled(idOrThreadId: string, at: number): boolean {
    return this.update(idOrThreadId, (found) => {
      found.facts.cancelled = true;
      found.facts.queued = false;
      found.facts.spawning = false;
      found.link = { ...found.link, endedAt: found.link.endedAt ?? at };
    });
  }

  /** Its parent sent it more work; one that starts a turn runs from here until that turn ends. */
  noteSent(idOrThreadId: string, starting: boolean): boolean {
    return this.update(idOrThreadId, (found) => {
      found.facts.cancelled = false;
      if (!starting) return;
      found.facts.spawning = true;
      delete found.facts.lastOutcome;
      found.link = { ...found.link, endedAt: undefined };
    });
  }

  /** A dialog the agent opened, or `undefined` when it closed again. */
  notePrompt(idOrThreadId: string, question: string | undefined): boolean {
    return this.update(idOrThreadId, (found) => {
      if (question) found.facts.pendingToolPrompt = question;
      else delete found.facts.pendingToolPrompt;
      found.link = { ...found.link, ...(question ? { pendingToolPrompt: question } : { pendingToolPrompt: undefined }) };
    });
  }

  noteTool(idOrThreadId: string, tool: string): boolean {
    return this.update(idOrThreadId, (found) => { found.link = { ...found.link, lastTool: tool }; });
  }

  noteResult(idOrThreadId: string, result: string): boolean {
    return this.update(idOrThreadId, (found) => { found.link = { ...found.link, result }; });
  }

  noteError(idOrThreadId: string, message: string): boolean {
    return this.update(idOrThreadId, (found) => {
      found.facts.queued = false;
      found.facts.spawning = false;
      found.facts.error = message;
      found.link = { ...found.link, error: message };
    });
  }

  /** The checkout an agent works in, and what it changed there. */
  noteWorkspace(idOrThreadId: string, workspace: AgentWorkspace | undefined): boolean {
    return this.update(idOrThreadId, (found) => { found.link = { ...found.link, workspace }; });
  }

  noteTitle(idOrThreadId: string, title: string): boolean {
    return this.update(idOrThreadId, (found) => { found.link = { ...found.link, title }; });
  }

  /** The agent's runtime closed; whatever it was holding is no longer open. */
  noteClosed(idOrThreadId: string): boolean {
    return this.update(idOrThreadId, (found) => {
      found.facts.spawning = false;
      delete found.facts.pendingToolPrompt;
      found.link = { ...found.link, pendingToolPrompt: undefined };
    });
  }

  /**
   * Drops agents the thread index no longer lists, and orphans whose parent is
   * gone: such a thread is an ordinary thread again, and the navigator has to
   * show it. A queued agent has no thread yet and is never pruned.
   */
  prune(known: ReadonlySet<string>): boolean {
    if (known.size === 0) return false;
    let removed = false;
    for (const entry of [...this.records.values()]) {
      const gone = (entry.link.threadId !== undefined && !known.has(entry.link.threadId))
        || !known.has(entry.link.parentThreadId);
      if (gone) removed = this.forget(entry.link.id) || removed;
    }
    return removed;
  }

  forget(idOrThreadId: string): boolean {
    const found = this.recordFor(idOrThreadId);
    if (!found) return false;
    if (found.link.threadId) this.byThread.delete(found.link.threadId);
    return this.records.delete(found.link.id);
  }
}
