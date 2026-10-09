import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_ID, readPersistedJson, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage } from "tau/host-extension";

/**
 * App-data persistence for OpenCode threads: the Tau thread → OpenCode session
 * mapping, the visible transcript, title, usage and the chosen model, variant
 * and mode. OpenCode keeps the full conversation itself, in its own database.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface OpenCodeStoredMessage {
  /** The id the transcript showed it under, so tool cards anchored to it find it again. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

/** A model as OpenCode names it: provider and model id. */
export interface OpenCodeModelRef {
  provider: string;
  id: string;
}

export interface OpenCodeSessionRecord {
  backendKind: "opencode";
  tauThreadId: string;
  /** The instance the thread runs on; absent for the default one. */
  instance?: string;
  /** OpenCode's session id, once the first turn created one. */
  sessionId?: string;
  cwd: string;
  messages: OpenCodeStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** What the user picked; sent with every prompt. */
  model?: OpenCodeModelRef;
  /** OpenCode's name for the reasoning effort (a model's variant). */
  variant?: string;
  /** The interaction mode, when it is not `default`: OpenCode's agent of that name. */
  mode?: string;
  /** What the thread last ran on; shown before the user picks, never sent. */
  observedModel?: OpenCodeModelRef;
  /** The only tools the thread keeps, as Pi names them; set when it was created. */
  tools?: string[];
  /** When Tau created the thread; records from before it was kept fall back to their first message. */
  createdAt?: number;
  updatedAt: number;
}

/** A model a provider offers, kept so the picker is not empty before a server answers. */
export interface OpenCodeStoredModel {
  provider: string;
  id: string;
  name: string;
  variants: string[];
  contextWindow?: number;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function storedUsage(value: unknown): UiThreadUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage: Partial<UiThreadUsage> = {};
  for (const field of USAGE_FIELDS) {
    const number = (value as Record<string, unknown>)[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
    usage[field] = number;
  }
  return usage as UiThreadUsage;
}

function modelRef(value: unknown): OpenCodeModelRef | undefined {
  const item = value as { provider?: unknown; id?: unknown } | undefined;
  const provider = text(item?.provider, MAX_ID_LENGTH);
  const id = text(item?.id, MAX_ID_LENGTH);
  return provider && id ? { provider, id } : undefined;
}

function storedMessage(value: unknown): OpenCodeStoredMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if ((item.role !== "user" && item.role !== "assistant") || typeof item.text !== "string" || typeof item.timestamp !== "number") return undefined;
  const clientMessageId = text(item.clientMessageId, MAX_ID_LENGTH);
  const id = text(item.id, MAX_ID_LENGTH);
  return { ...(id ? { id } : {}), role: item.role, text: item.text, timestamp: item.timestamp, ...(clientMessageId ? { clientMessageId } : {}) };
}

function instanceOf(value: unknown): string | undefined {
  const id = text(value, 48);
  return id && id !== DEFAULT_INSTANCE_ID ? id : undefined;
}

function storedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const tools = value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0 && tool.length <= 128);
  return tools.length === value.length ? tools : undefined;
}

function storedRecord(value: unknown): OpenCodeSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauThreadId = text(item.tauThreadId, MAX_ID_LENGTH);
  const cwd = text(item.cwd, 4_096);
  if (!tauThreadId || !cwd || typeof item.updatedAt !== "number") return undefined;
  const messages = Array.isArray(item.messages) ? item.messages.flatMap((message) => { const parsed = storedMessage(message); return parsed ? [parsed] : []; }) : [];
  const optional = {
    sessionId: text(item.sessionId, MAX_ID_LENGTH),
    instance: instanceOf(item.instance),
    title: text(item.title, MAX_TITLE_LENGTH)?.trim() || undefined,
    titleSource: item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed" ? item.titleSource : undefined,
    usage: storedUsage(item.usage),
    model: modelRef(item.model),
    variant: text(item.variant, MAX_ID_LENGTH),
    mode: text(item.mode, MAX_ID_LENGTH),
    observedModel: modelRef(item.observedModel),
    tools: storedTools(item.tools),
    createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : messages[0]?.timestamp,
  };
  return {
    backendKind: "opencode",
    tauThreadId,
    cwd,
    messages,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    updatedAt: item.updatedAt,
  };
}

export function storedModel(value: unknown): OpenCodeStoredModel | undefined {
  const ref = modelRef(value);
  if (!ref) return undefined;
  const item = value as Record<string, unknown>;
  const variants = Array.isArray(item.variants) ? item.variants.filter((variant): variant is string => typeof variant === "string") : [];
  return {
    ...ref,
    name: text(item.name, MAX_TITLE_LENGTH) ?? ref.id,
    variants,
    ...(typeof item.contextWindow === "number" && item.contextWindow > 0 ? { contextWindow: item.contextWindow } : {}),
  };
}

function storedModels(value: unknown): OpenCodeStoredModel[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [];
}

function clone(record: OpenCodeSessionRecord): OpenCodeSessionRecord {
  return {
    ...record,
    messages: record.messages.map((message) => ({ ...message })),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.model ? { model: { ...record.model } } : {}),
    ...(record.observedModel ? { observedModel: { ...record.observedModel } } : {}),
    ...(record.tools ? { tools: [...record.tools] } : {}),
  };
}

interface StoredFile { sessions: OpenCodeSessionRecord[]; models: Record<string, OpenCodeStoredModel[]> }

function decodeFile(value: unknown): StoredFile | undefined {
  const item = value as { sessions?: unknown; models?: unknown } | undefined;
  if (!item || !Array.isArray(item.sessions)) return undefined;
  const models = item.models && typeof item.models === "object" && !Array.isArray(item.models)
    ? Object.fromEntries(Object.entries(item.models as Record<string, unknown>).map(([id, list]) => [id, storedModels(list)]))
    : {};
  return { sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry); return record ? [record] : []; }), models };
}

function sameInstance(record: OpenCodeSessionRecord, instance: string | undefined): boolean {
  return (record.instance ?? DEFAULT_INSTANCE_ID) === (instance ?? DEFAULT_INSTANCE_ID);
}

export class OpenCodeSessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, OpenCodeSessionRecord>();
  /** The models each instance's providers offer, by instance id. */
  private models = new Map<string, OpenCodeStoredModel[]>();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: { filePath: string; now?(): number; logger?: PersistedJsonLogger }) {
    this.now = options.now ?? Date.now;
  }

  /** Beside the Pi session directory, like the other backends' stores, so a dev instance never writes into the user's own. */
  static defaultPath(sessionsDir: string): string {
    return join(dirname(sessionsDir), "tau", "opencode-runtime-sessions.json");
  }

  private load(): Promise<void> {
    this.loading ??= readPersistedJson(this.options.filePath, { expectedVersion: CURRENT_VERSION, decode: decodeFile, ...(this.options.logger ? { logger: this.options.logger } : {}) })
      .then((result) => {
        for (const record of result?.data.sessions ?? []) this.records.set(record.tauThreadId, record);
        this.models = new Map(Object.entries(result?.data.models ?? {}));
      })
      .catch(() => undefined);
    return this.loading;
  }

  async get(tauThreadId: string): Promise<OpenCodeSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? clone(record) : undefined;
  }

  /** Every thread, or those of one instance (`default` included). */
  async list(instance?: string): Promise<OpenCodeSessionRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => instance === undefined || sameInstance(record, instance))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  /** The thread's record, created on the given instance when it has none. */
  async ensure(tauThreadId: string, cwd: string, instance?: string): Promise<OpenCodeSessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd !== cwd) throw new Error("This OpenCode thread belongs to another workspace.");
    if (existing && instance !== undefined && !sameInstance(existing, instance)) throw new Error("This OpenCode thread runs on another instance.");
    if (existing) return clone(existing);
    const owner = instanceOf(instance);
    const record: OpenCodeSessionRecord = { backendKind: "opencode", tauThreadId, ...(owner ? { instance: owner } : {}), cwd, messages: [], createdAt: this.now(), updatedAt: this.now() };
    this.records.set(tauThreadId, record);
    await this.persist();
    return clone(record);
  }

  private async update(tauThreadId: string, cwd: string, change: (record: OpenCodeSessionRecord) => void): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId)!;
    change(record);
    record.updatedAt = this.now();
    await this.persist();
  }

  setSession(tauThreadId: string, cwd: string, sessionId: string | undefined): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { if (sessionId) record.sessionId = sessionId; else delete record.sessionId; });
  }

  setSelection(tauThreadId: string, cwd: string, selection: { model?: OpenCodeModelRef | null; variant?: string | null; mode?: string | null }): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      if (selection.model !== undefined) { if (selection.model) record.model = { ...selection.model }; else delete record.model; }
      for (const key of ["variant", "mode"] as const) {
        const value = selection[key];
        if (value === undefined) continue;
        if (value) record[key] = value; else delete record[key];
      }
    });
  }

  setTools(tauThreadId: string, cwd: string, tools: readonly string[]): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.tools = [...tools]; });
  }

  setObservedModel(tauThreadId: string, cwd: string, model: OpenCodeModelRef): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.observedModel = { ...model }; });
  }

  recordUsage(tauThreadId: string, cwd: string, usage: UiThreadUsage): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.usage = { ...usage }; });
  }

  setTitle(tauThreadId: string, cwd: string, title: string, source: ThreadTitleSource): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      const safe = title.trim().slice(0, MAX_TITLE_LENGTH);
      if (safe) record.title = safe; else delete record.title;
      record.titleSource = source;
    });
  }

  /** OpenCode session ids Tau already holds, whether started here or imported. */
  async sessionIds(): Promise<Set<string>> {
    await this.load();
    return new Set([...this.records.values()].flatMap((record) => record.sessionId ? [record.sessionId] : []));
  }

  /**
   * Takes over sessions OpenCode ran on its own, as threads that resume them.
   * A session Tau already holds is skipped; the answer is the new thread id,
   * or `undefined` for a skipped one.
   */
  async adopt(sessions: readonly { sessionId: string; cwd: string; title: string; model?: OpenCodeModelRef; usage?: UiThreadUsage; messages: readonly OpenCodeStoredMessage[]; updatedAt: number }[]): Promise<Array<string | undefined>> {
    const held = await this.sessionIds();
    const ids = sessions.map((session) => {
      if (held.has(session.sessionId)) return undefined;
      held.add(session.sessionId);
      const tauThreadId = randomUUID();
      this.records.set(tauThreadId, {
        backendKind: "opencode",
        tauThreadId,
        sessionId: session.sessionId,
        cwd: session.cwd,
        messages: session.messages.map((message) => ({ ...message })),
        title: session.title.trim().slice(0, MAX_TITLE_LENGTH),
        titleSource: "derived",
        ...(session.model ? { observedModel: { ...session.model } } : {}),
        ...(session.usage ? { usage: { ...session.usage } } : {}),
        ...(session.messages[0] ? { createdAt: session.messages[0].timestamp } : {}),
        updatedAt: session.updatedAt,
      });
      return tauThreadId;
    });
    if (ids.some(Boolean)) await this.persist();
    return ids;
  }

  /** Appends visible messages; a replayed client message id is ignored, a conflicting one refused. */
  appendMessages(tauThreadId: string, cwd: string, messages: readonly UiMessage[]): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const clientMessageId = text(message.clientMessageId, MAX_ID_LENGTH);
        if (clientMessageId) {
          const existing = record.messages.find((item) => item.clientMessageId === clientMessageId);
          if (existing && existing.text === message.text && existing.role === message.role) continue;
          if (existing) throw new Error(`The OpenCode transcript already holds a different message '${clientMessageId}'.`);
        }
        const id = text(message.id, MAX_ID_LENGTH);
        record.messages.push({ ...(id ? { id } : {}), role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    });
  }

  async listModels(instance = DEFAULT_INSTANCE_ID): Promise<OpenCodeStoredModel[]> {
    await this.load();
    return (this.models.get(instance) ?? []).map((model) => ({ ...model, variants: [...model.variants] }));
  }

  async setModels(models: readonly OpenCodeStoredModel[], instance = DEFAULT_INSTANCE_ID): Promise<void> {
    await this.load();
    const next = storedModels(models);
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models.get(instance) ?? [])) return;
    this.models.set(instance, next);
    await this.persist();
  }

  /** Takes a thread's record out for the host's trash; OpenCode's own session stays. */
  async take(tauThreadId: string): Promise<OpenCodeSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    if (!record) return undefined;
    this.records.delete(tauThreadId);
    await this.persist();
    return clone(record);
  }

  /** Puts back what `take` answered. */
  async put(tauThreadId: string, value: unknown): Promise<void> {
    await this.load();
    const record = storedRecord(value);
    if (!record || record.tauThreadId !== tauThreadId) throw new Error("This is not the OpenCode thread that was deleted.");
    if (this.records.has(tauThreadId)) throw new Error("An OpenCode thread with this id exists again; it was not restored.");
    this.records.set(tauThreadId, record);
    await this.persist();
  }

  /** Writes one after the other, so a slow write never lands after a newer one. */
  private persist(): Promise<void> {
    const data = { sessions: [...this.records.values()], models: Object.fromEntries(this.models) };
    this.writing = this.writing.catch(() => undefined).then(() => writePersistedJson(this.options.filePath, CURRENT_VERSION, data, this.options.logger ? { logger: this.options.logger } : {}));
    return this.writing;
  }
}
