import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { renameReplacing } from "../_shared/atomic-rename.js";
import { join } from "node:path";
import { HTML_PAGE_LIMITS } from "./protocol.js";

/** What a card needs beside the document. */
export interface PageMeta {
  title: string;
  /** The most the card may take, in CSS px. */
  maxHeight: number;
  /** https origins the page may load from. */
  origins: readonly string[];
  createdAt: number;
}

export interface StoredPage { id: string; meta: PageMeta; html: string }

export interface PageStoreOptions {
  directory: string;
  now?(): number;
  /** Tests lower these. */
  limits?: Partial<{ pagesPerThread: number; bytesPerThread: number }>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/u;

/** A thread id becomes a folder name; anything odd is hashed so it cannot climb out. */
function folderOf(threadId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(threadId) ? threadId : createHash("sha256").update(threadId).digest("hex").slice(0, 40);
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data);
    await renameReplacing(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Pages the agents of a thread showed, one folder per thread: `<id>.html` is
 * the document, `<id>.json` what the card needs. The JSON is written last, so
 * a document without one never counts. The oldest pages go first once a
 * thread holds too many.
 */
export class PageStore {
  private readonly now: () => number;
  private readonly limits: { pagesPerThread: number; bytesPerThread: number };
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PageStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { pagesPerThread: HTML_PAGE_LIMITS.pagesPerThread, bytesPerThread: HTML_PAGE_LIMITS.bytesPerThread, ...options.limits };
  }

  private folder(threadId: string): string {
    return join(this.options.directory, folderOf(threadId));
  }

  /** Writes to one thread's folder happen in turn, so the limits count what is really there. */
  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const key = folderOf(threadId);
    const next = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }

  async add(threadId: string, page: { meta: Omit<PageMeta, "createdAt">; html: string }): Promise<string> {
    return this.serial(threadId, async () => {
      const directory = this.folder(threadId);
      await mkdir(directory, { recursive: true });
      const id = randomBytes(9).toString("base64url");
      const meta: PageMeta = { ...page.meta, createdAt: this.now() };
      await atomicWrite(join(directory, `${id}.html`), page.html);
      await atomicWrite(join(directory, `${id}.json`), JSON.stringify(meta));
      await this.trim(directory, id);
      return id;
    });
  }

  async get(threadId: string, id: string): Promise<StoredPage | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    const directory = this.folder(threadId);
    try {
      const meta = JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")) as PageMeta;
      const html = await readFile(join(directory, `${id}.html`), "utf8");
      return { id, meta, html };
    } catch {
      return undefined;
    }
  }

  /** Every page of a thread, newest first. */
  list(threadId: string): Promise<Array<{ id: string; meta: PageMeta; bytes: number }>> {
    return this.listFolder(this.folder(threadId));
  }

  private async listFolder(directory: string): Promise<Array<{ id: string; meta: PageMeta; bytes: number }>> {
    let names: string[];
    try { names = await readdir(directory); } catch { return []; }
    const pages: Array<{ id: string; meta: PageMeta; bytes: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!SAFE_ID.test(id)) continue;
      try {
        const meta = JSON.parse(await readFile(join(directory, name), "utf8")) as PageMeta;
        const bytes = (await stat(join(directory, `${id}.html`))).size;
        pages.push({ id, meta, bytes });
      } catch { /* a half-written page does not count */ }
    }
    return pages.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  }

  async forgetThread(threadId: string): Promise<void> {
    await this.serial(threadId, () => rm(this.folder(threadId), { recursive: true, force: true }));
  }

  /** Drops the oldest pages until the thread is within its limits; the page just written stays. */
  private async trim(directory: string, keep: string): Promise<void> {
    const pages = await this.listFolder(directory);
    let count = pages.length;
    let bytes = pages.reduce((sum, page) => sum + page.bytes, 0);
    for (const page of [...pages].reverse()) {
      if (count <= this.limits.pagesPerThread && bytes <= this.limits.bytesPerThread) return;
      if (page.id === keep) continue;
      await rm(join(directory, `${page.id}.json`), { force: true });
      await rm(join(directory, `${page.id}.html`), { force: true });
      count -= 1;
      bytes -= page.bytes;
    }
  }
}
