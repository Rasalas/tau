import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendUsageTurn, readPersistedJson, readUsageTurns, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage, type UsageTurn } from "tau/host-extension";

/**
 * App-data persistence for Antigravity threads: the Tau thread → ACP session
 * mapping, the visible transcript, the title, usage and the chosen model.
 * The agent keeps the full conversation itself, under its profile.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface AntigravityStoredMessage {
  /** The id the transcript showed it under, so tool cards anchored to it find it again. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface AntigravitySessionRecord {
  backendKind: "antigravity";
  tauThreadId: string;
  /** The agent's session id, once a session was created; a resume needs it. */
  acpSessionId?: string;
  cwd: string;
  messages: AntigravityStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** Each turn's tokens, dated; threads from before turns were kept have only `usage`. */
  usageTurns?: UsageTurn[];
  /** What the user picked for this thread; it is applied to every later session. */
  model?: string;
  /** What the thread last actually ran on; shown before a session exists, never applied. */
  observedModel?: string;
  updatedAt: number;
}

/** A model the agent offered, kept so the picker is not empty before a session exists. */
export interface AntigravityStoredModel {
  value: string;
  name: string;
}

export interface AntigravitySessionStoreOptions {
  filePath: string;
  now?(): number;
  logger?: PersistedJsonLogger;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function storedUsage(value: unknown): UiThreadUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const usage: Partial<UiThreadUsage> = {};
  for (const field of USAGE_FIELDS) {
    const number = item[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
    usage[field] = number;
  }
  return usage as UiThreadUsage;
}

function storedMessage(value: unknown): AntigravityStoredMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  const text = typeof item.text === "string" ? item.text : Array.isArray(item.textChunks) && item.textChunks.every((chunk) => typeof chunk === "string") ? item.textChunks.join("") : undefined;
  const timestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp) ? item.timestamp : undefined;
  if (text === undefined || timestamp === undefined) return undefined;
  const clientMessageId = boundedString(item.clientMessageId, MAX_ID_LENGTH);
  const id = boundedString(item.id, MAX_ID_LENGTH);
  return { ...(id ? { id } : {}), role: item.role, text, timestamp, ...(clientMessageId ? { clientMessageId } : {}) };
}

function storedRecord(value: unknown): AntigravitySessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauThreadId = boundedString(item.tauThreadId, MAX_ID_LENGTH);
  const cwd = boundedString(item.cwd, 4_096);
  const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined;
  if (!tauThreadId || !cwd || updatedAt === undefined) return undefined;
  const acpSessionId = boundedString(item.acpSessionId, MAX_ID_LENGTH);
  const title = boundedString(item.title, MAX_TITLE_LENGTH)?.trim() || undefined;
  const titleSource = item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed" ? item.titleSource : undefined;
  const usage = storedUsage(item.usage);
  const usageTurns = readUsageTurns(item.usageTurns);
  const model = boundedString(item.model, MAX_ID_LENGTH);
  const observedModel = boundedString(item.observedModel, MAX_ID_LENGTH);
  return {
    backendKind: "antigravity",
    tauThreadId,
    ...(acpSessionId ? { acpSessionId } : {}),
    cwd,
    messages: Array.isArray(item.messages) ? item.messages.flatMap((message) => { const parsed = storedMessage(message); return parsed ? [parsed] : []; }) : [],
    ...(title ? { title } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(usage ? { usage } : {}),
    ...(usageTurns ? { usageTurns } : {}),
    ...(model ? { model } : {}),
    ...(observedModel ? { observedModel } : {}),
    updatedAt,
  };
}

function cloneRecord(record: AntigravitySessionRecord): AntigravitySessionRecord {
  return {
    ...record,
    messages: record.messages.map((message) => ({ ...message })),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.usageTurns ? { usageTurns: record.usageTurns.map((turn) => ({ ...turn })) } : {}),
  };
}

function storedModel(value: unknown): AntigravityStoredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = boundedString(item.value, MAX_ID_LENGTH);
  const name = boundedString(item.name, MAX_TITLE_LENGTH);
  return id ? { value: id, name: name ?? id } : undefined;
}

interface StoredFile {
  sessions: AntigravitySessionRecord[];
  models: AntigravityStoredModel[];
}

function decodeFile(value: unknown): StoredFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as { sessions?: unknown; models?: unknown };
  if (!Array.isArray(item.sessions)) return undefined;
  return {
    sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry); return record ? [record] : []; }),
    models: Array.isArray(item.models) ? item.models.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [],
  };
}

export class AntigravitySessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, AntigravitySessionRecord>();
  private models: AntigravityStoredModel[] = [];
  private loaded = false;
  private loading?: Promise<void>;

  constructor(private readonly options: AntigravitySessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Beside the Pi session directory, like the Claude Code kit's store, so a dev instance never writes into the user's own. */
  static defaultPath(sessionsDir: string): string {
    return join(dirname(sessionsDir), "tau", "antigravity-runtime-sessions.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.readFromDisk();
    await this.loading;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const result = await readPersistedJson(this.options.filePath, { expectedVersion: CURRENT_VERSION, decode: decodeFile, logger: this.options.logger });
      if (result) {
        for (const record of result.data.sessions) this.records.set(record.tauThreadId, record);
        this.models = result.data.models;
        await chmod(this.options.filePath, 0o600).catch(() => undefined);
      }
    } catch {
      this.records.clear();
      this.models = [];
    } finally {
      this.loaded = true;
    }
  }

  async get(tauThreadId: string): Promise<AntigravitySessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? cloneRecord(record) : undefined;
  }

  async list(cwd?: string): Promise<AntigravitySessionRecord[]> {
    await this.load();
    return [...this.records.values()].filter((record) => cwd === undefined || record.cwd === cwd).sort((left, right) => right.updatedAt - left.updatedAt).map(cloneRecord);
  }

  async ensure(tauThreadId: string, cwd: string): Promise<AntigravitySessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd === cwd) return cloneRecord(existing);
    if (existing) throw new Error("Antigravity session belongs to another workspace.");
    const record: AntigravitySessionRecord = { backendKind: "antigravity", tauThreadId, cwd, messages: [], updatedAt: this.now() };
    this.records.set(tauThreadId, record);
    await this.persist();
    return cloneRecord(record);
  }

  private async update(tauThreadId: string, cwd: string, change: (record: AntigravitySessionRecord) => void): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) return;
    change(record);
    record.updatedAt = this.now();
    await this.persist();
  }

  setAcpSession(tauThreadId: string, cwd: string, acpSessionId: string): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.acpSessionId = acpSessionId; });
  }

  clearAcpSession(tauThreadId: string, cwd: string): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { delete record.acpSessionId; });
  }

  setModel(tauThreadId: string, cwd: string, model: string | undefined): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { if (model) record.model = model; else delete record.model; });
  }

  setObservedModel(tauThreadId: string, cwd: string, model: string): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.observedModel = model; });
  }

  /** The running total, and the turn that just ended when there is one. */
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

  /** Appends visible messages; a replay of a known client message id is ignored, a conflicting one rejected. */
  appendMessages(tauThreadId: string, cwd: string, messages: readonly UiMessage[]): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const clientMessageId = boundedString(message.clientMessageId, MAX_ID_LENGTH);
        const id = boundedString(message.id, MAX_ID_LENGTH);
        const stored: AntigravityStoredMessage = { ...(id ? { id } : {}), role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) };
        if (clientMessageId) {
          const existing = record.messages.find((item) => item.clientMessageId === clientMessageId);
          if (existing) {
            if (existing.text === stored.text && existing.role === stored.role) continue;
            throw new Error(`Antigravity transcript already contains a conflicting message id '${clientMessageId}'.`);
          }
        }
        record.messages.push(stored);
      }
    });
  }

  /** The models the agent last offered this account; the picker reads them before a session exists. */
  async listModels(): Promise<AntigravityStoredModel[]> {
    await this.load();
    return this.models.map((model) => ({ ...model }));
  }

  async setModels(models: readonly AntigravityStoredModel[]): Promise<void> {
    await this.load();
    const next = models.flatMap((model) => { const parsed = storedModel(model); return parsed ? [parsed] : []; });
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models)) return;
    this.models = next;
    await this.persist();
  }

  /** Takes a thread's record out for the host's trash; the CLI's own history stays where it is. */
  async take(tauThreadId: string): Promise<AntigravitySessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    if (!record) return undefined;
    this.records.delete(tauThreadId);
    await this.persist();
    return cloneRecord(record);
  }

  /** Puts back what `take` answered. */
  async put(tauThreadId: string, value: unknown): Promise<void> {
    await this.load();
    const record = storedRecord(value);
    if (!record || record.tauThreadId !== tauThreadId) throw new Error("This is not the Antigravity thread that was deleted.");
    if (this.records.has(tauThreadId)) throw new Error("A Antigravity thread with this id exists again; it was not restored.");
    this.records.set(tauThreadId, record);
    await this.persist();
  }

  private persist(): Promise<void> {
    return writePersistedJson(this.options.filePath, CURRENT_VERSION, { sessions: [...this.records.values()], models: this.models }, { logger: this.options.logger });
  }
}
