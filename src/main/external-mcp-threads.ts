import { stat } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { HostThread, HostTurnObserver } from "./host-extension-contracts.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";
import { isExternalMcpExecution, strictestExecution, type ExternalMcpExecution } from "./external-mcp-policy.js";

/** The custom entry a thread an external client started carries, so a resumed or forked copy keeps its ceiling. */
export const EXTERNAL_MCP_THREAD_ENTRY = "tau.external-mcp/thread";
/** The per-thread level of the Access extension; without it a ceiling below `full` cannot hold. */
const LEVEL_EXTENSION = "tau.access";
const LEVEL_COMMAND = "thread-level";
const MAX_THREADS = 4096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const Record = Type.Object({
  threadId: Type.String({ minLength: 1, maxLength: 128 }),
  grantId: Type.String({ minLength: 1, maxLength: 128 }),
  projectId: Type.String({ minLength: 1, maxLength: 128 }),
  execution: Type.Union([Type.Literal("read-only"), Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")]),
  startedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  /** The client's name as the owner registered or created it, for the thread list. */
  client: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** False: the thread's runtime keeps no journal, so this record is its only ceiling and is never dropped. */
  journaled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const File = Type.Object({ version: Type.Literal(1), threads: Type.Array(Record, { maxItems: MAX_THREADS }) }, { additionalProperties: false });
export type ExternalMcpThreadRecord = Static<typeof Record>;

/** What the registry needs of a running host. `PiHost` provides all of it. */
export interface ExternalMcpThreadHost {
  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  liveThread(sessionId: string): Pick<HostThread, "entries" | "isIdle"> | undefined;
  abort(sessionId: string): Promise<void>;
  observeTurns(observer: HostTurnObserver): () => void;
  /** A reloaded Access extension starts with no levels; every recorded ceiling goes back in at once. */
  observeExtensionActivation?(listener: (id: string) => void): () => void;
  /** Core's own clamp on every runtime's level, which no extension reload lifts. */
  setThreadCeiling?(provider: ((sessionId: string) => ExternalMcpExecution | undefined) | undefined): void;
  markMcpClient?(sessionId: string, client: { name: string; ceiling: ExternalMcpExecution } | undefined): void;
}

/** A refusal whose text is safe and useful to show an external client. */
export class ExternalMcpRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalMcpRefusal";
  }
}

/**
 * Threads external MCP clients started (ADR 0046): which grant may control
 * each, and the execution ceiling every turn of it runs under. The ceiling is
 * the Access extension's per-thread level, kept in memory there, so this
 * applies it before the first prompt, before every prepared turn, before every
 * control call and again once the host has started.
 */
export class ExternalMcpThreads {
  private host?: ExternalMcpThreadHost;
  private stopObserving: Array<() => void> = [];
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(private readonly path: string, private records: ExternalMcpThreadRecord[], private readonly logger?: PersistedJsonLogger) {}

  static async open(options: { path: string; logger?: PersistedJsonLogger }): Promise<ExternalMcpThreads> {
    const existing = await stat(options.path).catch(() => undefined);
    if (existing && (!existing.isFile() || existing.size > MAX_FILE_BYTES)) throw new Error("The external MCP thread registry is not a bounded file.");
    const read = await readPersistedJson(options.path, {
      expectedVersion: 1, logger: options.logger, invalidJson: "reject",
      decode: (value) => {
        if (!Check(File, value)) throw new Error("The external MCP thread registry is invalid.");
        return value.threads;
      },
    });
    return new ExternalMcpThreads(options.path, read?.data ?? [], options.logger);
  }

  /** Called once the host exists, before its first turn: every prepared or accepted turn of a marked thread gets its ceiling. */
  attach(host: ExternalMcpThreadHost): void {
    this.close();
    this.host = host;
    host.setThreadCeiling?.((threadId) => this.ceiling(threadId));
    if (host.observeExtensionActivation) this.stopObserving.push(host.observeExtensionActivation((id) => { if (id === LEVEL_EXTENSION) void this.restore(); }));
    for (const record of this.records) this.mark(record);
    this.stopObserving.push(host.observeTurns({
      prepare: async (threadId) => {
        const level = this.ceiling(threadId);
        if (level) await this.apply(threadId, level);
      },
      // A steer, follow-up or queued message joins a run without `prepare`; the run already had its level, this renews it.
      accepted: (threadId) => {
        const level = this.ceiling(threadId);
        if (level) void this.apply(threadId, level).catch((error: unknown) => this.logger?.warn("external-mcp.ceiling-failed", error));
      },
    }));
  }

  private mark(record: ExternalMcpThreadRecord): void {
    if (record.client) this.host?.markMcpClient?.(record.threadId, { name: record.client, ceiling: record.execution });
  }

  /** After the host started: a thread a runtime resumes on its own is capped before anyone prompts it. */
  async restore(): Promise<void> {
    for (const record of [...this.records]) {
      await this.apply(record.threadId, record.execution).catch((error: unknown) => this.logger?.warn("external-mcp.ceiling-restore-failed", error));
    }
  }

  /** The grant that started the thread; only that grant may control it. */
  owner(threadId: string): ExternalMcpThreadRecord | undefined {
    return this.records.find((record) => record.threadId === threadId);
  }

  /** The strictest of the registry's ceiling and the one the thread's own entries carry (a fork keeps it). */
  ceiling(threadId: string): ExternalMcpExecution | undefined {
    let level: ExternalMcpExecution | undefined = this.owner(threadId)?.execution;
    for (const entry of this.host?.liveThread(threadId)?.entries() ?? []) {
      const value = entry as { type?: unknown; customType?: unknown; data?: { execution?: unknown } };
      if (value.type !== "custom" || value.customType !== EXTERNAL_MCP_THREAD_ENTRY || !isExternalMcpExecution(value.data?.execution)) continue;
      level = level ? strictestExecution(level, value.data.execution) : value.data.execution;
    }
    return level;
  }

  /** Fails closed: a ceiling below `full` that the Access extension does not confirm stops the call or turn. */
  async apply(threadId: string, level: ExternalMcpExecution): Promise<void> {
    const host = this.requireHost();
    let effective: unknown;
    try {
      effective = await host.invokeHostExtension(LEVEL_EXTENSION, LEVEL_COMMAND, { threadId, level });
    } catch (error) {
      if (level === "full") return;
      this.logger?.warn("external-mcp.ceiling-unavailable", error);
      throw new ExternalMcpRefusal(`This thread runs under a "${level}" ceiling and Tau cannot enforce it: turn on the Access extension.`);
    }
    if (level !== "full" && (!isExternalMcpExecution(effective) || strictestExecution(level, effective) !== effective)) {
      throw new ExternalMcpRefusal(`This thread runs under a "${level}" ceiling and Tau could not confirm it.`);
    }
  }

  /**
   * Inside `beforePrompt`: the ceiling holds, the thread carries it and the
   * registry names its grant before the first prompt is admitted. Any failure
   * rejects the start, and the host discards the thread.
   */
  async claim(thread: Pick<HostThread, "sessionId" | "appendEntry" | "backendKind">, record: Omit<ExternalMcpThreadRecord, "threadId" | "journaled">): Promise<void> {
    await this.apply(thread.sessionId, record.execution);
    // Only Pi keeps a journal (`thread-runtime-backend.ts`); another runtime's ceiling lives in the registry alone.
    const journaled = thread.backendKind === "pi";
    if (journaled) thread.appendEntry(EXTERNAL_MCP_THREAD_ENTRY, { execution: record.execution, startedAt: record.startedAt });
    const added: ExternalMcpThreadRecord = { threadId: thread.sessionId, ...record, journaled };
    await this.save((records) => {
      const next = [...records.filter((entry) => entry.threadId !== thread.sessionId), added];
      // The oldest journaled records go first: their threads keep the ceiling through the entry they carry.
      while (next.length > MAX_THREADS) {
        const oldest = next.findIndex((entry) => entry.journaled !== false);
        if (oldest < 0 || oldest === next.length - 1) throw new ExternalMcpRefusal(`Tau already holds the ceilings of ${MAX_THREADS} threads MCP clients started on runtimes without a journal; it starts no more.`);
        next.splice(oldest, 1);
      }
      return next;
    });
    this.mark(added);
  }

  /** The grant's authority is gone: its threads stop their running turns. Their ceilings stay. */
  async revoked(grantId: string): Promise<string[]> {
    const host = this.host;
    if (!host) return [];
    const stopped: string[] = [];
    for (const record of this.records.filter((entry) => entry.grantId === grantId)) {
      const thread = host.liveThread(record.threadId);
      if (!thread || thread.isIdle()) continue;
      try { await host.abort(record.threadId); stopped.push(record.threadId); }
      catch (error) { this.logger?.warn("external-mcp.revoke-stop-failed", error); }
    }
    return stopped;
  }

  close(): void {
    for (const stop of this.stopObserving.splice(0)) stop();
    this.host?.setThreadCeiling?.(undefined);
  }

  private requireHost(): ExternalMcpThreadHost {
    if (!this.host) throw new ExternalMcpRefusal("Tau is still starting. Try again in a moment.");
    return this.host;
  }

  private save(change: (records: readonly ExternalMcpThreadRecord[]) => ExternalMcpThreadRecord[]): Promise<void> {
    const next = this.writes.catch(() => undefined).then(async () => {
      const records = change(this.records);
      await writePersistedJson(this.path, 1, { threads: records }, { logger: this.logger });
      this.records = records;
    });
    this.writes = next;
    return next;
  }
}
