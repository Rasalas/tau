import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, cp, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PersistentMessageIndex } from "./persistent-index.js";
import { RuntimeThreadIndex } from "./runtime-threads.js";
import { ConversationThreadIndex } from "./conversation-threads.js";
import type { HostConversationServices } from "tau/host-extension";
import { THREAD_TEXT_SOURCES, type MessageIndexStatus } from "./protocol.js";

type Session = { sessionId: string; path: string };
export interface SearchGeneration { index: PersistentMessageIndex; runtime: RuntimeThreadIndex; conversations: ConversationThreadIndex; root: string }
export interface IndexControlOptions {
  stateDir: string;
  now?(): number;
  sessions(): Promise<Session[]>;
  conversations?: HostConversationServices;
  ask(source: string, input: unknown): Promise<unknown>;
  publish(status: MessageIndexStatus): void;
}

/** One completed generation is readable while its replacement is built privately. */
export class MessageIndexControl {
  private status: MessageIndexStatus = { activation: randomUUID(), enabled: true, state: "indexing", done: 0, total: 0, threads: 0, bytes: 0, revision: 0 };
  private current?: SearchGeneration;
  private building?: Promise<void>;
  private abort?: AbortController;
  private stopped = false;
  private writes = Promise.resolve();
  private configWrites = Promise.resolve();
  private readonly root: string;
  private readonly config: string;
  private generation?: string;
  private generations = new Set<SearchGeneration>();
  private refreshedAt = 0;
  private refreshPending = false;
  readonly ready: Promise<void>;

  constructor(private readonly options: IndexControlOptions) {
    this.root = join(options.stateDir, "message-index");
    this.config = join(options.stateDir, "message-index.json");
    this.ready = this.load();
  }
  snapshot = (): MessageIndexStatus => this.status;
  get active(): SearchGeneration | undefined { return this.current; }
  private set(update: Partial<MessageIndexStatus>): void {
    if (this.stopped) return;
    this.status = { ...this.status, ...update, revision: this.status.revision + 1 };
    this.options.publish(this.status);
  }
  private save(enabled: boolean, generation?: string): Promise<void> {
    const run = this.configWrites.then(async () => {
      await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.config}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify({ enabled, generation }), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.config);
      } finally { await rm(temporary, { force: true }); }
    });
    this.configWrites = run.catch(() => undefined);
    return run;
  }

  private make(generation: string, signal?: AbortSignal): SearchGeneration {
    const root = join(this.root, generation);
    const index = new PersistentMessageIndex(root);
    const conversations = new ConversationThreadIndex(this.options.conversations, { persistent: index });
    const runtime = new RuntimeThreadIndex({ sources: THREAD_TEXT_SOURCES, persistent: index, now: this.options.now,
      ignore: id => conversations.suppresses(id), ignoreRevision: () => conversations.revision, ask: async (source, input) => {
      signal?.throwIfAborted();
      // invokeHostExtension has no AbortSignal. Abandon its answer immediately
      // on cancellation, even if the remote exporter is stuck in I/O.
      const pending = this.options.ask(source, input);
      const answer = signal ? await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      }) : await pending;
      signal?.throwIfAborted();
      return answer;
    } });
    const result = { index, runtime, conversations, root };
    this.generations.add(result);
    return result;
  }
  private async load(): Promise<void> {
    try {
      let config: { enabled?: boolean; generation?: string } = {};
      try { config = JSON.parse(await readFile(this.config, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (config.enabled === false) {
        await this.clear();
        this.set({ enabled: false, state: "disabled" });
        return;
      }
      if (typeof config.generation === "string" && /^[\da-f-]{36}$/u.test(config.generation)) {
        this.generation = config.generation;
        this.current = this.make(config.generation);
        const usage = await this.current.index.usage();
        this.set({ ...usage, state: "indexing" });
      }
      this.start(false);
    } catch (error) { this.fail(error); }
  }
  private fail(error: unknown): void {
    this.set({ state: "error", error: error instanceof Error ? error.message : String(error) });
  }
  /** Every mutation is serialized, including persistence and deletion. */
  configure(enabled: boolean): Promise<MessageIndexStatus> {
    const run = this.writes.then(async () => {
      await this.ready;
      this.abort?.abort();
      // Stop exposing old data before waiting for an in-flight source read.
      if (!enabled) { this.current = undefined; this.set({ enabled: false, state: "disabled" }); }
      if (!enabled) await this.save(false);
      await this.building;
      if (enabled) await this.save(true, this.generation);
      if (!enabled) {
        await this.clear();
        this.set({ threads: 0, bytes: 0, done: 0, total: 0, error: undefined });
      } else {
        this.set({ enabled: true, error: undefined });
        this.start(true);
      }
      return this.snapshot();
    });
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }
  rebuild(): Promise<MessageIndexStatus> {
    const run = this.writes.then(async () => {
      await this.ready;
      if (this.status.enabled && !this.stopped) this.start(true);
      return this.snapshot();
    });
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }
  /** Awaited by legacy callers only. The palette uses bounded, resumable jobs. */
  async settled(): Promise<void> { await this.ready; await this.building; }
  refresh(force = false): void {
    if (this.building) { if (force) this.refreshPending = true; return; }
    if (!force && (this.options.now?.() ?? Date.now()) - this.refreshedAt < 5_000) return;
    if (this.status.enabled && !this.stopped) this.start(false);
  }
  private start(force: boolean): void {
    if (this.building || this.stopped || !this.status.enabled) return;
    this.refreshedAt = this.options.now?.() ?? Date.now();
    const controller = new AbortController();
    this.abort = controller;
    const signal = controller.signal;
    const id = randomUUID();
    const next = this.make(id, signal);
    this.set({ state: "indexing", done: 0, total: 0, error: undefined });
    this.building = (async () => {
      // Ordinary updates reuse unchanged files. An explicit rebuild extracts afresh.
      if (!force && this.current) await cp(this.current.index.directory, next.index.directory, { recursive: true });
      await next.conversations.sync();
      signal.throwIfAborted();
      const sessions = (await this.options.sessions()).filter(session => !next.conversations.suppresses(session.sessionId));
      signal.throwIfAborted();
      this.set({ total: sessions.length });
      let done = 0;
      for (const session of sessions) {
        signal.throwIfAborted();
        await next.index.indexPi({ source: "pi", id: session.sessionId, path: session.path });
        signal.throwIfAborted();
        this.set({ done: ++done });
      }
      await next.index.prunePi(sessions.map(session => ({ source: "pi", id: session.sessionId, path: session.path })));
      const persistedSources = new Set((await next.index.catalog()).map(thread => thread.source));
      await next.runtime.sync();
      signal.throwIfAborted();
      const coverage = next.runtime.coverage();
      const prior = this.current?.runtime.coverage() ?? [];
      if (coverage.some(source => source.reason === "export-failed" || source.reason === "catalog-stalled"
        || source.state === "unavailable" && prior.some(old => old.source === source.source && old.state !== "unavailable") || source.state === "unavailable" && persistedSources.has(source.source))) {
        throw new Error("A runtime couldn't export all message text");
      }
      const usage = await next.index.usage();
      signal.throwIfAborted();
      await this.save(true, id);
      // configure() aborts before awaiting this job, including while save is pending.
      if (signal.aborted) {
        await this.save(this.status.enabled, this.status.enabled ? this.generation : undefined);
        signal.throwIfAborted();
      }
      const previous = this.current;
      this.current = next;
      this.generation = id;
      const partial = next.conversations.truncated || next.runtime.coverage().some(source => source.state === "partial");
      this.set({ ...usage, state: partial ? "unavailable" : "ready", done: usage.threads, total: usage.threads });
      // Publication changes no captured reader. Delete retired data only after its queue drains.
      if (previous) {
        await previous.index.idle();
        await rm(previous.root, { recursive: true, force: true });
        this.generations.delete(previous);
      }
    })().catch(error => { if (!signal.aborted) this.fail(error); }).finally(async () => {
      if (this.current !== next) { await rm(next.root, { recursive: true, force: true }).catch(() => undefined); this.generations.delete(next); }
      if (this.abort === controller) this.abort = undefined;
      this.building = undefined;
      if (this.refreshPending) { this.refreshPending = false; this.refresh(true); }
    });
  }
  private async clear(): Promise<void> {
    await Promise.all([...this.generations].map(generation => generation.index.idle()));
    await rm(this.root, { recursive: true, force: true });
    // Delete the pre-control index as well when the user switches indexing off.
    await new PersistentMessageIndex(this.options.stateDir).reset();
    this.generation = undefined;
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.ready;
    await this.writes;
    await this.building;
    await Promise.all([...this.generations].map(generation => generation.index.idle()));
    // No readers remain after host cleanup. Remove unpublished and retired data.
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (name === this.generation || !/^[\da-f-]{36}$/u.test(name)) continue;
      const path = join(this.root, name);
      if ((await lstat(path)).isDirectory()) await rm(path, { recursive: true, force: true });
    }
  }
}
