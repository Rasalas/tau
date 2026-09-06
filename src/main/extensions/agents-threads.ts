import {
  DEFAULT_WAIT_MS,
  MAX_AGENT_DEPTH,
  MAX_CHILDREN_PER_PARENT,
  MAX_WAIT_MS,
  type AgentThreadLink,
  type AgentThreadStatus,
  type AgentsState,
} from "../../shared/agents-kit-protocol.js";

/** What Agents Kit reads from a tool call. The model may send anything. */
export interface SpawnRequest {
  prompt: string;
  title?: string;
  model?: string;
  projectPath?: string;
}

export interface ThreadLiveness {
  streaming: boolean;
  idle: boolean;
}

/** Everything one spawned thread's status is derived from. */
export interface AgentThreadFacts {
  /** The first prompt is on its way but no turn has been accepted yet. */
  spawning: boolean;
  turns: number;
  lastOutcome?: "completed" | "failed";
  /** Question the child is holding on; the user answers it in the child's thread. */
  pendingToolPrompt?: string;
  error?: string;
  /** Absent once the host released the thread's runtime. */
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
  return {
    prompt: fields.prompt.trim(),
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
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

export function deriveStatus(facts: AgentThreadFacts): AgentThreadStatus {
  if (facts.error) return "failed";
  if (facts.live?.streaming) return "running";
  if (facts.pendingToolPrompt) return "waiting";
  // Not streaming and not idle means the runtime is holding something open:
  // a question, an approval, or work an extension still owes the thread.
  if (facts.live && !facts.live.idle) return "waiting";
  if (facts.spawning) return "running";
  if (facts.lastOutcome) return facts.lastOutcome === "failed" ? "failed" : "completed";
  return facts.turns > 0 ? "completed" : "idle";
}

/** A status that still needs the host: such a child counts against the parent's budget. */
export function isLiveStatus(status: AgentThreadStatus): boolean {
  return status === "running" || status === "waiting";
}

interface AgentRecord {
  link: Omit<AgentThreadLink, "status">;
  facts: Omit<AgentThreadFacts, "live">;
}

/**
 * Every thread an agent spawned in this host, and what became of it. The book
 * holds no host object: liveness arrives through the `live` reader, so the
 * same book answers for a thread whose runtime the host has already released.
 */
export class AgentThreadBook {
  private readonly records = new Map<string, AgentRecord>();

  constructor(private readonly live: (threadId: string) => ThreadLiveness | undefined) {}

  /** Depth of any thread: 0 for one the user started. */
  depthOf(threadId: string): number {
    return this.records.get(threadId)?.link.depth ?? 0;
  }

  /** Refuses a spawn the guard rails do not allow, with the reason the model reads. */
  assertCanSpawn(parentThreadId: string): void {
    const depth = this.depthOf(parentThreadId) + 1;
    if (depth > MAX_AGENT_DEPTH) {
      throw new Error(`Sub-agents may nest ${MAX_AGENT_DEPTH} levels deep; do this work in this thread instead.`);
    }
    const live = this.childrenOf(parentThreadId).filter((child) => isLiveStatus(child.status)).length;
    if (live >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`This thread already has ${live} sub-agents running; wait for one with tau_wait_for_thread before starting another.`);
    }
  }

  add(link: Omit<AgentThreadLink, "status">, spawning = true): void {
    const existing = this.records.get(link.threadId);
    this.records.set(link.threadId, {
      link: { ...link, ...(existing?.link.title && !link.title ? { title: existing.link.title } : {}) },
      facts: existing?.facts ?? { spawning, turns: 0 },
    });
  }

  has(threadId: string): boolean {
    return this.records.has(threadId);
  }

  /** A thread's link with its status derived now, or undefined when nothing spawned it. */
  linkFor(threadId: string): AgentThreadLink | undefined {
    const found = this.records.get(threadId);
    return found ? { ...found.link, status: deriveStatus(this.factsFor(threadId)) } : undefined;
  }

  factsFor(threadId: string): AgentThreadFacts {
    const found = this.records.get(threadId);
    if (!found) return { spawning: false, turns: 0 };
    const live = this.live(threadId);
    return { ...found.facts, ...(live ? { live } : {}) };
  }

  childrenOf(parentThreadId: string): AgentThreadLink[] {
    return [...this.records.values()]
      .filter((entry) => entry.link.parentThreadId === parentThreadId)
      .map((entry) => this.linkFor(entry.link.threadId)!)
      .sort((left, right) => left.spawnedAt - right.spawnedAt);
  }

  state(): AgentsState {
    return { links: [...this.records.keys()].map((threadId) => this.linkFor(threadId)!) };
  }

  private update(threadId: string, change: (facts: AgentRecord["facts"]) => void): boolean {
    const found = this.records.get(threadId);
    if (!found) return false;
    const before = deriveStatus(this.factsFor(threadId));
    change(found.facts);
    return deriveStatus(this.factsFor(threadId)) !== before;
  }

  /** A turn of a spawned thread started; it is no longer merely on its way. */
  noteAccepted(threadId: string): boolean {
    return this.update(threadId, (facts) => { facts.spawning = false; });
  }

  noteEnded(threadId: string, outcome: "completed" | "failed"): boolean {
    return this.update(threadId, (facts) => {
      facts.spawning = false;
      facts.turns += 1;
      facts.lastOutcome = outcome;
    });
  }

  /** A dialog the child opened, or `undefined` when it closed again. */
  notePrompt(threadId: string, question: string | undefined): boolean {
    return this.update(threadId, (facts) => {
      if (question) facts.pendingToolPrompt = question;
      else delete facts.pendingToolPrompt;
    });
  }

  noteError(threadId: string, message: string): boolean {
    return this.update(threadId, (facts) => { facts.spawning = false; facts.error = message; });
  }

  noteTitle(threadId: string, title: string): boolean {
    const found = this.records.get(threadId);
    if (!found || found.link.title === title) return false;
    found.link = { ...found.link, title };
    return true;
  }

  /** The thread's runtime closed; whatever it was holding is no longer open. */
  noteClosed(threadId: string): boolean {
    return this.update(threadId, (facts) => {
      facts.spawning = false;
      delete facts.pendingToolPrompt;
    });
  }

  forget(threadId: string): boolean {
    return this.records.delete(threadId);
  }
}
