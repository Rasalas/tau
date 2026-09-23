import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ThreadBackendKind } from "../shared/contracts.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** How long a deleted thread can be restored before it is removed for good. */
export const DEFAULT_TRASH_RETENTION_MS = 30 * DAY_MS;
/** The purge timer never sleeps longer than this, so a changed clock is noticed. */
const MAX_PURGE_WAIT_MS = 60 * 60_000;

/** A deleted thread the host can still put back. */
export interface TrashedThread {
  sessionId: string;
  cwd: string;
  title: string;
  backendKind: ThreadBackendKind;
  deletedAt: number;
  /** When the thread is removed for good. */
  purgeAt: number;
}

interface StoredEntry extends TrashedThread {
  /** Where a Pi session file lived; restoring puts it back there. */
  originalPath?: string;
  /** The session file's name inside the entry's folder. */
  file?: string;
  /** The entry's folder holds the backend's shell record as `shell.json`. */
  shell?: boolean;
}

/** What the trash needs of the host: the backend that owns a shell, and the hooks a purge runs. */
export interface ThreadTrashPort {
  backend(kind: ThreadBackendKind): {
    label?: string;
    removeThread?(threadId: string): Promise<unknown>;
    restoreThread?(threadId: string, record: unknown): Promise<void>;
  } | undefined;
  threadDeleted(sessionId: string, cwd: string): Promise<void>;
  log(label: string, detail?: string): void;
}

export interface ThreadTrashOptions {
  /** `<userData>/thread-trash`. */
  dir: string;
  /** `TAU_THREAD_TRASH_RETENTION_MS` overrides the default for a test instance. */
  retentionMs?: number;
  now?: () => number;
  logger?: PersistedJsonLogger;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function decodeEntry(value: unknown): StoredEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const sessionId = text(raw.sessionId);
  const cwd = text(raw.cwd);
  const deletedAt = number(raw.deletedAt);
  const purgeAt = number(raw.purgeAt);
  if (!sessionId || !cwd || deletedAt === undefined || purgeAt === undefined) return undefined;
  return {
    sessionId,
    cwd,
    title: typeof raw.title === "string" ? raw.title : "",
    backendKind: text(raw.backendKind) ?? "pi",
    deletedAt,
    purgeAt,
    ...(text(raw.originalPath) ? { originalPath: text(raw.originalPath) } : {}),
    ...(text(raw.file) ? { file: basename(text(raw.file)!) } : {}),
    ...(raw.shell === true ? { shell: true } : {}),
  };
}

function retentionFromEnv(): number | undefined {
  const value = Number(process.env.TAU_THREAD_TRASH_RETENTION_MS);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A rename, or a copy and delete where the trash is on another volume. */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from);
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * Deleted threads, kept under the host's userData until their retention runs
 * out. A Pi thread's session file moves here; a thread of another backend
 * leaves its shell record here and the CLI's own history untouched. Only a
 * purge is final, and only a purge runs the `threadDeleted` hooks.
 */
export class ThreadTrash {
  private entries = new Map<string, StoredEntry>();
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly manifest: string;

  constructor(private readonly port: ThreadTrashPort, private readonly options: ThreadTrashOptions) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? retentionFromEnv() ?? DEFAULT_TRASH_RETENTION_MS;
    this.manifest = join(options.dir, "trash.json");
  }

  load(): Promise<void> {
    this.loading ??= readPersistedJson(this.manifest, {
      expectedVersion: VERSION,
      decode: (value) => Array.isArray((value as { threads?: unknown })?.threads)
        ? ((value as { threads: unknown[] }).threads).flatMap((entry) => { const decoded = decodeEntry(entry); return decoded ? [decoded] : []; })
        : undefined,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    }).then((read) => {
      for (const entry of read?.data ?? []) this.entries.set(entry.sessionId, entry);
    }, () => undefined);
    return this.loading;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  list(): TrashedThread[] {
    return [...this.entries.values()]
      .sort((left, right) => right.deletedAt - left.deletedAt)
      .map(({ sessionId, cwd, title, backendKind, deletedAt, purgeAt }) => ({ sessionId, cwd, title, backendKind, deletedAt, purgeAt }));
  }

  /** Moves a thread in: its session file, or the shell its backend hands over. */
  trash(thread: { sessionId: string; cwd: string; title: string; backendKind: ThreadBackendKind; path: string }): Promise<TrashedThread> {
    return this.serial(async () => {
      await this.load();
      if (this.entries.has(thread.sessionId)) throw new Error("This thread is already in the trash.");
      const deletedAt = this.now();
      const entry: StoredEntry = {
        sessionId: thread.sessionId,
        cwd: thread.cwd,
        title: thread.title,
        backendKind: thread.backendKind,
        deletedAt,
        purgeAt: deletedAt + this.retentionMs,
      };
      const folder = this.folder(thread.sessionId);
      if (thread.backendKind === "pi") {
        entry.originalPath = thread.path;
        entry.file = basename(thread.path);
        await moveFile(thread.path, join(folder, entry.file));
      } else {
        const backend = this.port.backend(thread.backendKind);
        if (!backend?.removeThread || !backend.restoreThread) throw new Error(`${backend?.label ?? thread.backendKind} threads cannot be deleted from Tau yet.`);
        const record = await backend.removeThread(thread.sessionId);
        try {
          await mkdir(folder, { recursive: true, mode: 0o700 });
          await writeFile(join(folder, "shell.json"), JSON.stringify(record ?? null), { mode: 0o600 });
        } catch (error) {
          await backend.restoreThread(thread.sessionId, record);
          throw error;
        }
        entry.shell = true;
      }
      this.entries.set(entry.sessionId, entry);
      await this.save();
      this.arm();
      return this.list().find((candidate) => candidate.sessionId === entry.sessionId)!;
    });
  }

  /** Puts a thread back where it was; refuses when something else took its place. */
  restore(sessionId: string): Promise<TrashedThread> {
    return this.serial(async () => {
      await this.load();
      const entry = this.entries.get(sessionId);
      if (!entry) throw new Error("This thread is no longer in the trash.");
      const folder = this.folder(sessionId);
      if (entry.file && entry.originalPath) {
        if (await exists(entry.originalPath)) throw new Error("A session file already sits where this thread was; it was not restored.");
        await moveFile(join(folder, entry.file), entry.originalPath);
      } else if (entry.shell) {
        const backend = this.port.backend(entry.backendKind);
        if (!backend?.restoreThread) throw new Error(`Turn ${entry.backendKind} on to restore this thread.`);
        const record = JSON.parse(await readFile(join(folder, "shell.json"), "utf8")) as unknown;
        await backend.restoreThread(sessionId, record);
      }
      this.entries.delete(sessionId);
      await this.save();
      await rm(folder, { recursive: true, force: true });
      this.arm();
      return entry;
    });
  }

  /** Removes a thread for good and tells the hooks; nothing outside the trash is touched. */
  purge(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const entry = this.entries.get(sessionId);
      if (!entry) return;
      this.entries.delete(sessionId);
      await this.save();
      await rm(this.folder(sessionId), { recursive: true, force: true });
      this.port.log("thread.purged", sessionId.slice(0, 8));
      try { await this.port.threadDeleted(sessionId, entry.cwd); }
      catch (error) { this.port.log("thread.deleted.failed", error instanceof Error ? error.message : String(error)); }
      this.arm();
    });
  }

  /** Purges what is due now and sleeps until the next entry is. */
  async purgeDue(): Promise<void> {
    await this.load();
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      // One at a time: each purge runs every hook.
      // oxlint-disable-next-line no-await-in-loop
      if (entry.purgeAt <= now) await this.purge(entry.sessionId);
    }
    this.arm();
  }

  /** Starts the timer; `dispose` stops it. */
  start(): void {
    void this.purgeDue().catch((error: unknown) => this.port.log("thread.purge.failed", error instanceof Error ? error.message : String(error)));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.size === 0) return;
    const next = Math.min(...[...this.entries.values()].map((entry) => entry.purgeAt));
    this.timer = setTimeout(() => this.start(), Math.min(MAX_PURGE_WAIT_MS, Math.max(0, next - this.now())));
    this.timer.unref?.();
  }

  private folder(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 120) || "thread";
    return join(this.options.dir, safe);
  }

  private save(): Promise<void> {
    return writePersistedJson(this.manifest, VERSION, { threads: [...this.entries.values()] }, this.options.logger ? { logger: this.options.logger } : {});
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next;
    return next;
  }
}
