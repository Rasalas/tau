import type { ThreadText } from "./threads.js";

/**
 * The text of the threads other runtimes keep, for the palette's content
 * search: a thread of Codex, the Agent SDK runtime, Antigravity or OpenCode
 * has no session file to read, so each of those kits answers `thread-texts`
 * from its own store. The index asks every few seconds at most, and only for
 * what it lacks; past its character budget it forgets the oldest threads' text
 * but keeps their version, so they are not fetched again until they change.
 */

export interface RuntimeThread {
  source: string;
  threadId: string;
  updatedAt: number;
  texts: ThreadText[];
}

interface Held extends RuntimeThread {
  chars: number;
}

export interface RuntimeThreadIndexOptions {
  /** The kits that answer `thread-texts`, by extension id. */
  sources: readonly string[];
  ask(source: string, input: { known: Record<string, number>; limit: number }): Promise<unknown>;
  now?(): number;
  /** A sync within this long of the last one answers from the index as it is. */
  intervalMs?: number;
  /** Threads per answer and answers per source and sync; the rest waits for the next sync. */
  limit?: number;
  rounds?: number;
  /** Characters the index keeps across every thread. */
  budgetChars?: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function texts(value: unknown): ThreadText[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const message = record(entry);
    return (message.role === "user" || message.role === "assistant") && typeof message.text === "string" && message.text
      ? [{ role: message.role, text: message.text }]
      : [];
  });
}

export class RuntimeThreadIndex {
  private readonly threads = new Map<string, Held>();
  private readonly now: () => number;
  private chars = 0;
  private syncing: Promise<void> | undefined;
  private syncedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RuntimeThreadIndexOptions) {
    this.now = options.now ?? Date.now;
  }

  /** How many characters the index holds; the budget caps it. */
  get size(): number {
    return this.chars;
  }

  /** Brings the index up to date unless it was a moment ago; one sync runs at a time. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (this.now() - this.syncedAt < (this.options.intervalMs ?? 5_000)) return Promise.resolve();
    const run = Promise.all(this.options.sources.map((source) => this.syncSource(source))).then(() => {
      this.syncedAt = this.now();
      this.trim();
    }).finally(() => { this.syncing = undefined; });
    this.syncing = run;
    return run;
  }

  /** Every thread whose text is held, newest first. */
  entries(): RuntimeThread[] {
    return [...this.threads.values()].filter((thread) => thread.texts.length > 0).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async syncSource(source: string): Promise<void> {
    for (let round = 0; round < (this.options.rounds ?? 4); round += 1) {
      const known: Record<string, number> = {};
      for (const thread of this.threads.values()) if (thread.source === source) known[thread.threadId] = thread.updatedAt;
      let answer: Record<string, unknown>;
      try {
        answer = record(await this.options.ask(source, { known, limit: this.options.limit ?? 25 }));
      } catch {
        // The kit is off, missing or older than this command: its threads are found by title only.
        return;
      }
      for (const id of Array.isArray(answer.removed) ? answer.removed : []) if (typeof id === "string") this.drop(id);
      for (const entry of Array.isArray(answer.threads) ? answer.threads : []) {
        const thread = record(entry);
        if (typeof thread.threadId !== "string" || typeof thread.updatedAt !== "number") continue;
        this.drop(thread.threadId);
        const held: Held = { source, threadId: thread.threadId, updatedAt: thread.updatedAt, texts: texts(thread.messages), chars: 0 };
        held.chars = held.texts.reduce((sum, text) => sum + text.text.length, 0);
        this.threads.set(held.threadId, held);
        this.chars += held.chars;
      }
      if (answer.more !== true) return;
    }
  }

  private drop(threadId: string): void {
    const held = this.threads.get(threadId);
    if (!held) return;
    this.chars -= held.chars;
    this.threads.delete(threadId);
  }

  /** Over budget, the oldest threads give up their text and keep their version. */
  private trim(): void {
    const budget = this.options.budgetChars ?? 4_000_000;
    if (this.chars <= budget) return;
    const oldest = [...this.threads.values()].filter((thread) => thread.chars > 0).sort((left, right) => left.updatedAt - right.updatedAt);
    for (const thread of oldest) {
      if (this.chars <= budget) break;
      this.chars -= thread.chars;
      thread.chars = 0;
      thread.texts = [];
    }
  }
}
