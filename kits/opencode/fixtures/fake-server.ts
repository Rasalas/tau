import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import recorded from "./turn-events.json" with { type: "json" };

/**
 * An OpenCode server for tests, in this process: the routes the kit speaks,
 * Basic auth, and an event stream that replays turns recorded from
 * opencode 1.18.32 (`turn-events.json`) or a script a test hands in. Nothing
 * here waits on a clock: a script that asks waits for the reply instead.
 */

export type FakeEvent = { type: string; properties: Record<string, unknown> };

export interface FakeTurn {
  session: FakeSession;
  body: Record<string, unknown>;
  emit(event: FakeEvent): void;
  /** Resolves with the reply once the kit answered this permission or question. */
  ask(kind: "permission" | "question", properties: Record<string, unknown>): Promise<unknown>;
  /** Resolves when the kit aborts the session. */
  aborted: Promise<void>;
  /** The user message OpenCode would store, and the ids to use. */
  userMessageId: string;
  assistantMessageId: string;
}

export type FakeScript = (turn: FakeTurn) => Promise<void> | void;

export interface FakeSession {
  id: string;
  directory: string;
  title: string;
  permission?: unknown;
  parentID?: string;
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost: number;
  time: { created: number; updated: number };
}

export interface FakeRequest { method: string; path: string; query: Record<string, string>; body?: unknown }

export interface FakeOpenCodeOptions {
  password?: string;
  version?: string;
  providers?: unknown;
  config?: Record<string, unknown>;
  /** What each prompt does; the recorded one-word reply by default. */
  script?: FakeScript;
}

export interface FakeOpenCode {
  url: string;
  password?: string;
  requests: FakeRequest[];
  sessions: Map<string, FakeSession>;
  /** Clients following the event stream right now. */
  readonly listeners: number;
  script: FakeScript;
  /** Sends an event to every stream, as the server would on its own. */
  broadcast(event: FakeEvent): void;
  addSession(session: Partial<FakeSession> & { id: string; directory: string }): FakeSession;
  close(): Promise<void>;
}

export const FAKE_PROVIDERS = {
  all: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      source: "custom",
      models: {
        "big-pickle": { id: "big-pickle", providerID: "opencode", name: "Big Pickle", capabilities: { reasoning: true, attachment: false, input: { image: false } }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", variants: {} },
        "gpt-5.6-luna": { id: "gpt-5.6-luna", providerID: "opencode", name: "GPT-5.6 Luna", capabilities: { reasoning: true, attachment: true, input: { image: true } }, cost: { input: 0.2, output: 1.2, cache: { read: 0.02, write: 0 } }, limit: { context: 400000, output: 128000 }, status: "active", variants: { low: {}, medium: {}, high: {} } },
        "old-model": { id: "old-model", providerID: "opencode", name: "Old", cost: { input: 1, output: 2, cache: { read: 0, write: 0 } }, limit: { context: 1000, output: 100 }, status: "deprecated" },
      },
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "custom",
      models: { "gpt-5.5": { id: "gpt-5.5", providerID: "github-copilot", name: "GPT-5.5", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 128000, output: 16000 }, status: "active", variants: { high: {} } } },
    },
    { id: "anthropic", name: "Anthropic", source: "env", models: { "claude-x": { id: "claude-x", name: "Claude X", cost: { input: 3, output: 15 }, limit: { context: 200000, output: 64000 } } } },
  ],
  connected: ["opencode", "github-copilot"],
  default: { opencode: "big-pickle", "github-copilot": "gpt-5.5", anthropic: "claude-x" },
};

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake${String(++counter).padStart(6, "0")}`;

/** A recorded turn with its ids and folders replaced by this session's. */
export function recordedTurn(name: "reply" | "tool", session: FakeSession): FakeEvent[] {
  const text = JSON.stringify(recorded[name])
    .replaceAll("$SESSION", session.id)
    .replaceAll("$DIR", session.directory)
    .replaceAll("$ROOT", session.directory)
    .replaceAll("$PATH", ".");
  return JSON.parse(text) as FakeEvent[];
}

/** Replays a recorded turn; the tool turn waits for the kit to answer its permission request. */
export function replay(name: "reply" | "tool"): FakeScript {
  return async (turn) => {
    for (const event of recordedTurn(name, turn.session)) {
      if (event.type === "permission.replied") continue;
      if (event.type === "permission.asked") {
        const reply = await turn.ask("permission", event.properties);
        turn.emit({ type: "permission.replied", properties: { sessionID: turn.session.id, requestID: event.properties.id, reply } });
        continue;
      }
      turn.emit(event);
    }
  };
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export async function startFakeOpenCode(options: FakeOpenCodeOptions = {}): Promise<FakeOpenCode> {
  const requests: FakeRequest[] = [];
  const sessions = new Map<string, FakeSession>();
  const streams = new Set<ServerResponse>();
  const pending = new Map<string, (reply: unknown) => void>();
  const aborts = new Map<string, () => void>();
  const expected = options.password ? `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}` : undefined;

  const broadcast = (event: FakeEvent) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const addSession = (input: Partial<FakeSession> & { id: string; directory: string }): FakeSession => {
    const now = Date.now();
    const session: FakeSession = { title: "New session", messages: [], tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, time: { created: now, updated: now }, ...input };
    sessions.set(session.id, session);
    return session;
  };
  const view = (session: FakeSession) => ({ id: session.id, slug: session.id, projectID: "fake", directory: session.directory, title: session.title, version: options.version ?? "1.18.32", cost: session.cost, tokens: session.tokens, time: session.time, ...(session.parentID ? { parentID: session.parentID } : {}), ...(session.permission ? { permission: session.permission } : {}) });

  const fake: FakeOpenCode = {
    url: "",
    ...(options.password ? { password: options.password } : {}),
    requests,
    sessions,
    get listeners() { return streams.size; },
    script: options.script ?? replay("reply"),
    broadcast,
    addSession,
    close: () => new Promise<void>((resolve) => {
      for (const stream of streams) stream.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };

  const runTurn = async (session: FakeSession, body: Record<string, unknown>) => {
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => { abort = resolve; });
    aborts.set(session.id, abort);
    const userMessageId = nextId("msg");
    const text = (body.parts as Array<{ type: string; text?: string }> | undefined)?.find((part) => part.type === "text")?.text ?? "";
    session.messages.push({ info: { id: userMessageId, sessionID: session.id, role: "user", time: { created: Date.now() } }, parts: [{ id: nextId("prt"), type: "text", text }] });
    broadcast({ type: "message.updated", properties: { sessionID: session.id, info: { id: userMessageId, sessionID: session.id, role: "user", time: { created: Date.now() } } } });
    broadcast({ type: "session.status", properties: { sessionID: session.id, status: { type: "busy" } } });
    const turn: FakeTurn = {
      session,
      body,
      emit: (event) => {
        if (event.type === "session.updated") {
          const info = event.properties.info as { tokens?: FakeSession["tokens"]; cost?: number } | undefined;
          if (info?.tokens) session.tokens = info.tokens;
          if (typeof info?.cost === "number") session.cost = info.cost;
        }
        if (event.type === "message.part.updated") {
          const part = event.properties.part as { messageID?: string; type?: string; text?: string };
          if (part.type === "text" && part.text && part.messageID) {
            const message = session.messages.find((entry) => entry.info.id === part.messageID) ?? (session.messages.push({ info: { id: part.messageID, sessionID: session.id, role: "assistant", time: { created: Date.now() } }, parts: [] }), session.messages.at(-1)!);
            message.parts = [...message.parts.filter((entry) => entry.id !== (part as { id?: string }).id), part as Record<string, unknown>];
          }
        }
        broadcast(event);
      },
      ask: (kind, properties) => new Promise((resolve) => {
        pending.set(String(properties.id), resolve);
        broadcast({ type: `${kind}.asked`, properties });
      }),
      aborted,
      userMessageId,
      assistantMessageId: nextId("msg"),
    };
    await fake.script(turn);
    aborts.delete(session.id);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === "POST" || request.method === "PATCH" ? await readBody(request) : undefined;
      requests.push({ method: request.method ?? "GET", path: url.pathname, query, ...(body !== undefined ? { body } : {}) });
      if (expected && request.headers.authorization !== expected) return send(response, 401, { error: "unauthorized" });
      const path = url.pathname;
      const sessionRoute = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort))?$/u.exec(path);
      if (path === "/global/health") return send(response, 200, { healthy: true, version: options.version ?? "1.18.32" });
      if (path === "/provider") return send(response, 200, options.providers ?? FAKE_PROVIDERS);
      if (path === "/config") return send(response, 200, options.config ?? {});
      if (path === "/agent") return send(response, 200, [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }]);
      if (path === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (path === "/session" && request.method === "POST") {
        const input = (body ?? {}) as { title?: string; permission?: unknown };
        const session = addSession({ id: nextId("ses"), directory: query.directory ?? "/", ...(input.title ? { title: input.title } : {}), ...(input.permission ? { permission: input.permission } : {}) });
        broadcast({ type: "session.created", properties: { sessionID: session.id, info: view(session) } });
        return send(response, 200, view(session));
      }
      if (path === "/session" || path === "/experimental/session") {
        const list = [...sessions.values()].filter((session) => path !== "/session" || !query.directory || session.directory === query.directory);
        return send(response, 200, list.filter((session) => query.roots !== "true" || !session.parentID).sort((a, b) => b.time.updated - a.time.updated).map(view));
      }
      const permission = /^\/permission\/([^/]+)\/reply$/u.exec(path);
      const question = /^\/question\/([^/]+)\/(reply|reject)$/u.exec(path);
      const answer = permission ?? question;
      if (answer) {
        const resolve = pending.get(answer[1]!);
        pending.delete(answer[1]!);
        resolve?.(permission ? (body as { reply?: unknown }).reply : answer[2] === "reject" ? { rejected: true } : (body as { answers?: unknown }).answers);
        return send(response, 200, Boolean(resolve));
      }
      if (sessionRoute) {
        const session = sessions.get(decodeURIComponent(sessionRoute[1]!));
        if (!session) return send(response, 404, { name: "NotFoundError", data: { message: "Session not found" } });
        switch (sessionRoute[2]) {
          case undefined:
            if (request.method === "PATCH") {
              const patch = (body ?? {}) as { title?: string; permission?: unknown };
              if (patch.title) session.title = patch.title;
              if (patch.permission) session.permission = patch.permission;
            }
            return send(response, 200, view(session));
          case "message": return send(response, 200, session.messages);
          case "prompt_async":
            send(response, 204);
            // OpenCode answers a prompt that arrives while it works in the same run.
            if (!aborts.has(session.id)) void runTurn(session, (body ?? {}) as Record<string, unknown>);
            return;
          case "abort":
            aborts.get(session.id)?.();
            return send(response, 200, true);
        }
      }
      send(response, 404, { error: `no route ${request.method} ${path}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** A turn that runs a tool until the kit aborts it, then ends the way OpenCode ends an aborted one. */
export const untilAborted: FakeScript = async (turn) => {
  const { session, assistantMessageId: message } = turn;
  turn.emit({ type: "message.updated", properties: { sessionID: session.id, info: { id: message, sessionID: session.id, role: "assistant", providerID: "opencode", modelID: "big-pickle", time: { created: Date.now() } } } });
  turn.emit({ type: "message.part.updated", properties: { sessionID: session.id, part: { id: "prt_sleep", messageID: message, sessionID: session.id, type: "tool", tool: "bash", callID: "call_sleep", state: { status: "running", input: { command: "sleep 100" }, time: { start: 1 } } } } });
  await turn.aborted;
  turn.emit({ type: "message.updated", properties: { sessionID: session.id, info: { id: message, sessionID: session.id, role: "assistant", time: { created: 1 }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } });
  turn.emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "idle" } } });
  turn.emit({ type: "session.idle", properties: { sessionID: session.id } });
};
