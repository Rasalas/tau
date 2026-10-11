import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxFrameCsp, SandboxFramePermissions } from "tau/host-extension";
import { MCP_APP_LIMITS, type McpAppCallToolResult } from "./mcp-app-protocol.js";

/**
 * Captured MCP App documents, one folder per thread: `<item>.html` is the
 * document as the server sent it, `<item>.json` what the card needs beside it.
 * The JSON is written last, so a document without one never counts.
 */
export interface McpAppMeta {
  server: string;
  tool: string;
  resourceUri: string;
  csp?: SandboxFrameCsp;
  permissions?: SandboxFramePermissions;
  prefersBorder?: boolean;
  toolInput: unknown;
  toolResult?: McpAppCallToolResult;
  capturedAt: number;
}

export interface StoredMcpApp { meta: McpAppMeta; html: string }

export interface McpAppStoreOptions {
  directory: string;
  now?(): number;
  /** Tests lower these. */
  limits?: Partial<{ htmlBytes: number; appsPerThread: number; bytesPerThread: number; resultBytes: number }>;
}

/** Context and other bookkeeping files start with `_`, which no item name does. */
const CONTEXT_FILE = "_context.json";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const RESULT_BYTES = 1024 * 1024;

function safeName(id: string): string {
  return SAFE_ID.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 40);
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"); } catch { return Infinity; }
}

/** The result, shortened until it fits: `structuredContent` goes whole or not at all, then the rest. */
export function clipToolResult(result: McpAppCallToolResult | undefined, max: number): McpAppCallToolResult | undefined {
  if (!result || jsonBytes(result) <= max) return result;
  const { structuredContent: _dropped, ...rest } = result;
  if (jsonBytes(rest) <= max) return rest;
  return { content: [], ...(result.isError ? { isError: true } : {}) };
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class McpAppStore {
  private readonly now: () => number;
  private readonly limits: Required<NonNullable<McpAppStoreOptions["limits"]>>;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: McpAppStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = {
      htmlBytes: MCP_APP_LIMITS.htmlBytes,
      appsPerThread: MCP_APP_LIMITS.appsPerThread,
      bytesPerThread: MCP_APP_LIMITS.bytesPerThread,
      resultBytes: RESULT_BYTES,
      ...options.limits,
    };
  }

  private folder(threadId: string): string { return join(this.options.directory, safeName(threadId)); }
  private file(threadId: string, itemId: string, extension: "html" | "json"): string { return join(this.folder(threadId), `${safeName(itemId)}.${extension}`); }

  /** One writer per thread at a time; a failed job does not hold the next. */
  private exclusive<T>(threadId: string, job: () => Promise<T>): Promise<T> {
    const key = safeName(threadId);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return run;
  }

  /** Keeps the document and what the card needs; evicts the thread's oldest apps past the limits. */
  save(threadId: string, itemId: string, app: { html: string; meta: Omit<McpAppMeta, "capturedAt"> }): Promise<void> {
    if (Buffer.byteLength(app.html, "utf8") > this.limits.htmlBytes) return Promise.reject(new Error("The app's document is too large."));
    const meta: McpAppMeta = {
      ...app.meta,
      toolInput: jsonBytes(app.meta.toolInput) <= this.limits.resultBytes ? app.meta.toolInput : {},
      ...(app.meta.toolResult ? { toolResult: clipToolResult(app.meta.toolResult, this.limits.resultBytes)! } : {}),
      capturedAt: this.now(),
    };
    return this.exclusive(threadId, async () => {
      await mkdir(this.folder(threadId), { recursive: true });
      await atomicWrite(this.file(threadId, itemId, "html"), app.html);
      try { await atomicWrite(this.file(threadId, itemId, "json"), JSON.stringify(meta)); } catch (error) {
        await rm(this.file(threadId, itemId, "html"), { force: true }).catch(() => undefined);
        throw error;
      }
      await this.evict(threadId, safeName(itemId));
    });
  }

  private async evict(threadId: string, keep: string): Promise<void> {
    const folder = this.folder(threadId);
    const names = await readdir(folder);
    const apps: Array<{ name: string; at: number; bytes: number }> = [];
    for (const file of names) {
      const name = file.endsWith(".json") ? file.slice(0, -5) : undefined;
      if (name === undefined || file.startsWith("_")) {
        // Leftovers of a write that died, and a document whose metadata never landed.
        if (file.endsWith(".tmp") || (file.endsWith(".html") && !names.includes(`${file.slice(0, -5)}.json`))) await rm(join(folder, file), { force: true });
        continue;
      }
      try {
        const meta = JSON.parse(await readFile(join(folder, file), "utf8")) as { capturedAt?: unknown };
        const bytes = (await stat(join(folder, file))).size + (await stat(join(folder, `${name}.html`)).catch(() => ({ size: 0 }))).size;
        apps.push({ name, at: typeof meta.capturedAt === "number" ? meta.capturedAt : 0, bytes });
      } catch {
        await this.remove(folder, name);
      }
    }
    apps.sort((a, b) => a.at - b.at);
    let total = apps.reduce((sum, app) => sum + app.bytes, 0);
    let count = apps.length;
    for (const app of apps) {
      if (count <= this.limits.appsPerThread && total <= this.limits.bytesPerThread) break;
      if (app.name === keep) continue;
      await this.remove(folder, app.name);
      count -= 1;
      total -= app.bytes;
    }
  }

  private async remove(folder: string, name: string): Promise<void> {
    await rm(join(folder, `${name}.json`), { force: true });
    await rm(join(folder, `${name}.html`), { force: true });
  }

  async meta(threadId: string, itemId: string): Promise<McpAppMeta | undefined> {
    try {
      const meta = JSON.parse(await readFile(this.file(threadId, itemId, "json"), "utf8")) as McpAppMeta;
      return typeof meta?.server === "string" && typeof meta.tool === "string" && typeof meta.resourceUri === "string" ? meta : undefined;
    } catch { return undefined; }
  }

  async load(threadId: string, itemId: string): Promise<StoredMcpApp | undefined> {
    const meta = await this.meta(threadId, itemId);
    if (!meta) return undefined;
    try { return { meta, html: await readFile(this.file(threadId, itemId, "html"), "utf8") }; } catch { return undefined; }
  }

  async html(threadId: string, itemId: string): Promise<string | undefined> {
    return (await this.load(threadId, itemId))?.html;
  }

  /** What the thread's apps last told the model; see `mcp-app-context.ts`. */
  async readContexts(threadId: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(this.folder(threadId), CONTEXT_FILE), "utf8")); } catch { return undefined; }
  }

  writeContexts(threadId: string, value: unknown): Promise<void> {
    return this.exclusive(threadId, async () => {
      await mkdir(this.folder(threadId), { recursive: true });
      await atomicWrite(join(this.folder(threadId), CONTEXT_FILE), JSON.stringify(value));
    });
  }

  /** The thread is gone for good. */
  forgetThread(threadId: string): Promise<void> {
    return this.exclusive(threadId, () => rm(this.folder(threadId), { recursive: true, force: true }));
  }
}
