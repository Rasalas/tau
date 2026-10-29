import { IndexedTranscript } from "./indexed-transcript.js";
import { Worker } from "node:worker_threads";
import { open, stat } from "node:fs/promises";
import { readPersistedSessionBranch } from "./persisted-transcript-reader-session.js";
import type { UiMessage, UiToolOutputReadResult } from "../shared/contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { MISSING_SESSION_FILE, UNREADABLE_SESSION_FILE, PERSISTED_TRANSCRIPT_CHANGED, PersistedThreadTranscript, fileOnlyThread, type PersistedThreadInfo, type PersistedTranscriptOptions } from "./persisted-transcript.js";

export interface PersistedTranscriptDiagnostics {
  builds: number;
  mappedRecords: number;
  pageRecords: number;
  cacheBytes: number;
  sessions: number;
}

interface SmallTranscriptSnapshot {
  stamp: string;
  reader: { page(cursor?: HostTranscriptCursor, tail?: readonly UiMessage[]): TranscriptPage; toolOutput?(toolCallId: string): UiToolOutputReadResult | undefined };
  bytes: number;
}

interface TranscriptReadRequest {
  operation: "page" | "toolOutput";
  cursor?: HostTranscriptCursor;
  toolCallId?: string;
}

const fileStamp = (info: Awaited<ReturnType<typeof stat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

/** One lazily started worker per host. Files above 256 KiB parse off the host
 * event loop. Smaller files use a bounded asynchronous read and the SDK already
 * loaded by the host. Warm pages reuse the turn index.
 *
 * The cache reserves at most 2 MiB for four small snapshots and gives the rest
 * to four worker snapshots. Together their serialized raw and mapped payloads
 * stay within cacheBytesLimit. This is a payload budget, not a JS heap limit.
 * Oversized snapshots are served without retention and parse again next time.
 * The worker is released after thirty idle seconds.
 */
export class PersistedTranscriptReader {
  private worker?: Worker;
  private small = new Map<string, SmallTranscriptSnapshot>();
  private smallLoads = new Map<string, Promise<SmallTranscriptSnapshot | undefined>>();
  private smallLatest = new Map<string, symbol>();
  private smallBytes = 0;
  private readonly liveIds = new WeakMap<object, number>();
  private nextLiveId = 0;
  private smallBuilds = 0;
  private smallMapped = 0;
  private workerDiagnostics: PersistedTranscriptDiagnostics = { builds: 0, mappedRecords: 0, pageRecords: 0, cacheBytes: 0, sessions: 0 };
  private starts = 0;
  get workerStarts(): number { return this.starts; }
  private get smallBudget(): number { return Math.min(this.cacheBytesLimit, this.smallFileBytesLimit * 8); }

  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private pins = new Map<string, { stamp: string; ids: string[] }>();
  diagnostics: PersistedTranscriptDiagnostics = { builds: 0, mappedRecords: 0, pageRecords: 0, cacheBytes: 0, sessions: 0 };

  constructor(
    private readonly workerUrl = new URL("./persisted-transcript-worker.mjs", import.meta.url),
    private readonly cacheBytesLimit = 64 * 1024 * 1024,
    private readonly smallFileBytesLimit = 256 * 1024,
  ) {
    if (!Number.isSafeInteger(cacheBytesLimit) || cacheBytesLimit < 0) throw new Error("Invalid transcript cache limit.");
    if (!Number.isSafeInteger(smallFileBytesLimit) || smallFileBytesLimit < 0 || smallFileBytesLimit > 256 * 1024) throw new Error("Invalid small transcript read limit.");
  }

  /** Live branches share the four small snapshot slots and their existing byte
   * budget with file reads. Oversized branches are served without retention.
   * The caller supplies a cheap SDK leaf revision, never a branch walk as a key.
   */
  livePage(thread: object, revision: string, build: () => IndexedTranscript, cursor?: HostTranscriptCursor, tail: readonly UiMessage[] = []): TranscriptPage {
    if (this.closed) throw new Error("Persisted transcript reader is closed.");
    let id = this.liveIds.get(thread);
    if (id === undefined) { id = ++this.nextLiveId; this.liveIds.set(thread, id); }
    const key = `live:${id}`;
    let found = this.small.get(key);
    if (found?.stamp !== revision) {
      const index = build();
      if (this.closed) throw new Error("Persisted transcript reader is closed.");
      found = { stamp: revision, reader: index, bytes: index.cacheBytes };
      this.smallBuilds += 1;
      this.smallMapped += index.messageCount;
      this.retainSmall(key, found);
    } else { this.small.delete(key); this.small.set(key, found); }
    const page = found.reader.page(cursor, tail);
    this.updateDiagnostics(page.messages.length);
    return page;
  }

  async page(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, cursor?: HostTranscriptCursor): Promise<TranscriptPage> {
    return this.read(thread, options, { operation: "page", cursor }) as Promise<TranscriptPage>;
  }

  async toolOutput(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, toolCallId: string): Promise<UiToolOutputReadResult | undefined> {
    return this.read(thread, options, { operation: "toolOutput", toolCallId }) as Promise<UiToolOutputReadResult | undefined>;
  }

  private async read(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, request: TranscriptReadRequest, attempt = 0): Promise<unknown> {
    // Transports carry functions and are irrelevant to persisted Pi presentation.
    const adapter = { id: options.runtimeAdapter.id, capabilities: options.runtimeAdapter.capabilities };
    const base = { thread, adapter, skills: [...options.skillCommands] };
    try {
      if (this.closed) throw new Error("Persisted transcript reader is closed.");
      const info = await stat(thread.path).catch(() => { throw new Error(MISSING_SESSION_FILE); });
      if (this.smallFileBytesLimit > 0 && info.size <= this.smallFileBytesLimit) {
        const small = await this.readSmall(thread, options, JSON.stringify([base, Boolean(options.pins), options.pinsRevision]), fileStamp(info), request);
        if (small) return small.value;
      }
      let pinned: string[] | undefined;
      let expectedStamp: string | undefined;
      if (options.pins) {
        const stamp = fileStamp(info);
        const key = JSON.stringify([base, options.pinsRevision]);
        let cached = this.pins.get(key);
        if (cached?.stamp !== stamp) {
          const snapshot = await this.send({ ...base, operation: "pins" }) as { entries: unknown[]; messages: UiMessage[]; stamp: string };
          cached = { stamp: snapshot.stamp, ids: [...options.pins(fileOnlyThread(thread, snapshot.entries, () => snapshot.messages))] };
          if (this.pins.size >= 4) this.pins.delete(this.pins.keys().next().value!);
          this.pins.set(key, cached);
        }
        pinned = cached.ids;
        expectedStamp = cached.stamp;
      }
      return await this.send({ ...base, ...request, ...(pinned ? { pinned, expectedStamp } : {}) });
    } catch (error) {
      if (error instanceof Error && error.message === PERSISTED_TRANSCRIPT_CHANGED && attempt < 2) {
        this.pins.clear();
        return this.read(thread, options, request, attempt + 1);
      }
      throw error;
    }
  }

  private updateDiagnostics(pageRecords: number): void {
    this.diagnostics = {
      builds: this.workerDiagnostics.builds + this.smallBuilds,
      mappedRecords: this.workerDiagnostics.mappedRecords + this.smallMapped,
      pageRecords,
      cacheBytes: this.workerDiagnostics.cacheBytes + this.smallBytes,
      sessions: this.workerDiagnostics.sessions + this.small.size,
    };
  }

  private async readSmall(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, key: string, stamp: string, request: TranscriptReadRequest): Promise<{ value: unknown } | undefined> {
    let found = this.small.get(key);
    if (found?.stamp !== stamp) {
      const loadKey = JSON.stringify([key, stamp]);
      let loading = this.smallLoads.get(loadKey);
      if (!loading) {
        const generation = Symbol();
        this.smallLatest.set(key, generation);
        loading = this.loadSmall(thread, options, key, stamp, generation);
        this.smallLoads.set(loadKey, loading);
        void loading.finally(() => {
          this.smallLoads.delete(loadKey);
          if (this.smallLatest.get(key) === generation) this.smallLatest.delete(key);
        }).catch(() => undefined);
      }
      found = await loading;
      if (!found) return undefined;
    } else { this.small.delete(key); this.small.set(key, found); }
    if (this.closed) throw new Error("Persisted transcript reader is closed.");
    const value = request.operation === "page" ? found.reader.page(request.cursor) : found.reader.toolOutput?.(request.toolCallId!);
    this.updateDiagnostics(request.operation === "page" ? (value as TranscriptPage).messages.length : 0);
    return { value };
  }

  private async loadSmall(thread: PersistedThreadInfo, options: PersistedTranscriptOptions, key: string, stamp: string, generation: symbol): Promise<SmallTranscriptSnapshot | undefined> {
    const file = await open(thread.path, "r").catch(() => { throw new Error(MISSING_SESSION_FILE); });
    let text: string;
    try {
      // The stat is advisory: a concurrent append must not make this read unbounded.
      const buffer = Buffer.alloc(this.smallFileBytesLimit + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes > this.smallFileBytesLimit) return undefined;
      text = buffer.toString("utf8", 0, bytes);
    } finally { await file.close(); }
    if (this.closed) throw new Error("Persisted transcript reader is closed.");
    let reader: PersistedThreadTranscript;
    try {
      const entries = readPersistedSessionBranch(text);
      reader = new PersistedThreadTranscript(thread, options, entries);
      reader.messages();
    } catch (error) { throw new Error(UNREADABLE_SESSION_FILE, { cause: error }); }
    const after = await stat(thread.path).catch(() => { throw new Error(MISSING_SESSION_FILE); });
    if (this.closed) throw new Error("Persisted transcript reader is closed.");
    if (fileStamp(after) !== stamp) throw new Error(PERSISTED_TRANSCRIPT_CHANGED);
    const bytes = Buffer.byteLength(JSON.stringify(reader.entries)) + Buffer.byteLength(JSON.stringify(reader.messages()));
    this.smallBuilds += 1;
    this.smallMapped += reader.messages().length;
    const found = { reader, stamp, bytes };
    if (this.smallLatest.get(key) !== generation) return found;
    this.retainSmall(key, found);
    return found;
  }

  private retainSmall(key: string, found: SmallTranscriptSnapshot): void {
    const replaced = this.small.get(key);
    if (replaced) { this.small.delete(key); this.smallBytes -= replaced.bytes; }
    while (this.small.size && (this.small.size >= 4 || this.smallBytes + found.bytes > this.smallBudget)) {
      const oldest = this.small.keys().next().value!;
      this.smallBytes -= this.small.get(oldest)!.bytes;
      this.small.delete(oldest);
    }
    if (found.bytes <= this.smallBudget) { this.small.set(key, found); this.smallBytes += found.bytes; }
  }

  private send(request: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Persisted transcript reader is closed."));
    clearTimeout(this.idle);
    if (!this.worker) {
      const previousBuilds = this.workerDiagnostics.builds;
      const previousMapped = this.workerDiagnostics.mappedRecords;
      const worker = new Worker(this.workerUrl, { workerData: { cacheBytesLimit: this.cacheBytesLimit - this.smallBudget } });
      this.worker = worker;
      this.starts += 1;
      worker.on("message", (response: { id: number; value?: unknown; error?: string; diagnostics?: PersistedTranscriptDiagnostics }) => {
        if (this.worker !== worker) return;
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        if (response.diagnostics) {
          this.workerDiagnostics = { ...response.diagnostics, builds: previousBuilds + response.diagnostics.builds, mappedRecords: previousMapped + response.diagnostics.mappedRecords };
          this.updateDiagnostics(response.diagnostics.pageRecords);
        }
        if (response.error) pending?.reject(new Error(response.error));
        else pending?.resolve(response.value);
        if (!this.pending.size) {
          this.idle = setTimeout(() => {
            this.worker = undefined;
            this.pins.clear();
            this.workerDiagnostics = { ...this.workerDiagnostics, cacheBytes: 0, sessions: 0 };
            this.updateDiagnostics(this.diagnostics.pageRecords);
            void worker.terminate();
          }, 30_000);
          this.idle.unref();
        }
      });
      const fail = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        this.pins.clear();
        clearTimeout(this.idle);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
      worker.on("error", fail);
      worker.on("exit", (code) => fail(new Error(`Persisted transcript worker exited (${code}).`)));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ ...request, id }); }
      catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) {
          const worker = this.worker;
          this.worker = undefined;
          this.pins.clear();
          void worker?.terminate();
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idle);
    for (const pending of this.pending.values()) pending.reject(new Error("Persisted transcript reader is closed."));
    this.pending.clear();
    this.pins.clear();
    this.small.clear();
    this.smallLatest.clear();
    this.smallBytes = 0;
    this.workerDiagnostics = { ...this.workerDiagnostics, cacheBytes: 0, sessions: 0 };
    this.updateDiagnostics(this.diagnostics.pageRecords);
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
