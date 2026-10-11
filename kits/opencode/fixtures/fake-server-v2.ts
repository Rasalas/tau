import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import recorded from "./turn-events-v2.json" with { type: "json" };

/**
 * An OpenCode 2 server for tests, in this process: the `/api` routes the kit
 * speaks, Basic auth, and one event stream for every session. Shapes follow
 * the recordings in `turn-events-v2.json` (opencode 2.0.26). A prompt runs a
 * script that emits events; nothing waits on a clock, a script that asks waits
 * for the client's reply instead.
 */

type Json = Record<string, unknown>;

export interface FakeRequest2 { method: string; path: string; query: Record<string, string>; body?: unknown }

export interface ModelRef2 { id: string; providerID: string; variant?: string }
export interface Tokens2 { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export interface PromptBody2 { id?: string; text: string; files?: unknown[]; delivery?: "steer" | "queue" }

/** A prompt that reached a session while its script ran. */
export interface PendingPrompt2 { id: string; text: string; files?: unknown[]; delivery: "steer" | "queue" }

export interface FakeSession2 {
  id: string;
  directory: string;
  title?: string;
  model?: ModelRef2;
  agent?: string;
  permissions?: unknown[];
  parentID?: string;
  metadata?: Json;
  cost: number;
  tokens: Tokens2;
  time: { created: number; updated: number; idle?: number };
  outcome?: "succeeded" | "failed" | "interrupted";
  /** The messages `GET /api/session/:id/message` lists, oldest first. */
  messages: unknown[];
  running: boolean;
  instructionEntries: Record<string, unknown>;
  /** Prompts sent while a script ran, in arrival order, until a script takes them. */
  pendingPrompts: PendingPrompt2[];
}

export interface FakeTurn2 {
  session: FakeSession2;
  body: PromptBody2;
  /** The id of the user message this prompt stores. */
  inboxId: string;
  assistantMessageId: string;
  /** What the session runs with: its own choice, else the server default. */
  model: Required<ModelRef2>;
  agent: string;
  /** Sends an event to every stream; `location` defaults to the session's folder except where the real server sends none. */
  emit(type: string, data?: Json, options?: { location?: boolean }): void;
  /** Sends `permission.asked` or `form.created` and resolves with the client's reply body. */
  ask(kind: "permission" | "form", payload: Json): Promise<unknown>;
  /** Resolves with the next prompt that arrives while this script runs. */
  nextPrompt(): Promise<PendingPrompt2>;
  /** Resolves when the client interrupts the session. */
  aborted: Promise<void>;
}

export type FakeScript2 = (turn: FakeTurn2) => Promise<void> | void;

export interface FakeOpenCode2Options {
  password?: string;
  version?: string;
  providers?: unknown[];
  models?: unknown[];
  /** `provider/id`; the first active model when absent. */
  defaultModel?: string;
  agents?: unknown[];
  config?: unknown[];
  mcp?: unknown[];
  /** What each prompt does; a one-word reply by default. */
  script?: FakeScript2;
}

export interface FakeOpenCode2 {
  url: string;
  password?: string;
  requests: FakeRequest2[];
  sessions: Map<string, FakeSession2>;
  script: FakeScript2;
  /** Clients following the event stream right now. */
  readonly listeners: number;
  /** Sends an event to every stream, as the server would on its own. */
  broadcast(type: string, data: Json, location?: { directory: string }): void;
  addSession(input: Partial<FakeSession2> & { id: string; directory: string }): FakeSession2;
  close(): Promise<void>;
}

const PACKAGE = "@opencode/ai/providers/openai-compatible";
const ZEN = "https://opencode.ai/zen/v1";

function fakeModel(providerID: string, id: string, name: string, extra: Json = {}): Json {
  return {
    id, modelID: id, providerID, name, package: PACKAGE, settings: { baseURL: ZEN, provider: providerID },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [], time: { released: 1791244800000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active", enabled: true, limit: { context: 262144, output: 32768 },
    ...extra,
  };
}

const efforts = ["low", "medium", "high"].map((id) => ({ id, settings: { reasoningEffort: id } }));

export const FAKE_MODELS_V2: Json[] = [
  fakeModel("opencode", "space-bunny-free", "Space Bunny Free", { variants: efforts }),
  fakeModel("opencode", "exo-free", "Exo Free", { variants: [efforts[2]], limit: { context: 1048576, output: 131072 } }),
  fakeModel("opencode", "old-model", "Old Model", { status: "deprecated", limit: { context: 1000, output: 100 } }),
  fakeModel("github-copilot", "gpt-5.5", "GPT-5.5", {
    variants: [efforts[2]],
    cost: [{ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }],
    limit: { context: 400000, output: 128000 },
  }),
];

export const FAKE_PROVIDERS_V2: Json[] = [
  { id: "opencode", integrationID: "opencode", name: "OpenCode Zen", activation: "enabled", package: PACKAGE, settings: {} },
  { id: "github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", activation: "enabled", package: PACKAGE, settings: {} },
];

const FAKE_AGENTS_V2: Json[] = [
  { id: "build", name: "Build", mode: "primary" },
  { id: "plan", name: "Plan", mode: "primary" },
  { id: "general", name: "General", mode: "subagent" },
].map((agent) => ({ ...agent, request: { settings: {}, headers: {}, body: {} }, hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] }));

const ZERO_TOKENS: Tokens2 = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const NO_LOCATION = (type: string) => type.startsWith("session.execution.") || type === "session.usage.updated";
const TERMINAL = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake${String(++counter).padStart(6, "0")}`;
let clock = 0;
const now = () => (clock = Math.max(clock + 1, Date.now()));

const asRecord = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const sumTokens = (a: Tokens2, b: Tokens2): Tokens2 => ({
  input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
});

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const offset = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: number }).offset;
    return typeof offset === "number" && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

/** One page of `items` the way the list routes return it; the next cursor is null once a page is empty. */
function paginate<T>(items: T[], query: Record<string, string>): { data: T[]; cursor: { previous: string | null; next: string | null } } {
  const offset = decodeCursor(query.cursor);
  const limit = Number(query.limit) > 0 ? Number(query.limit) : 100;
  const data = items.slice(offset, offset + limit);
  return { data, cursor: { previous: offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null, next: data.length ? encodeCursor(offset + data.length) : null } };
}

interface Pending { kind: "permission" | "form"; session: FakeSession2; data: Json; resolve: (reply: unknown) => void }

export async function startFakeOpenCode2(options: FakeOpenCode2Options = {}): Promise<FakeOpenCode2> {
  const requests: FakeRequest2[] = [];
  const sessions = new Map<string, FakeSession2>();
  const streams = new Set<ServerResponse>();
  const pending = new Map<string, Pending>();
  const inbox = new Map<string, Json>();
  const runs = new Set<string>();
  const aborts = new Map<string, () => void>();
  const waiters = new Map<string, Array<(prompt: PendingPrompt2) => void>>();
  const version = options.version ?? "2.0.26";
  const models = options.models ?? FAKE_MODELS_V2;
  const expected = options.password ? `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}` : undefined;

  const defaultModel = (): ModelRef2 => {
    const [providerID, ...rest] = (options.defaultModel ?? "").split("/");
    if (options.defaultModel && providerID && rest.length) return { providerID, id: rest.join("/") };
    const first = models.map(asRecord).find((model) => model.status === "active" && model.enabled !== false) ?? asRecord(models[0]);
    return { id: asString(first.id) ?? "space-bunny-free", providerID: asString(first.providerID) ?? "opencode" };
  };

  const broadcast = (type: string, data: Json, location?: { directory: string }, at = now()) => {
    const event = { id: nextId("evt"), created: at, type, ...(location ? { location } : {}), data };
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const messages = (session: FakeSession2) => session.messages as Json[];
  const pushUser = (session: FakeSession2, id: string, item: Json) => {
    if (messages(session).some((message) => message.id === id)) return;
    const payload = asRecord(item.payload);
    const text = asString(payload.text) ?? "";
    messages(session).push(item.type === "synthetic"
      ? { id, time: { created: now() }, text, type: "synthetic" }
      : { id, time: { created: now() }, text, ...(payload.files ? { files: payload.files } : {}), type: "user" });
  };

  /** Keeps the session and its message list in step with an event, as the real server's projectors do. */
  const apply = (session: FakeSession2, type: string, data: Json) => {
    const assistant = () => messages(session).find((message) => message.id === data.assistantMessageID && message.type === "assistant");
    const tool = () => (assistant()?.content as Json[] | undefined)?.find((part) => part.type === "tool" && part.id === data.id);
    const at = now();
    session.time.updated = at;
    switch (type) {
      case "session.execution.started":
        session.running = true;
        delete session.outcome;
        delete session.time.idle;
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const outcome = type.slice("session.execution.".length) as NonNullable<FakeSession2["outcome"]>;
        session.running = false;
        session.outcome = outcome;
        session.time.idle = at;
        messages(session).push({ id: nextId("msg"), time: { created: at }, type: "idle", outcome });
        break;
      }
      case "session.usage.updated":
        if (typeof data.cost === "number") session.cost = data.cost;
        if (data.tokens) session.tokens = data.tokens as Tokens2;
        break;
      case "session.inbox.enqueued":
        inbox.set(String(data.inboxID), asRecord(data.item));
        break;
      case "session.inbox.delivered": {
        const item = inbox.get(String(data.inboxID));
        if (item) pushUser(session, String(data.inboxID), item);
        break;
      }
      case "session.renamed":
        session.title = String(data.title);
        break;
      case "session.model.selected":
        messages(session).push({ id: nextId("msg"), time: { created: at }, type: "model-switched", model: data.model, ...(data.previous ? { previous: data.previous } : {}) });
        session.model = data.model as ModelRef2;
        break;
      case "session.agent.selected":
        messages(session).push({ id: nextId("msg"), time: { created: at }, type: "agent-switched", agent: data.agent, ...(session.agent ? { previous: session.agent } : {}) });
        session.agent = String(data.agent);
        break;
      case "session.step.started":
        messages(session).push({ id: data.assistantMessageID, time: { created: typeof data.started === "number" ? data.started : at }, type: "assistant", agent: data.agent, model: data.model, content: [] });
        break;
      case "session.step.streamed": {
        const message = assistant();
        if (message) (message.time as Json).streamed = at;
        break;
      }
      case "session.step.ended": {
        const message = assistant();
        if (!message) break;
        Object.assign(message, { finish: data.finish, rawFinish: data.rawFinish, cost: data.cost, tokens: data.tokens });
        (message.time as Json).completed = at;
        break;
      }
      case "session.text.ended":
        (assistant()?.content as Json[] | undefined)?.push({ type: "text", text: data.text });
        break;
      case "session.reasoning.ended":
        (assistant()?.content as Json[] | undefined)?.push({ type: "reasoning", text: data.text, time: { created: at, completed: at } });
        break;
      case "session.tool.input.started":
        (assistant()?.content as Json[] | undefined)?.push({ type: "tool", id: data.id, name: data.name, state: { status: "streaming", input: "" }, time: { created: at } });
        break;
      case "session.tool.called": {
        const part = tool();
        if (part) Object.assign(part, { executed: data.executed, state: { status: "running", input: data.input, metadata: {} }, time: { ...(part.time as Json), ran: at } });
        else (assistant()?.content as Json[] | undefined)?.push({ type: "tool", id: data.id, name: asString(data.name) ?? "tool", executed: data.executed, state: { status: "running", input: data.input, metadata: {} }, time: { created: at, ran: at } });
        break;
      }
      case "session.tool.success": {
        const part = tool();
        if (part) Object.assign(part, { state: { status: "completed", input: asRecord(part.state).input, content: data.content, ...(data.metadata ? { metadata: data.metadata } : {}) }, time: { ...(part.time as Json), completed: at } });
        break;
      }
      case "session.tool.failed": {
        const part = tool();
        if (part) Object.assign(part, { state: { status: "error", input: asRecord(part.state).input, error: data.error }, time: { ...(part.time as Json), completed: at } });
        break;
      }
    }
  };

  const publish = (session: FakeSession2, type: string, data: Json = {}, location?: boolean) => {
    const body = type.startsWith("session.") || type.startsWith("permission.") ? { sessionID: session.id, ...data } : data;
    apply(session, type, body);
    broadcast(type, body, (location ?? !NO_LOCATION(type)) ? { directory: session.directory } : undefined);
  };

  const addSession = (input: Partial<FakeSession2> & { id: string; directory: string }): FakeSession2 => {
    const at = now();
    const session: FakeSession2 = { cost: 0, tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } }, time: { created: at, updated: at }, messages: [], running: false, instructionEntries: {}, pendingPrompts: [], ...input };
    sessions.set(session.id, session);
    return session;
  };

  const view = (session: FakeSession2) => ({
    id: session.id,
    projectID: "fake",
    ...(session.model ? { model: session.model } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    cost: session.cost,
    tokens: session.tokens,
    ...(session.outcome ? { outcome: session.outcome } : {}),
    time: session.time,
    ...(session.title ? { title: session.title } : {}),
    subpath: ".",
    ...(session.permissions ? { permissions: session.permissions } : {}),
    location: { directory: session.directory },
    ...(session.parentID ? { parentID: session.parentID } : {}),
  });

  const takePrompt = (session: FakeSession2): Promise<PendingPrompt2> => {
    const ready = session.pendingPrompts.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => waiters.set(session.id, [...(waiters.get(session.id) ?? []), resolve]));
  };

  const runTurn = async (session: FakeSession2, body: PromptBody2, inboxId: string) => {
    let wasInterrupted = false;
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => { abort = resolve; });
    runs.add(session.id);
    aborts.set(session.id, () => { wasInterrupted = true; abort(); });
    session.running = true;
    delete session.outcome;
    inbox.set(inboxId, { type: "user", payload: { text: body.text, ...(body.files ? { files: body.files } : {}) }, delivery: body.delivery ?? "steer" });
    pushUser(session, inboxId, inbox.get(inboxId)!);
    let terminal = false;
    const model = { ...(session.model ?? defaultModel()) };
    const turn: FakeTurn2 = {
      session,
      body,
      inboxId,
      assistantMessageId: nextId("msg"),
      model: { id: model.id, providerID: model.providerID, variant: model.variant ?? "default" },
      agent: session.agent ?? "build",
      emit: (type, data, emitOptions) => {
        if (TERMINAL.has(type)) terminal = true;
        publish(session, type, data, emitOptions?.location);
      },
      ask: (kind, payload) => new Promise((resolve) => {
        const form = asRecord(payload.form ?? payload);
        const data: Json = kind === "permission"
          ? { id: nextId("per"), sessionID: session.id, ...payload }
          : { form: { id: nextId("frm"), sessionID: session.id, ...form } };
        const id = String(kind === "permission" ? data.id : asRecord(data.form).id);
        pending.set(id, { kind, session, data, resolve });
        publish(session, kind === "permission" ? "permission.asked" : "form.created", data);
      }),
      nextPrompt: () => takePrompt(session),
      aborted,
    };
    try {
      await fake.script(turn);
    } catch (error) {
      if (!terminal) publish(session, "session.execution.failed", { error: { type: "fake.script", message: String(error) } });
      terminal = true;
    } finally {
      runs.delete(session.id);
      aborts.delete(session.id);
      session.running = false;
    }
    if (wasInterrupted && !terminal) publish(session, "session.execution.interrupted", { reason: "user" });
  };

  const fake: FakeOpenCode2 = {
    url: "",
    ...(options.password ? { password: options.password } : {}),
    requests,
    sessions,
    get listeners() { return streams.size; },
    script: options.script ?? textTurn("pong"),
    broadcast: (type, data, location) => broadcast(type, data, location),
    addSession,
    close: () => new Promise<void>((resolve) => {
      for (const stream of streams) stream.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };

  const notFound = (response: ServerResponse, tag: string, message: string, status = 404) => send(response, status, { _tag: tag, message });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams);
      const method = request.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
      requests.push({ method, path: url.pathname, query, ...(body !== undefined ? { body } : {}) });
      const path = url.pathname;
      // Anything outside /api is the web UI, which is how a client tells OpenCode 2 from 1.
      if (!path.startsWith("/api/")) {
        response.writeHead(200, { "content-type": "text/html" });
        return void response.end("<!doctype html><html><head><title>OpenCode</title></head><body></body></html>");
      }
      if (expected && request.headers.authorization !== expected) return notFound(response, "UnauthorizedError", "Authentication required", 401);
      const input = asRecord(body);
      const directory = query["location[directory]"] ?? query.directory ?? "/";
      const located = (data: unknown) => send(response, 200, { location: { directory }, data });

      if (path === "/api/info" && method === "GET") return send(response, 200, { version, pid: 1, urls: [fake.url], paths: { tmp: "/tmp" }, capabilities: { persistentPty: true } });
      if (path === "/api/event" && method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
        response.write(`data: ${JSON.stringify({ id: nextId("evt"), type: "server.connected", data: {} })}\n\n`);
        response.write(": heartbeat\n\n");
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }

      if (method === "GET" && path === "/api/provider") return located(options.providers ?? FAKE_PROVIDERS_V2);
      if (method === "GET" && path === "/api/model") return located(models);
      if (method === "GET" && path === "/api/model/default") {
        const ref = defaultModel();
        return located(models.find((model) => asRecord(model).id === ref.id && asRecord(model).providerID === ref.providerID));
      }
      if (method === "GET" && path === "/api/agent") return located(options.agents ?? FAKE_AGENTS_V2);
      if (method === "GET" && path === "/api/config") return send(response, 200, options.config ?? [{ type: "directory", path: "/tmp/opencode-config" }]);
      if (method === "GET" && path === "/api/mcp") return located(options.mcp ?? []);
      if (method === "GET" && path === "/api/permission/request") return located([...pending.values()].filter((entry) => entry.kind === "permission" && (!query["location[directory]"] || entry.session.directory === directory)).map((entry) => entry.data));
      if (method === "GET" && path === "/api/form") return located([...pending.values()].filter((entry) => entry.kind === "form" && (!query["location[directory]"] || entry.session.directory === directory)).map((entry) => entry.data.form));

      if (path === "/api/session" && method === "POST") {
        const id = asString(input.id) ?? nextId("ses");
        const location = asString(asRecord(input.location).directory);
        const session = addSession({
          id,
          directory: location ?? (query["location[directory]"] || "/"),
          ...(asString(input.title) ? { title: asString(input.title) } : {}),
          ...(asString(input.agent) ? { agent: asString(input.agent) } : {}),
          ...(input.model ? { model: input.model as ModelRef2 } : {}),
          ...(asString(input.parentID) ? { parentID: asString(input.parentID) } : {}),
          ...(Array.isArray(input.permissions) ? { permissions: input.permissions } : {}),
          ...(input.metadata ? { metadata: asRecord(input.metadata) } : {}),
        });
        broadcast("session.created", {
          sessionID: id, projectID: "fake", location: { directory: session.directory }, slug: id, version,
          ...(session.title ? { title: session.title } : {}), ...(session.permissions ? { permissions: session.permissions } : {}),
          ...(session.model ? { model: session.model } : {}), ...(session.parentID ? { parentID: session.parentID } : {}),
        }, { directory: session.directory });
        return send(response, 200, { data: view(session) });
      }
      if (path === "/api/session" && method === "GET") {
        const list = [...sessions.values()]
          .filter((session) => !query.directory || session.directory === query.directory)
          .filter((session) => query.parentID === undefined || (query.parentID === "null" ? !session.parentID : session.parentID === query.parentID))
          .filter((session) => !query.search || (session.title ?? "").toLowerCase().includes(query.search.toLowerCase()))
          .sort((a, b) => (b.time.updated - a.time.updated) || (a.id < b.id ? 1 : -1));
        if (query.order === "asc") list.reverse();
        const { data, cursor } = paginate(list, query);
        return send(response, 200, { data: data.map(view), cursor });
      }
      if (path === "/api/session/active" && method === "GET") {
        return send(response, 200, { data: Object.fromEntries([...sessions.values()].filter((session) => session.running).map((session) => [session.id, { type: "running" }])) });
      }

      const route = /^\/api\/session\/([^/]+)(?:\/(.*))?$/u.exec(path);
      if (route) {
        const session = sessions.get(decodeURIComponent(route[1]!));
        if (!session) return notFound(response, "SessionNotFoundError", `Session not found: ${route[1]}`);
        const rest = route[2] ?? "";
        if (rest === "" && method === "GET") return send(response, 200, { data: view(session) });
        if (rest === "" && method === "PATCH") {
          if (Array.isArray(input.permissions)) session.permissions = input.permissions;
          if (input.metadata) session.metadata = asRecord(input.metadata);
          const title = asString(input.title);
          if (title !== undefined && title !== session.title) publish(session, "session.renamed", { title });
          return send(response, 204);
        }
        if (rest === "model" && method === "POST") {
          publish(session, "session.model.selected", { model: input.model, ...(session.model ? { previous: session.model } : {}) });
          return send(response, 204);
        }
        if (rest === "agent" && method === "POST") {
          publish(session, "session.agent.selected", { agent: input.agent });
          return send(response, 204);
        }
        if (rest === "interrupt" && method === "POST") {
          const abort = aborts.get(session.id);
          abort?.();
          return send(response, 200, { interrupted: Boolean(abort) });
        }
        if (rest === "message" && method === "GET") {
          const list = (session.messages as Json[]).filter((message) => !query.type || message.type === query.type);
          if (query.order !== "asc") list.reverse();
          return send(response, 200, paginate(list, query));
        }
        if (rest === "prompt" && method === "POST") {
          const prompt: PromptBody2 = { ...(asString(input.id) ? { id: asString(input.id) } : {}), text: asString(input.text) ?? "", ...(Array.isArray(input.files) ? { files: input.files } : {}), ...(input.delivery === "queue" || input.delivery === "steer" ? { delivery: input.delivery } : {}) };
          const id = prompt.id ?? nextId("msg");
          const delivery = prompt.delivery ?? "steer";
          if (runs.has(session.id)) {
            const entry: PendingPrompt2 = { id, text: prompt.text, ...(prompt.files ? { files: prompt.files } : {}), delivery };
            session.pendingPrompts.push(entry);
            publish(session, "session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: prompt.text, ...(prompt.files ? { files: prompt.files } : {}) }, delivery } });
            const waiter = waiters.get(session.id)?.shift();
            if (waiter) waiter(session.pendingPrompts.shift()!);
          } else {
            void runTurn(session, prompt, id);
          }
          return send(response, 200, { data: { id, sessionID: session.id, time: { created: now() }, type: "user", payload: { text: prompt.text, ...(prompt.files ? { files: prompt.files } : {}) }, delivery } });
        }
        const answer = /^(permission|form)\/([^/]+)(?:\/(reply))?$/u.exec(rest);
        if (answer) {
          const entry = pending.get(decodeURIComponent(answer[2]!));
          const kind = answer[1] as "permission" | "form";
          if (!entry || entry.kind !== kind || entry.session !== session) {
            return kind === "permission" ? notFound(response, "PermissionNotFoundError", `Permission request not found: ${answer[2]}`) : notFound(response, "FormNotFoundError", `Form not found: ${answer[2]}`);
          }
          const id = decodeURIComponent(answer[2]!);
          if (kind === "permission" && answer[3] && method === "POST") {
            pending.delete(id);
            publish(session, "permission.replied", { requestID: id, reply: input.decision });
            entry.resolve({ decision: input.decision, ...(input.message !== undefined ? { message: input.message } : {}) });
            return send(response, 204);
          }
          if (kind === "form" && answer[3] && method === "POST") {
            pending.delete(id);
            publish(session, "form.replied", { id, sessionID: session.id, answer: input.answer });
            entry.resolve({ answer: input.answer });
            return send(response, 204);
          }
          if (kind === "form" && !answer[3] && method === "DELETE") {
            pending.delete(id);
            publish(session, "form.cancelled", { id, sessionID: session.id });
            entry.resolve({ cancelled: true, ...(query.message !== undefined ? { message: query.message } : {}) });
            return send(response, 204);
          }
        }
      }

      const instructions = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries(?:\/([^/]+))?$/u.exec(path);
      if (instructions) {
        const session = sessions.get(decodeURIComponent(instructions[1]!));
        if (!session) return notFound(response, "SessionNotFoundError", `Session not found: ${instructions[1]}`);
        const key = instructions[2] ? decodeURIComponent(instructions[2]) : undefined;
        if (!key && method === "GET") return send(response, 200, { data: Object.entries(session.instructionEntries).map(([entryKey, value]) => ({ key: entryKey, value })) });
        if (key && method === "PUT") {
          session.instructionEntries[key] = input.value;
          return send(response, 204);
        }
        if (key && method === "DELETE") {
          delete session.instructionEntries[key];
          return send(response, 204);
        }
      }
      notFound(response, "NotFound", `no route ${method} ${path}`);
    })().catch((error: unknown) => send(response, 500, { _tag: "FakeServerError", message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** The enqueue event for the prompt this turn runs; every script opens with it. */
export function announcePrompt(turn: FakeTurn2): void {
  const { text, files, delivery } = turn.body;
  turn.emit("session.inbox.enqueued", { inboxID: turn.inboxId, item: { type: "user", payload: { text, ...(files ? { files } : {}) }, delivery: delivery ?? "steer" } });
}

function openStep(turn: FakeTurn2, assistantMessageID: string): void {
  turn.emit("session.step.started", { agent: turn.agent, model: turn.model, assistantMessageID, started: Date.now() });
}

function openTurn(turn: FakeTurn2): void {
  announcePrompt(turn);
  turn.emit("session.execution.started");
  turn.emit("session.inbox.delivered", { inboxID: turn.inboxId });
  openStep(turn, turn.assistantMessageId);
}

/** A successful turn that answers `text`, with the events in the order the real server sends them. */
export function textTurn(text: string, opts: { tokens?: Partial<Tokens2>; cost?: number } = {}): FakeScript2 {
  return (turn) => {
    const tokens: Tokens2 = { ...ZERO_TOKENS, input: 12, output: 4, cache: { read: 0, write: 0 }, ...opts.tokens };
    const cost = opts.cost ?? 0;
    const ref = { assistantMessageID: turn.assistantMessageId, ordinal: 0 };
    openTurn(turn);
    turn.emit("session.text.started", ref);
    turn.emit("session.text.delta", { ...ref, delta: text });
    turn.emit("session.text.ended", { ...ref, text });
    turn.emit("session.step.streamed", { assistantMessageID: turn.assistantMessageId });
    turn.emit("session.step.ended", { assistantMessageID: turn.assistantMessageId, finish: "stop", rawFinish: "stop", cost, tokens });
    turn.emit("session.usage.updated", { cost: turn.session.cost + cost, tokens: sumTokens(turn.session.tokens, tokens) });
    turn.emit("session.execution.succeeded");
  };
}

/** A turn that runs `sleep 100` until the client interrupts, then ends as interrupted and sends nothing after. */
export const untilInterrupted: FakeScript2 = async (turn) => {
  const ref = { assistantMessageID: turn.assistantMessageId, id: "call_sleep" };
  openTurn(turn);
  turn.emit("session.tool.input.started", { ...ref, name: "shell" });
  turn.emit("session.tool.input.ended", { ...ref, text: JSON.stringify({ command: "sleep 100" }) });
  turn.emit("session.tool.called", { ...ref, input: { command: "sleep 100" }, executed: false });
  await turn.aborted;
  turn.emit("session.execution.interrupted", { reason: "user" });
};

interface RecordedEvent { type: string; location?: unknown; data: Json }
export type RecordedTurn2 = "permission" | "question" | "steer" | "tools" | "cancelledQuestion";

/**
 * A turn recorded from opencode 2.0.26, with this session's ids and folder. It
 * stops at the first success. A permission or form waits for the client's
 * reply (the fake sends the reply event itself); the steer recording waits for
 * the client's next two prompts where the recording received them.
 */
export function replay2(name: RecordedTurn2): FakeScript2 {
  return async (turn) => {
    const all = (recorded as unknown as Record<string, RecordedEvent[]>)[name]!;
    const first = all.findIndex((event) => event.type === "session.inbox.enqueued");
    const events = all.slice(first, all.findIndex((event) => event.type === "session.execution.succeeded") + 1);
    const head = events[0]!.data;
    const inline = (value: string) => JSON.stringify(value).slice(1, -1);
    const text = JSON.stringify(events)
      .replaceAll(String(head.sessionID), inline(turn.session.id))
      .replaceAll(String(head.inboxID), inline(turn.inboxId))
      .replaceAll(String(events.find((event) => event.type === "session.step.started")!.data.assistantMessageID), inline(turn.assistantMessageId))
      .replaceAll("/repo", inline(turn.session.directory));
    const live = JSON.parse(text) as RecordedEvent[];
    const inboxIds = new Map<string, string>();
    for (const [index, event] of live.entries()) {
      if (event.type === "permission.replied" || event.type === "form.replied" || event.type === "form.cancelled") continue;
      if (index === 0) {
        announcePrompt(turn);
        continue;
      }
      if (event.type === "session.inbox.enqueued") {
        inboxIds.set(String(event.data.inboxID), (await turn.nextPrompt()).id);
        continue;
      }
      if (event.type === "permission.asked") {
        await turn.ask("permission", event.data);
        continue;
      }
      if (event.type === "form.created") {
        await turn.ask("form", event.data);
        continue;
      }
      const data = event.type === "session.inbox.delivered" ? { ...event.data, inboxID: inboxIds.get(String(event.data.inboxID)) ?? event.data.inboxID } : event.data;
      turn.emit(event.type, data, { location: Boolean(event.location) });
    }
  };
}
