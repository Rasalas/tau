import type { HistoryMessage, HistorySession, HistoryTranscript, NativeSession, OpenCodeApi, OpenCodeSignal, QuestionRequest, SessionPolicy, SessionPrompt } from "./api.js";
import { rulesForLevelV2, type PermissionRequest, type QuestionInfo } from "./approvals.js";
import type { OpenCodeClient, OpenCodeEvent, OpenCodeInputPart, OpenCodeModelInfo, OpenCodeProvider, OpenCodeProviderList, OpenCodeTokens } from "./client.js";
import { OpenCode2TurnTranslator } from "./events-v2.js";

/**
 * OpenCode 2's server API (`/api/...`, 2.0.10 and newer) behind the
 * generation-neutral interface. Sessions live in one server for every project
 * folder; a request names its folder as `location[directory]`, a session
 * route needs none. Events arrive as `{ id, type, location?, data }` and are
 * handed on as `{ type, properties: data }`.
 */

/** The agent a thread runs on by default, and the one it plans with. */
const BUILD_AGENT = "build";
const PLAN_AGENT = "plan";
/** OpenCode adds the entry under this key to the session's instructions. */
const PLAN_ENTRY = "tau-plan";
const PLAN_INSTRUCTION = "You are in plan mode: explore and ask, change nothing. When the plan is ready, write it once inside a <proposed_plan> block.";
/** A decline that carries a message lets the model go on; a bare one stops the run. */
const DECLINED = "The user declined this request.";
const DISMISSED = "The user dismissed this question.";
const SILENT_STREAM_MS = 45_000;
const MESSAGE_PAGE = 200;
const MAX_MESSAGE_PAGES = 4;
/** The model list is empty until the server's plugins settle. */
const CATALOG_TRIES = 10;
const CATALOG_PAUSE_MS = 500;
const TOOLS_TRIES = 40;
const TOOLS_PAUSE_MS = 250;
const SETTLE_TRIES = 20;
const SETTLE_PAUSE_MS = 250;
const LOCATION = "location[directory]";

interface V2Model {
  id: string;
  modelID?: string;
  providerID: string;
  name?: string;
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  variants?: Array<{ id: string }>;
  time?: { released?: number };
  cost?: Array<{ tier?: unknown; input?: number; output?: number; cache?: { read?: number; write?: number } }>;
  status?: string;
  enabled?: boolean;
  limit?: { context?: number; output?: number };
}

interface V2Provider { id: string; name?: string; activation?: string }

interface V2Session {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: OpenCodeTokens;
  time?: { created?: number; updated?: number; archived?: number };
  permissions?: Array<{ action: string; resource: string; effect: string }>;
  location?: { directory: string };
}

interface V2Message {
  id: string;
  type: string;
  text?: string;
  time?: { created?: number };
  model?: { id: string; providerID: string };
  content?: Array<{ type: string; text?: string }>;
}

interface V2Field {
  key: string;
  type: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  when?: unknown[];
  custom?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
}

interface V2Form { id: string; sessionID: string; title?: string; fields: V2Field[] }

interface Known { model?: string; agent: string; plan: boolean }

export interface OpenCode2ApiOptions {
  /** Pauses between polls; tests pass an instant one. */
  sleep?(ms: number): Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

function modelKey(model: { id: string; providerID: string; variant?: string } | undefined): string | undefined {
  return model ? `${model.providerID}/${model.id}#${model.variant && model.variant !== "default" ? model.variant : ""}` : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fieldQuestion(field: V2Field): QuestionInfo {
  const header = field.title?.trim() ?? "";
  const options = field.type === "boolean"
    ? [{ label: "Yes", description: "" }, { label: "No", description: "" }]
    : (field.options ?? []).map((option) => ({ label: option.label || option.value, ...(option.description ? { description: option.description } : {}) }));
  return {
    question: field.description?.trim() || header || field.key,
    header,
    options,
    multiple: field.type === "multiselect",
    custom: field.custom === true || options.length === 0,
  };
}

/** Why a form cannot be asked in a dialog, if it cannot. */
function unsupported(form: V2Form): string | undefined {
  for (const field of form.fields) {
    if (field.type === "external") return "a link to open";
    if (field.hidden === true) return "a hidden field";
    if ((field.when?.length ?? 0) > 0) return "a field that depends on another";
    if (!["string", "multiselect", "boolean", "number", "integer"].includes(field.type)) return `a ${field.type} value`;
  }
  return undefined;
}

/** A dialog's answers as the form's values. */
function formAnswer(fields: readonly V2Field[], answers: readonly string[][]): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  fields.forEach((field, index) => {
    const values = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) return;
    const byLabel = (value: string) => field.options?.find((option) => option.label === value)?.value ?? value;
    if (field.type === "multiselect") answer[field.key] = values.map(byLabel);
    else if (field.type === "boolean") answer[field.key] = /^(?:yes|true|y|1)$/iu.test(values[0]!);
    else if (field.type === "number" || field.type === "integer") {
      const number = Number(values[0]);
      if (Number.isFinite(number)) answer[field.key] = field.type === "integer" ? Math.trunc(number) : number;
    } else answer[field.key] = values.map(byLabel).join(", ");
  });
  return answer;
}

function nativeSession(session: V2Session): NativeSession {
  return {
    id: session.id,
    ...(session.title ? { title: session.title } : {}),
    ...(session.parentID ? { parentId: session.parentID } : {}),
    ...(session.tokens ? { tokens: session.tokens } : {}),
    ...(session.cost !== undefined ? { cost: session.cost } : {}),
  };
}

/** Turns an OpenCode 2 SSE block into the neutral event shape. */
export function parseEvent2Block(block: string): OpenCodeEvent | undefined {
  const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
  if (!data) return undefined;
  try {
    const event = JSON.parse(data) as { type?: unknown; data?: unknown; location?: unknown };
    if (typeof event?.type !== "string") return undefined;
    return { type: event.type, properties: { ...record(event.data), ...(event.location ? { location: event.location } : {}) } };
  } catch {
    return undefined;
  }
}

export class OpenCode2Api implements OpenCodeApi {
  readonly generation = 2 as const;
  /** What each session is known to run, so a prompt switches only what changed. */
  private readonly known = new Map<string, Known>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly client: OpenCodeClient, private readonly version: string, options: OpenCode2ApiOptions = {}) {
    this.sleep = options.sleep ?? wait;
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const info = await this.client.request<{ version?: unknown }>("GET", "/api/info", { timeoutMs: 5_000 });
    return { healthy: true, version: typeof info?.version === "string" ? info.version : this.version };
  }

  private async catalog(directory: string): Promise<{ providers: V2Provider[]; models: V2Model[] }> {
    const query = { [LOCATION]: directory };
    for (let attempt = 1; ; attempt += 1) {
      const [providers, models] = await Promise.all([
        this.client.request<{ data?: V2Provider[] }>("GET", "/api/provider", { query }),
        this.client.request<{ data?: V2Model[] }>("GET", "/api/model", { query }),
      ]);
      const list = (models.data ?? []).filter((model) => model.enabled !== false);
      if (list.length > 0 || attempt >= CATALOG_TRIES) return { providers: providers.data ?? [], models: list };
      await this.sleep(CATALOG_PAUSE_MS);
    }
  }

  async providers(directory: string): Promise<OpenCodeProviderList> {
    const { providers, models } = await this.catalog(directory);
    const byProvider = new Map<string, OpenCodeProvider>();
    for (const model of models) {
      let provider = byProvider.get(model.providerID);
      if (!provider) {
        const info = providers.find((entry) => entry.id === model.providerID);
        byProvider.set(model.providerID, provider = { id: model.providerID, ...(info?.name ? { name: info.name } : {}), models: {} });
      }
      const id = model.modelID ?? model.id;
      provider.models[id] = this.modelInfo(id, model);
    }
    const fallback = await this.client.request<{ data?: V2Model | null }>("GET", "/api/model/default", { query: { [LOCATION]: directory } }).catch(() => undefined);
    const preferred = fallback?.data;
    return {
      all: [...byProvider.values()],
      connected: [...byProvider.keys()],
      default: preferred ? { [preferred.providerID]: preferred.modelID ?? preferred.id } : {},
    };
  }

  private modelInfo(id: string, model: V2Model): OpenCodeModelInfo {
    const price = model.cost?.find((entry) => !entry.tier) ?? model.cost?.[0];
    return {
      id,
      providerID: model.providerID,
      name: model.name ?? id,
      capabilities: { reasoning: (model.variants?.length ?? 0) > 0, input: { image: model.capabilities?.input?.includes("image") === true } },
      ...(price ? { cost: { input: price.input ?? 0, output: price.output ?? 0, cache: { read: price.cache?.read ?? 0, write: price.cache?.write ?? 0 } } } : {}),
      ...(model.limit ? { limit: model.limit } : {}),
      ...(model.status ? { status: model.status } : {}),
      variants: Object.fromEntries((model.variants ?? []).map((variant) => [variant.id, {}])),
    };
  }

  async config(directory: string): Promise<{ model?: string }> {
    const fallback = await this.client.request<{ data?: V2Model | null }>("GET", "/api/model/default", { query: { [LOCATION]: directory } });
    const model = fallback?.data;
    return model ? { model: `${model.providerID}/${model.modelID ?? model.id}` } : {};
  }

  private remember(session: V2Session): Known {
    const known: Known = { ...(modelKey(session.model) ? { model: modelKey(session.model)! } : {}), agent: session.agent ?? BUILD_AGENT, plan: this.known.get(session.id)?.plan ?? false };
    this.known.set(session.id, known);
    return known;
  }

  async createSession(directory: string, input: { title?: string; policy: SessionPolicy }): Promise<NativeSession> {
    const created = await this.client.request<{ data: V2Session }>("POST", "/api/session", {
      body: { location: { directory }, permissions: rulesForLevelV2(input.policy.level, input.policy.tools), ...(input.title ? { title: input.title } : {}) },
    });
    this.remember(created.data);
    return nativeSession(created.data);
  }

  async getSession(_directory: string, id: string): Promise<NativeSession> {
    const found = await this.client.request<{ data: V2Session }>("GET", `/api/session/${encodeURIComponent(id)}`);
    this.remember(found.data);
    return nativeSession(found.data);
  }

  async applyPolicy(_directory: string, id: string, policy: SessionPolicy): Promise<void> {
    await this.client.request("PATCH", `/api/session/${encodeURIComponent(id)}`, { body: { permissions: rulesForLevelV2(policy.level, policy.tools) } });
  }

  async renameSession(_directory: string, id: string, title: string): Promise<void> {
    await this.client.request("PATCH", `/api/session/${encodeURIComponent(id)}`, { body: { title } });
  }

  async prompt(directory: string, id: string, prompt: SessionPrompt): Promise<void> {
    const path = `/api/session/${encodeURIComponent(id)}`;
    let known = this.known.get(id);
    if (!known) {
      await this.getSession(directory, id);
      known = this.known.get(id)!;
    }
    if (prompt.model) {
      const wanted = { id: prompt.model.modelID, providerID: prompt.model.providerID, ...(prompt.variant && prompt.variant !== "default" ? { variant: prompt.variant } : {}) };
      if (modelKey(wanted) !== known.model) {
        await this.client.request("POST", `${path}/model`, { body: { model: wanted } });
        known.model = modelKey(wanted)!;
      }
    }
    const agent = prompt.plan ? PLAN_AGENT : BUILD_AGENT;
    if (agent !== known.agent) {
      await this.client.request("POST", `${path}/agent`, { body: { agent } });
      known.agent = agent;
    }
    if (prompt.plan !== known.plan) {
      const entry = `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${PLAN_ENTRY}`;
      await (prompt.plan ? this.client.request("PUT", entry, { body: { value: PLAN_INSTRUCTION } }) : this.client.request("DELETE", entry));
      known.plan = prompt.plan;
    }
    const text = prompt.parts.filter((part): part is Extract<OpenCodeInputPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n\n");
    const files = prompt.parts.flatMap((part) => part.type === "file" ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }] : []);
    await this.client.request("POST", `${path}/prompt`, { body: { text, ...(files.length ? { files } : {}), ...(prompt.steer ? { delivery: "steer" } : {}) } });
  }

  async abort(_directory: string, id: string): Promise<void> {
    await this.client.request("POST", `/api/session/${encodeURIComponent(id)}/interrupt`);
  }

  async settle(_directory: string, id: string): Promise<void> {
    const running = async () => id in ((await this.client.request<{ data?: Record<string, unknown> }>("GET", "/api/session/active")).data ?? {});
    if (!await running()) return;
    await this.abort("", id).catch(() => undefined);
    for (let attempt = 0; attempt < SETTLE_TRIES && await running(); attempt += 1) await this.sleep(SETTLE_PAUSE_MS);
  }

  /** MCP servers connect after their location boots; a prompt sent first would run without their tools. */
  async awaitTools(directory: string, servers: readonly string[]): Promise<void> {
    for (let attempt = 0; attempt < TOOLS_TRIES; attempt += 1) {
      const listed = await this.client.request<{ data?: Array<{ name: string; status?: { status?: string } }> }>("GET", "/api/mcp", { query: { [LOCATION]: directory } }).catch(() => undefined);
      const settled = servers.every((name) => {
        const status = listed?.data?.find((entry) => entry.name === name)?.status?.status;
        return status !== undefined && status !== "pending";
      });
      if (settled) return;
      await this.sleep(TOOLS_PAUSE_MS);
    }
  }

  async replyPermission(_directory: string, request: PermissionRequest, reply: "once" | "always" | "reject", message?: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(request.id)}`;
    if (reply === "always") {
      // OpenCode would keep an "always" for the project for good; Tau grants it to this session only.
      const session = await this.client.request<{ data: V2Session }>("GET", `/api/session/${encodeURIComponent(request.sessionID)}`);
      const patterns = (request.always ?? []).length ? request.always! : ["*"];
      const grants = patterns.map((resource) => ({ action: request.permission, resource, effect: "allow" }));
      await this.client.request("PATCH", `/api/session/${encodeURIComponent(request.sessionID)}`, { body: { permissions: [...(session.data.permissions ?? []), ...grants] } });
    }
    await this.client.request("POST", `${path}/reply`, { body: reply === "reject" ? { decision: "reject", message: message ?? DECLINED } : { decision: "once" } });
  }

  async answerQuestion(_directory: string, sessionId: string, request: QuestionRequest, answers: string[][] | undefined): Promise<void> {
    const native = request.native as { fields?: V2Field[]; message?: string } | undefined;
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(request.id)}`;
    if (!answers || !native?.fields) {
      await this.client.request("DELETE", path, { query: { message: native?.message ?? DISMISSED } });
      return;
    }
    await this.client.request("POST", `${path}/reply`, { body: { answer: formAnswer(native.fields, answers) } });
  }

  subscribe(_directory: string, onEvent: (event: OpenCodeEvent) => void, onEnd: (error?: Error) => void) {
    return this.client.follow("/api/event", {}, parseEvent2Block, onEvent, onEnd, SILENT_STREAM_MS);
  }

  signal(event: OpenCodeEvent): OpenCodeSignal | undefined {
    const data = event.properties;
    if (event.type === "form.created") {
      const form = record(data.form) as unknown as V2Form;
      if (typeof form.id !== "string" || typeof form.sessionID !== "string" || !Array.isArray(form.fields)) return undefined;
      const orphan = !form.sessionID.startsWith("ses_");
      const why = unsupported(form);
      return {
        kind: "question",
        sessionId: form.sessionID,
        request: why
          ? { id: form.id, questions: [], native: { message: `Tau cannot answer ${why}.` }, ...(orphan ? { orphan } : {}) }
          : { id: form.id, questions: form.fields.map(fieldQuestion), native: { fields: form.fields }, ...(orphan ? { orphan } : {}) },
      };
    }
    const sessionId = data.sessionID;
    if (typeof sessionId !== "string") return undefined;
    switch (event.type) {
      case "session.created":
        return { kind: "session", sessionId, ...(typeof data.parentID === "string" ? { parentId: data.parentID } : {}), ...(typeof data.title === "string" && data.title ? { title: data.title } : {}) };
      case "session.renamed":
        return typeof data.title === "string" ? { kind: "session", sessionId, title: data.title } : undefined;
      case "session.usage.updated":
        return { kind: "session", sessionId, usage: { tokens: record(data.tokens) as OpenCodeTokens, ...(typeof data.cost === "number" ? { cost: data.cost } : {}) } };
      case "permission.asked":
        return typeof data.id === "string"
          ? { kind: "permission", sessionId, request: { id: data.id, sessionID: sessionId, permission: String(data.action ?? ""), patterns: Array.isArray(data.resources) ? data.resources.map(String) : [], always: Array.isArray(data.save) ? data.save.map(String) : [], metadata: record(data.metadata) } }
          : undefined;
      default:
        return { kind: "turn", sessionId, type: event.type, properties: data };
    }
  }

  translator(now: () => number) { return new OpenCode2TurnTranslator(now); }

  async listHistory(query: { roots?: boolean; limit?: number }): Promise<HistorySession[]> {
    const limit = query.limit ?? 50;
    const size = Math.min(limit, 200);
    const sessions: V2Session[] = [];
    let cursor: string | undefined;
    while (sessions.length < limit) {
      const page = await this.client.request<{ data: V2Session[]; cursor?: { next?: string | null } }>("GET", "/api/session", {
        // A cursor stands for the first request's filters and order.
        query: cursor ? { cursor } : { limit: String(size), order: "desc", ...(query.roots ? { parentID: "null" } : {}) },
      });
      sessions.push(...page.data);
      cursor = page.cursor?.next ?? undefined;
      if (page.data.length < size || !cursor) break;
    }
    return sessions.slice(0, limit).map((session): HistorySession => ({
      id: session.id,
      directory: session.location?.directory ?? "",
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentID ? { parentId: session.parentID } : {}),
      ...(session.time?.archived ? { archived: true } : {}),
      ...(session.time?.updated !== undefined ? { updatedAt: session.time.updated } : {}),
      ...(session.time?.created !== undefined ? { createdAt: session.time.created } : {}),
      ...(session.tokens ? { tokens: session.tokens } : {}),
      ...(session.cost !== undefined ? { cost: session.cost } : {}),
    }));
  }

  /** The newest part of a long conversation, with its first message in front. */
  async historyMessages(_directory: string, id: string): Promise<HistoryTranscript> {
    const path = `/api/session/${encodeURIComponent(id)}/message`;
    const newest: V2Message[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const answer = await this.client.request<{ data: V2Message[]; cursor?: { next?: string | null } }>("GET", path, {
        query: cursor ? { cursor } : { limit: String(MESSAGE_PAGE), order: "desc" },
      });
      newest.push(...answer.data);
      cursor = answer.cursor?.next ?? undefined;
      more = answer.data.length === MESSAGE_PAGE && Boolean(cursor);
      if (!more) break;
    }
    const ordered = newest.reverse();
    if (more) {
      const first = await this.client.request<{ data: V2Message[] }>("GET", path, { query: { limit: "20", order: "asc", type: "user" } });
      if (first.data[0] && !ordered.some((message) => message.id === first.data[0]!.id)) ordered.unshift(first.data[0]);
    }
    const messages: HistoryMessage[] = [];
    let model: { provider: string; id: string } | undefined;
    for (const message of ordered) {
      const timestamp = message.time?.created ?? Date.now();
      if (message.type === "user") {
        const text = message.text?.trim();
        if (text) messages.push({ role: "user", text, timestamp });
      } else if (message.type === "assistant") {
        if (message.model) model = { provider: message.model.providerID, id: message.model.id };
        const text = (message.content ?? []).filter((part) => part.type === "text" && part.text?.trim()).map((part) => part.text!.trim()).join("\n\n");
        if (!text) continue;
        const last = messages.at(-1);
        if (last?.role === "assistant") last.text = `${last.text}\n\n${text}`;
        else messages.push({ role: "assistant", text, timestamp });
      }
    }
    return { messages, ...(model ? { model } : {}) };
  }
}
