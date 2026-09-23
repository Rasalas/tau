import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_ID, appendUsageTurn, readPersistedJson, readUsageTurns, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage, type UsageTurn } from "tau/host-extension";

/**
 * App-data persistence for an ACP runtime's threads, one file per kit: the
 * Tau thread → ACP session mapping, the visible transcript, title, usage and
 * the chosen model, effort and mode, and the models each instance's account
 * offers. The agent keeps the full conversation itself, in its home.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface AcpStoredMessage {
  /** The id the transcript showed it under, so tool cards anchored to it find it again. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface AcpSessionRecord<K extends string = string> {
  backendKind: K;
  tauThreadId: string;
  /** The instance the thread runs on; absent for the default one. */
  instance?: string;
  /** The agent's session id, once the first turn created one. */
  acpSessionId?: string;
  cwd: string;
  messages: AcpStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** Each turn's tokens, dated, where the kit keeps them; `usage` is their running total. */
  usageTurns?: UsageTurn[];
  /** What the user picked; applied before every turn. */
  model?: string;
  /** The reasoning effort picked for the model, the agent's own value. */
  effort?: string;
  /** The interaction mode when it is not `default`. */
  mode?: string;
  /** What the thread last ran on; shown before a session exists, never applied. */
  observedModel?: string;
  updatedAt: number;
}

/** A model the account offers, kept so the picker is not empty before a session exists. */
export interface AcpStoredModel {
  id: string;
  name: string;
  /** Reasoning efforts the model offers, the agent's values. */
  efforts: string[];
  /** Its context window in tokens, where the agent said. */
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

function storedMessage(value: unknown): AcpStoredMessage | undefined {
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

function storedRecord(value: unknown, backendKind: string): AcpSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauThreadId = text(item.tauThreadId, MAX_ID_LENGTH);
  const cwd = text(item.cwd, 4_096);
  if (!tauThreadId || !cwd || typeof item.updatedAt !== "number") return undefined;
  const optional = {
    instance: instanceOf(item.instance),
    acpSessionId: text(item.acpSessionId, MAX_ID_LENGTH),
    title: text(item.title, MAX_TITLE_LENGTH)?.trim() || undefined,
    titleSource: item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed" ? item.titleSource : undefined,
    usage: storedUsage(item.usage),
    usageTurns: readUsageTurns(item.usageTurns),
    model: text(item.model, MAX_ID_LENGTH),
    effort: text(item.effort, MAX_ID_LENGTH),
    mode: text(item.mode, MAX_ID_LENGTH),
    observedModel: text(item.observedModel, MAX_ID_LENGTH),
  };
  return {
    backendKind,
    tauThreadId,
    cwd,
    messages: Array.isArray(item.messages) ? item.messages.flatMap((message) => { const parsed = storedMessage(message); return parsed ? [parsed] : []; }) : [],
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    updatedAt: item.updatedAt,
  };
}

export function storedModel(value: unknown): AcpStoredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = text(item.id, MAX_ID_LENGTH);
  if (!id) return undefined;
  const efforts = Array.isArray(item.efforts) ? item.efforts.filter((effort): effort is string => typeof effort === "string" && effort.length > 0 && effort.length <= MAX_ID_LENGTH) : [];
  const contextWindow = typeof item.contextWindow === "number" && Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : undefined;
  return { id, name: text(item.name, MAX_TITLE_LENGTH) ?? id, efforts, ...(contextWindow ? { contextWindow } : {}) };
}

function storedModels(value: unknown): AcpStoredModel[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [];
}

function clone<R extends AcpSessionRecord>(record: R): R {
  return { ...record, messages: record.messages.map((message) => ({ ...message })), ...(record.usage ? { usage: { ...record.usage } } : {}), ...(record.usageTurns ? { usageTurns: record.usageTurns.map((turn) => ({ ...turn })) } : {}) };
}

interface StoredFile { sessions: AcpSessionRecord[]; models: Record<string, AcpStoredModel[]> }

function decodeFile(value: unknown, backendKind: string): StoredFile | undefined {
  const item = value as { sessions?: unknown; models?: unknown } | undefined;
  if (!item || !Array.isArray(item.sessions)) return undefined;
  const models = item.models && typeof item.models === "object" && !Array.isArray(item.models)
    ? Object.fromEntries(Object.entries(item.models as Record<string, unknown>).map(([id, list]) => [id, storedModels(list)]))
    : {};
  return { sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry, backendKind); return record ? [record] : []; }), models };
}

function sameInstance(record: AcpSessionRecord, instance: string | undefined): boolean {
  return (record.instance ?? DEFAULT_INSTANCE_ID) === (instance ?? DEFAULT_INSTANCE_ID);
}

export type AcpSelection = { model?: string | null; effort?: string | null; mode?: string | null };

export interface AcpSessionStoreOptions<K extends string> {
  filePath: string;
  /** The backend kind every record carries: `cursor`. */
  backendKind: K;
  /** How errors name the agent: `This Cursor thread …`. */
  agent: string;
  now?(): number;
  logger?: PersistedJsonLogger;
}

export class AcpSessionStore<K extends string = string> {
  private readonly now: () => number;
  private readonly records = new Map<string, AcpSessionRecord<K>>();
  /** The models each instance's account offers, by instance id. */
  private models = new Map<string, AcpStoredModel[]>();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: AcpSessionStoreOptions<K>) {
    this.now = options.now ?? Date.now;
  }

  /** Beside the Pi session directory, like the other backends' stores, so a dev instance never writes into the user's own. */
  static pathFor(sessionsDir: string, backendKind: string): string {
    return join(dirname(sessionsDir), "tau", `${backendKind}-runtime-sessions.json`);
  }

  private load(): Promise<void> {
    this.loading ??= readPersistedJson(this.options.filePath, { expectedVersion: CURRENT_VERSION, decode: (value) => decodeFile(value, this.options.backendKind), ...(this.options.logger ? { logger: this.options.logger } : {}) })
      .then(async (result) => {
        for (const record of result?.data.sessions ?? []) this.records.set(record.tauThreadId, record as AcpSessionRecord<K>);
        this.models = new Map(Object.entries(result?.data.models ?? {}));
        if (result) await chmod(this.options.filePath, 0o600).catch(() => undefined);
      })
      .catch(() => undefined);
    return this.loading;
  }

  async get(tauThreadId: string): Promise<AcpSessionRecord<K> | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? clone(record) : undefined;
  }

  /** Every thread, or those of one instance (`default` included). */
  async list(instance?: string): Promise<AcpSessionRecord<K>[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => instance === undefined || sameInstance(record, instance))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  /** The thread's record, created on the given instance when it has none. */
  async ensure(tauThreadId: string, cwd: string, instance?: string): Promise<AcpSessionRecord<K>> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd !== cwd) throw new Error(`This ${this.options.agent} thread belongs to another workspace.`);
    if (existing && instance !== undefined && !sameInstance(existing, instance)) throw new Error(`This ${this.options.agent} thread runs on another instance.`);
    if (existing) return clone(existing);
    const owner = instanceOf(instance);
    const record: AcpSessionRecord<K> = { backendKind: this.options.backendKind, tauThreadId, ...(owner ? { instance: owner } : {}), cwd, messages: [], updatedAt: this.now() };
    this.records.set(tauThreadId, record);
    await this.persist();
    return clone(record);
  }

  private async update(tauThreadId: string, cwd: string, change: (record: AcpSessionRecord<K>) => void): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId)!;
    change(record);
    record.updatedAt = this.now();
    await this.persist();
  }

  setAcpSession(tauThreadId: string, cwd: string, acpSessionId: string | undefined): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { if (acpSessionId) record.acpSessionId = acpSessionId; else delete record.acpSessionId; });
  }

  setSelection(tauThreadId: string, cwd: string, selection: AcpSelection): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const key of ["model", "effort", "mode"] as const) {
        const value = selection[key];
        if (value === undefined) continue;
        if (value) record[key] = value; else delete record[key];
      }
    });
  }

  setObservedModel(tauThreadId: string, cwd: string, model: string): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.observedModel = model; });
  }

  /** The running total, and the turn that added to it where the kit keeps turns. */
  recordUsage(tauThreadId: string, cwd: string, usage: UiThreadUsage, turn?: UsageTurn): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      record.usage = { ...usage };
      if (turn) record.usageTurns = appendUsageTurn(record.usageTurns ?? [], turn);
    });
  }

  setTitle(tauThreadId: string, cwd: string, title: string, source: ThreadTitleSource): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      const safe = title.trim().slice(0, MAX_TITLE_LENGTH);
      if (safe) record.title = safe; else delete record.title;
      record.titleSource = source;
    });
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
          if (existing) throw new Error(`The ${this.options.agent} transcript already holds a different message '${clientMessageId}'.`);
        }
        const id = text(message.id, MAX_ID_LENGTH);
        record.messages.push({ ...(id ? { id } : {}), role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    });
  }

  async listModels(instance = DEFAULT_INSTANCE_ID): Promise<AcpStoredModel[]> {
    await this.load();
    return (this.models.get(instance) ?? []).map((model) => ({ ...model, efforts: [...model.efforts] }));
  }

  async setModels(models: readonly AcpStoredModel[], instance = DEFAULT_INSTANCE_ID): Promise<void> {
    await this.load();
    const next = storedModels(models);
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models.get(instance) ?? [])) return;
    this.models.set(instance, next);
    await this.persist();
  }

  /** Takes a thread's record out for the host's trash; the agent's own chat stays. */
  async take(tauThreadId: string): Promise<AcpSessionRecord<K> | undefined> {
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
    const record = storedRecord(value, this.options.backendKind) as AcpSessionRecord<K> | undefined;
    if (!record || record.tauThreadId !== tauThreadId) throw new Error(`This is not the ${this.options.agent} thread that was deleted.`);
    if (this.records.has(tauThreadId)) throw new Error(`A ${this.options.agent} thread with this id exists again; it was not restored.`);
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
