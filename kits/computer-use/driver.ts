import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export type { Tool as ComputerUseTool } from "@modelcontextprotocol/sdk/types.js";

export interface ComputerUseDriverConfig {
  mode?: "bundled" | "path";
  binaryPath?: string;
  extraArgs?: string[];
}
export interface ComputerUseDriverResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}
interface NativeResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface ComputerUseClient {
  listAllTools(signal?: AbortSignal): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<NativeResult>;
  close(): Promise<void>;
}
export interface ComputerUseDriverDependencies {
  platform?: NodeJS.Platform;
  createClient?: (config: ComputerUseDriverConfig) => ComputerUseClient;
  loadManifest?: () => Promise<Tool[]>;
}

/** This generated resource is shipped by the exactly pinned dependency but has no public export. */
export async function loadComputerUseManifest(packageRoot: string): Promise<Tool[]> {
  const packagePath = join(packageRoot, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { version: string };
  if (pkg.version !== "0.1.12") throw new Error(`Unsupported Computer Use manifest version: ${pkg.version}`);
  const module = await import(/* @vite-ignore */ pathToFileURL(join(packageRoot, "dist/generated/cua-driver-tools.js")).href) as { default: { tools: Tool[] } };
  return structuredClone(module.default.tools);
}

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_DETAILS_BYTES = 24 * 1024;
function boundedText(value: string, budget: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= budget) return value;
  if (budget < 32) return "";
  return `${bytes.subarray(0, Math.max(0, budget - 32)).toString("utf8")}\n[Output truncated]`;
}
function boundedDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || Buffer.byteLength(JSON.stringify(value)) <= MAX_DETAILS_BYTES) return value;
  const details = { ...value, truncated: true } as Record<string, unknown>;
  // Retain capture coordinates and screenshot paths used by the workbench feed.
  if (typeof details.tree_markdown === "string") details.tree_markdown = boundedText(details.tree_markdown, 8 * 1024);
  if (Array.isArray(details.elements)) {
    const elements = details.elements;
    details.total_elements = elements.length;
    let keep = elements.length;
    do {
      keep = Math.floor(keep / 2);
      details.elements = elements.slice(0, keep);
    } while (keep && Buffer.byteLength(JSON.stringify(details)) > MAX_DETAILS_BYTES);
  }
  for (const [key, item] of Object.entries(details)) {
    if (Buffer.byteLength(JSON.stringify(details)) <= MAX_DETAILS_BYTES) break;
    if (typeof item === "string" && Buffer.byteLength(item) > 1024) details[key] = boundedText(item, 1024);
  }
  if (Buffer.byteLength(JSON.stringify(details)) <= MAX_DETAILS_BYTES) return details;
  // Large platform lists and nested outputs can exceed the budget even after AX trimming.
  const bounded: Record<string, unknown> = { truncated: true, original_bytes: Buffer.byteLength(JSON.stringify(value)) };
  for (const key of ["pid", "window_id", "screenshot_width", "screenshot_height", "screenshot_file_path", "screenshot_path", "screenshot", "bounds", "capture_scope", "total_elements"]) {
    const item = details[key];
    if (item !== undefined && Buffer.byteLength(JSON.stringify(item)) <= 2048) bounded[key] = item;
  }
  // Keep usable initial window/element entries for screen names and snapshot coordinates.
  for (const key of ["elements", "windows"]) {
    const items = details[key];
    if (!Array.isArray(items)) continue;
    const kept: unknown[] = [];
    bounded[key] = kept;
    for (const item of items) {
      kept.push(item);
      if (Buffer.byteLength(JSON.stringify(bounded)) > MAX_DETAILS_BYTES / 2) { kept.pop(); break; }
    }
  }
  let previewBudget = Math.max(0, MAX_DETAILS_BYTES - Buffer.byteLength(JSON.stringify(bounded)) - 256);
  const serialized = JSON.stringify(value);
  while (previewBudget > 0) {
    bounded.preview = boundedText(serialized, previewBudget);
    if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_DETAILS_BYTES) return bounded;
    previewBudget = Math.floor(previewBudget / 2);
  }
  delete bounded.preview;
  return bounded;
}
function convertResult(result: NativeResult): ComputerUseDriverResult {
  const content: ComputerUseDriverResult["content"] = [];
  const details = boundedDetails(result.structuredContent);
  const structuredText = details ? JSON.stringify(details) : undefined;
  // MCP transports content, while the workbench separately reads details. Reserve room for both.
  let textBudget = MAX_TEXT_BYTES - (structuredText ? Buffer.byteLength(structuredText) : 0);
  for (const item of result.content ?? []) {
    if (item.type === "text" && item.text !== undefined && item.text.trim() !== structuredText && textBudget > 0) {
      const text = boundedText(item.text, textBudget);
      content.push({ type: "text", text });
      textBudget = Math.max(0, textBudget - Buffer.byteLength(text));
    }
    if (item.type === "image" && item.data) content.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
  }
  if (structuredText) content.push({ type: "text", text: structuredText });
  if (!content.length) content.push({ type: "text", text: "Action executed." });
  return { content, details, ...(result.isError ? { isError: true } : {}) };
}

/** One thread's native driver. Pi and MCP use this same queue and lifecycle. */
export class ComputerUseDriverSession {
  private readonly lifecycle = new AbortController();
  private readonly platform: NodeJS.Platform;
  private readonly createClient: NonNullable<ComputerUseDriverDependencies["createClient"]>;
  private readonly loadManifest: NonNullable<ComputerUseDriverDependencies["loadManifest"]>;
  private client?: ComputerUseClient;
  private tools?: Tool[];
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly config: ComputerUseDriverConfig;

  constructor(config: ComputerUseDriverConfig = {}, dependencies: ComputerUseDriverDependencies = {}) {
    this.config = structuredClone(config);
    this.platform = dependencies.platform ?? process.platform;
    this.createClient = dependencies.createClient ?? (() => { throw new Error("Computer Use native client must be supplied by the host dependency loader."); });
    this.loadManifest = dependencies.loadManifest ?? (() => { throw new Error("Computer Use manifest loader must be supplied by the host dependency loader."); });
  }

  private enqueue<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    const operation = this.tail.then(() => {
      combined.throwIfAborted();
      return run(combined);
    });
    this.tail = operation.catch(() => undefined);
    // A queued caller can cancel immediately, while the queue still retains the active operation.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      if (combined.aborted) { abort(); return; }
      combined.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
    });
  }

  private getClient(): ComputerUseClient {
    return this.client ??= this.createClient(this.config);
  }

  listTools(signal?: AbortSignal): Promise<Tool[]> {
    return this.enqueue(async (activeSignal) => {
      if (!this.tools) this.tools = this.platform === "darwin"
        ? await this.loadManifest()
        : await this.getClient().listAllTools(activeSignal);
      activeSignal.throwIfAborted();
      return structuredClone(this.tools);
    }, signal);
  }

  /** Refreshes the live platform contract; failed discovery is retryable on the same session. */
  discoverTools(signal?: AbortSignal): Promise<Tool[]> {
    return this.enqueue(async (activeSignal) => {
      const tools = await this.getClient().listAllTools(activeSignal);
      activeSignal.throwIfAborted();
      this.tools = tools;
      return structuredClone(tools);
    }, signal);
  }

  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerUseDriverResult> {
    return this.enqueue(async (activeSignal) => convertResult(await this.getClient().callTool(name, args, activeSignal)), signal);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.lifecycle.abort(new Error("Computer Use session closed."));
      // Closing the transport interrupts an active call before waiting for the queue to drain.
      this.closing = (async () => {
        try { await this.client?.close(); }
        finally { await this.tail; }
      })();
    }
    return this.closing;
  }
}

export class ComputerUseDriverSessions {
  private readonly sessions = new Map<string, ComputerUseDriverSession>();
  constructor(private readonly dependencies: ComputerUseDriverDependencies = {}) {}
  forThread(threadId: string, config: ComputerUseDriverConfig = {}): ComputerUseDriverSession {
    let session = this.sessions.get(threadId);
    if (!session) {
      session = new ComputerUseDriverSession(config, this.dependencies);
      this.sessions.set(threadId, session);
    }
    return session;
  }
  async closeThread(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    await session?.close();
  }
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(sessions.map((session) => session.close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Computer Use sessions could not close.");
  }
}
