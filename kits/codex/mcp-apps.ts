import type { BackendPrompt, ExtensionUiAnswer } from "tau/host-extension";
import type { CodexMcpResourceRead } from "./app-server.js";
import type { McpAppCapture } from "./events.js";
import { readAppDocument } from "./mcp-app-document.js";
import type { McpAppStore, StoredMcpApp } from "./mcp-app-store.js";
import type { CodexSessionLike } from "./thread-backend.js";

/** A live Codex session of a thread, with the Codex thread id its requests name. */
export interface McpAppSession { session: CodexSessionLike; codexThreadId: string }

/** What the kit's host half may do on a thread; never starts a session. */
export interface McpAppThread {
  live(): McpAppSession | undefined;
  ask?(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
}

/** How a capture reads the document: the session that reported the item. */
export interface McpAppReader {
  codexThreadId: string;
  read(params: { threadId: string; server: string; uri: string; originCallId: string }): Promise<CodexMcpResourceRead>;
}

export type McpAppOpening = { state: "pending" } | { state: "unavailable"; reason: string } | { state: "ready"; app: StoredMcpApp };

/** How long `open` waits for a document that is still being read. */
const OPEN_WAIT_MS = 20_000;

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

/** Captures the apps of finished tool calls and keeps what could not be captured. */
export class McpApps {
  private readonly running = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly store: McpAppStore, private readonly options: { openWaitMs?: number; log?(message: string): void } = {}) {}

  private static key(threadId: string, itemId: string): string { return JSON.stringify([threadId, itemId]); }

  /** Reads and stores the document in the background; a failure is recorded and never reaches the turn. */
  capture(threadId: string, capture: McpAppCapture, reader: McpAppReader): void {
    const key = McpApps.key(threadId, capture.itemId);
    if (this.running.has(key)) return;
    const job = this.read(threadId, capture, reader)
      .then(() => { this.failures.delete(key); })
      .catch((error: unknown) => {
        this.failures.set(key, describe(error));
        this.options.log?.(`${capture.server}: ${describe(error)}`);
      })
      .finally(() => { this.running.delete(key); });
    this.running.set(key, job);
  }

  private async read(threadId: string, capture: McpAppCapture, reader: McpAppReader): Promise<void> {
    const answer = await reader.read({ threadId: reader.codexThreadId, originCallId: capture.itemId, server: capture.server, uri: capture.resourceUri });
    const parsed = readAppDocument(answer, capture.resourceUri);
    if ("reason" in parsed) throw new Error(parsed.reason);
    const { html, ...declared } = parsed.document;
    const result = capture.result;
    await this.store.save(threadId, capture.itemId, {
      html,
      meta: {
        server: capture.server,
        tool: capture.tool,
        resourceUri: capture.resourceUri,
        ...declared,
        toolInput: capture.arguments,
        ...(result ? { toolResult: { content: result.content ?? [], ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(result["_meta"] !== undefined ? { "_meta": result["_meta"] } : {}) } } : {}),
      },
    });
  }

  /** The stored app; waits for a read still running, up to `openWaitMs`. */
  async open(threadId: string, itemId: string): Promise<McpAppOpening> {
    const key = McpApps.key(threadId, itemId);
    const job = this.running.get(key);
    if (job) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        job.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.openWaitMs ?? OPEN_WAIT_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      if (!finished) return { state: "pending" };
    }
    const app = await this.store.load(threadId, itemId);
    if (app) return { state: "ready", app };
    return { state: "unavailable", reason: this.failures.get(key) ?? "This app was not saved." };
  }

  forgetThread(threadId: string): void {
    for (const key of [...this.failures.keys()]) if ((JSON.parse(key) as string[])[0] === threadId) this.failures.delete(key);
  }
}
