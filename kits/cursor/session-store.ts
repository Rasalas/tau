import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_ID, readPersistedJson, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage } from "tau/host-extension";

/**
 * App-data persistence for Cursor threads: the Tau thread → ACP session
 * mapping, the visible transcript, title, usage and the chosen model, effort
 * and mode. The Cursor CLI keeps the full conversation itself, in its home.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface CursorStoredMessage {
  /** The id the transcript showed it under, so tool cards anchored to it find it again. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface CursorSessionRecord {
  backendKind: "cursor";
  tauThreadId: string;
  /** The instance the thread runs on; absent for the default one. */
  instance?: string;
  /** The agent's session id, once the first turn created one. */
  acpSessionId?: string;
  cwd: string;
  messages: CursorStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** What the user picked; applied before every turn. */
  model?: string;
  /** The reasoning effort picked for the model, Cursor's own value. */
  effort?: string;
  /** The interaction mode when it is not `default`. */
  mode?: string;
  /** What the thread last ran on; shown before a session exists, never applied. */
  observedModel?: string;
  updatedAt: number;
}

/** A model the account offers, kept so the picker is not empty before a session exists. */
export interface CursorStoredModel {
  id: string;
  name: string;
  /** Reasoning efforts the model offers, Cursor's values. */
  efforts: string[];
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

function storedMessage(value: unknown): CursorStoredMessage | undefined {
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

function storedRecord(value: unknown): CursorSessionRecord | undefined {
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
    model: text(item.model, MAX_ID_LENGTH),
    effort: text(item.effort, MAX_ID_LENGTH),
    mode: text(item.mode, MAX_ID_LENGTH),
    observedModel: text(item.observedModel, MAX_ID_LENGTH),
  };
  return {
    backendKind: "cursor",
    tauThreadId,
    cwd,
    messages: Array.isArray(item.messages) ? item.messages.flatMap((message) => { const parsed = storedMessage(message); return parsed ? [parsed] : []; }) : [],
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    updatedAt: item.updatedAt,
  };
}

export function storedModel(value: unknown): CursorStoredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = text(item.id, MAX_ID_LENGTH);
  if (!id) return undefined;
  const efforts = Array.isArray(item.efforts) ? item.efforts.filter((effort): effort is string => typeof effort === "string" && effort.length > 0 && effort.length <= MAX_ID_LENGTH) : [];
  return { id, name: text(item.name, MAX_TITLE_LENGTH) ?? id, efforts };
}

function storedModels(value: unknown): CursorStoredModel[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [];
}

function clone(record: CursorSessionRecord): CursorSessionRecord {
  return { ...record, messages: record.messages.map((message) => ({ ...message })), ...(record.usage ? { usage: { ...record.usage } } : {}) };
}

interface StoredFile { sessions: CursorSessionRecord[]; models: Record<string, CursorStoredModel[]> }

function decodeFile(value: unknown): StoredFile | undefined {
  const item = value as { sessions?: unknown; models?: unknown } | undefined;
  if (!item || !Array.isArray(item.sessions)) return undefined;
  const models = item.models && typeof item.models === "object" && !Array.isArray(item.models)
    ? Object.fromEntries(Object.entries(item.models as Record<string, unknown>).map(([id, list]) => [id, storedModels(list)]))
    : {};
  return { sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry); return record ? [record] : []; }), models };
}

function sameInstance(record: CursorSessionRecord, instance: string | undefined): boolean {
  return (record.instance ?? DEFAULT_INSTANCE_ID) === (instance ?? DEFAULT_INSTANCE_ID);
}

export type CursorSelection = { model?: string | null; effort?: string | null; mode?: string | null };

export class CursorSessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, CursorSessionRecord>();
  /** The models each instance's account offers, by instance id. */
  private models = new Map<string, CursorStoredModel[]>();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: { filePath: string; now?(): number; logger?: PersistedJsonLogger }) {
    this.now = options.now ?? Date.now;
  }

  /** Beside the Pi session directory, like the other backends' stores, so a dev instance never writes into the user's own. */
  static defaultPath(sessionsDir: string): string {
    return join(dirname(sessionsDir), "tau", "cursor-runtime-sessions.json");
  }

  private load(): Promise<void> {
    this.loading ??= readPersistedJson(this.options.filePath, { expectedVersion: CURRENT_VERSION, decode: decodeFile, ...(this.options.logger ? { logger: this.options.logger } : {}) })
      .then(async (result) => {
        for (const record of result?.data.sessions ?? []) this.records.set(record.tauThreadId, record);
        this.models = new Map(Object.entries(result?.data.models ?? {}));
        if (result) await chmod(this.options.filePath, 0o600).catch(() => undefined);
      })
      .catch(() => undefined);
    return this.loading;
  }

  async get(tauThreadId: string): Promise<CursorSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? clone(record) : undefined;
  }

  /** Every thread, or those of one instance (`default` included). */
  async list(instance?: string): Promise<CursorSessionRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => instance === undefined || sameInstance(record, instance))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  /** The thread's record, created on the given instance when it has none. */
  async ensure(tauThreadId: string, cwd: string, instance?: string): Promise<CursorSessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd !== cwd) throw new Error("This Cursor thread belongs to another workspace.");
    if (existing && instance !== undefined && !sameInstance(existing, instance)) throw new Error("This Cursor thread runs on another instance.");
    if (existing) return clone(existing);
    const owner = instanceOf(instance);
    const record: CursorSessionRecord = { backendKind: "cursor", tauThreadId, ...(owner ? { instance: owner } : {}), cwd, messages: [], updatedAt: this.now() };
    this.records.set(tauThreadId, record);
    await this.persist();
    return clone(record);
  }

  private async update(tauThreadId: string, cwd: string, change: (record: CursorSessionRecord) => void): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId)!;
    change(record);
    record.updatedAt = this.now();
    await this.persist();
  }

  setAcpSession(tauThreadId: string, cwd: string, acpSessionId: string | undefined): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { if (acpSessionId) record.acpSessionId = acpSessionId; else delete record.acpSessionId; });
  }

  setSelection(tauThreadId: string, cwd: string, selection: CursorSelection): Promise<void> {
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

  /** Appends visible messages; a replayed client message id is ignored, a conflicting one refused. */
  appendMessages(tauThreadId: string, cwd: string, messages: readonly UiMessage[]): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const clientMessageId = text(message.clientMessageId, MAX_ID_LENGTH);
        if (clientMessageId) {
          const existing = record.messages.find((item) => item.clientMessageId === clientMessageId);
          if (existing && existing.text === message.text && existing.role === message.role) continue;
          if (existing) throw new Error(`The Cursor transcript already holds a different message '${clientMessageId}'.`);
        }
        const id = text(message.id, MAX_ID_LENGTH);
        record.messages.push({ ...(id ? { id } : {}), role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    });
  }

  async listModels(instance = DEFAULT_INSTANCE_ID): Promise<CursorStoredModel[]> {
    await this.load();
    return (this.models.get(instance) ?? []).map((model) => ({ ...model, efforts: [...model.efforts] }));
  }

  async setModels(models: readonly CursorStoredModel[], instance = DEFAULT_INSTANCE_ID): Promise<void> {
    await this.load();
    const next = storedModels(models);
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models.get(instance) ?? [])) return;
    this.models.set(instance, next);
    await this.persist();
  }

  /** Takes a thread's record out for the host's trash; the CLI's own chat stays. */
  async take(tauThreadId: string): Promise<CursorSessionRecord | undefined> {
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
    if (!record || record.tauThreadId !== tauThreadId) throw new Error("This is not the Cursor thread that was deleted.");
    if (this.records.has(tauThreadId)) throw new Error("A Cursor thread with this id exists again; it was not restored.");
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
