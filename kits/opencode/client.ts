/**
 * The part of `opencode serve`'s HTTP API Tau speaks: health, providers,
 * sessions and their messages, prompts, permissions and questions, and the
 * event stream. Field names are OpenCode's own (`GET /doc` prints them).
 * Every call names the project folder in `directory`, which is how one server
 * serves several projects.
 */

export interface OpenCodeModelInfo {
  id: string;
  providerID?: string;
  name?: string;
  capabilities?: { reasoning?: boolean; attachment?: boolean; input?: { image?: boolean } };
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  limit?: { context?: number; output?: number };
  status?: string;
  release_date?: string;
  variants?: Record<string, unknown>;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  source?: string;
  models: Record<string, OpenCodeModelInfo>;
}

export interface OpenCodeProviderList {
  all: OpenCodeProvider[];
  /** Providers with a login, a key or no need for either. */
  connected: string[];
  /** Each provider's default model id. */
  default: Record<string, string>;
}

export interface OpenCodeAgent {
  name: string;
  mode?: string;
  hidden?: boolean;
}

export interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpenCodeSession {
  id: string;
  directory: string;
  title?: string;
  parentID?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  model?: { id: string; providerID: string; variant?: string };
  time?: { created?: number; updated?: number; archived?: number };
}

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

export type OpenCodePart = { id: string; messageID: string; sessionID: string; type: string } & Record<string, unknown>;

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  modelID?: string;
  providerID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; data?: { message?: string } };
  tokens?: OpenCodeTokens;
  cost?: number;
}

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export type OpenCodeFilePart = { type: "file"; mime: string; url: string; filename?: string };
export type OpenCodeInputPart = { type: "text"; text: string } | OpenCodeFilePart;

export interface OpenCodePromptBody {
  parts: OpenCodeInputPart[];
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  /** Added after OpenCode's own system prompt. */
  system?: string;
  /** Tools switched off (`false`) or on for this prompt, by OpenCode's tool id. */
  tools?: Record<string, boolean>;
}

/** One event of `GET /event`: `{ type, properties }`. */
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";
  constructor(readonly method: string, readonly path: string, readonly status: number, readonly body: string) {
    super(`OpenCode answered ${method} ${path} with ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
}

export interface OpenCodeClientOptions {
  url: string;
  /** The server's password (`OPENCODE_SERVER_PASSWORD`), sent as HTTP Basic auth for the user `opencode`. */
  password?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export class OpenCodeClient {
  readonly url: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly authorization?: string;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeClientOptions) {
    this.url = options.url.replace(/\/+$/u, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.password) this.authorization = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;
  }

  private address(path: string, query: Record<string, string | undefined> = {}): string {
    const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const tail = search.size ? `?${search.toString()}` : "";
    return `${this.url}${path}${tail}`;
  }

  private headers(json: boolean): Record<string, string> {
    return { accept: "application/json", ...(json ? { "content-type": "application/json" } : {}), ...(this.authorization ? { authorization: this.authorization } : {}) };
  }

  async request<T>(method: string, path: string, options: { query?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.fetcher(this.address(path, options.query), {
      method,
      headers: this.headers(options.body !== undefined),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new OpenCodeHttpError(method, path, response.status, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  health(): Promise<{ healthy: boolean; version: string }> {
    return this.request("GET", "/global/health", { timeoutMs: 5_000 });
  }

  providers(directory: string): Promise<OpenCodeProviderList> {
    return this.request("GET", "/provider", { query: { directory } });
  }

  /** The merged configuration the server runs with; `model` names its default as `provider/model`. */
  config(directory: string): Promise<{ model?: string }> {
    return this.request("GET", "/config", { query: { directory } });
  }

  agents(directory: string): Promise<OpenCodeAgent[]> {
    return this.request("GET", "/agent", { query: { directory } });
  }

  createSession(directory: string, body: { title?: string; permission?: OpenCodePermissionRule[] }): Promise<OpenCodeSession> {
    return this.request("POST", "/session", { query: { directory }, body });
  }

  getSession(directory: string, id: string): Promise<OpenCodeSession> {
    return this.request("GET", `/session/${encodeURIComponent(id)}`, { query: { directory } });
  }

  updateSession(directory: string, id: string, body: { title?: string; permission?: OpenCodePermissionRule[] }): Promise<OpenCodeSession> {
    return this.request("PATCH", `/session/${encodeURIComponent(id)}`, { query: { directory }, body });
  }

  /** Sessions of one project folder, newest first; `roots` leaves out sub-agents' sessions. */
  listSessions(query: { directory?: string; roots?: boolean; limit?: number } = {}): Promise<OpenCodeSession[]> {
    return this.request("GET", "/session", {
      query: {
        ...(query.directory ? { directory: query.directory } : {}),
        ...(query.roots ? { roots: "true" } : {}),
        ...(query.limit ? { limit: String(query.limit) } : {}),
      },
    });
  }

  /** Sessions of every project the server knows. */
  listAllSessions(query: { roots?: boolean; limit?: number } = {}): Promise<OpenCodeSession[]> {
    return this.request("GET", "/experimental/session", { query: { ...(query.roots ? { roots: "true" } : {}), ...(query.limit ? { limit: String(query.limit) } : {}) } });
  }

  messages(directory: string, id: string): Promise<OpenCodeMessage[]> {
    return this.request("GET", `/session/${encodeURIComponent(id)}/message`, { query: { directory } });
  }

  /** Queues the prompt and answers at once; the turn arrives on the event stream. */
  async promptAsync(directory: string, id: string, body: OpenCodePromptBody): Promise<void> {
    await this.request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, { query: { directory }, body });
  }

  async abort(directory: string, id: string): Promise<void> {
    await this.request("POST", `/session/${encodeURIComponent(id)}/abort`, { query: { directory } });
  }

  async replyPermission(directory: string, requestId: string, reply: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { query: { directory }, body: { reply, ...(message ? { message } : {}) } });
  }

  async replyQuestion(directory: string, requestId: string, answers: string[][]): Promise<void> {
    await this.request("POST", `/question/${encodeURIComponent(requestId)}/reply`, { query: { directory }, body: { answers } });
  }

  async rejectQuestion(directory: string, requestId: string): Promise<void> {
    await this.request("POST", `/question/${encodeURIComponent(requestId)}/reject`, { query: { directory } });
  }

  /**
   * Follows `GET /event` for one project folder until `close()` or the server
   * ends the stream; `onEnd` says which, with the error that ended it. The
   * answer resolves once the server accepted the subscription.
   */
  async subscribe(directory: string, onEvent: (event: OpenCodeEvent) => void, onEnd: (error?: Error) => void): Promise<{ close(): void }> {
    const controller = new AbortController();
    const response = await this.fetcher(this.address("/event", { directory }), {
      headers: { ...this.headers(false), accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      controller.abort();
      throw new OpenCodeHttpError("GET", "/event", response.status, await response.text().catch(() => ""));
    }
    let closed = false;
    const reader = response.body.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_EVENT_BYTES) throw new Error("OpenCode sent an event larger than 16 MiB.");
          let end: number;
          while ((end = buffer.search(/\r?\n\r?\n/u)) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/u, "");
            const event = parseEventBlock(block);
            if (event) onEvent(event);
          }
        }
        if (!closed) onEnd(new Error("OpenCode closed its event stream."));
      } catch (error) {
        if (!closed) onEnd(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    return {
      close: () => {
        if (closed) return;
        closed = true;
        controller.abort();
        onEnd();
      },
    };
  }
}

/** One SSE block: its `data:` lines joined, parsed as an OpenCode event. */
export function parseEventBlock(block: string): OpenCodeEvent | undefined {
  const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return undefined;
  try {
    const event = JSON.parse(data) as Partial<OpenCodeEvent>;
    if (typeof event?.type !== "string") return undefined;
    return { type: event.type, properties: event.properties && typeof event.properties === "object" ? event.properties : {} };
  } catch {
    return undefined;
  }
}
