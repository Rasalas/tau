import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage } from "tau/host-extension";

/**
 * App-data persistence for Codex threads: the Tau thread → Codex thread
 * mapping, the visible transcript, title, usage and the chosen model and
 * effort. Codex keeps the full conversation itself, under its own home.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface CodexStoredMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface CodexSessionRecord {
  backendKind: "codex";
  tauThreadId: string;
  /** Codex's thread id, once one was started; a resume needs it. */
  codexThreadId?: string;
  cwd: string;
  messages: CodexStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** What the user picked; sent with every turn. */
  model?: string;
  effort?: string;
  /** What the thread last ran on; shown before a session exists, never sent. */
  observedModel?: string;
  updatedAt: number;
}

/** A model the account offers, kept so the picker is not empty before a session exists. */
export interface CodexStoredModel {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
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

function storedMessage(value: unknown): CodexStoredMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if ((item.role !== "user" && item.role !== "assistant") || typeof item.text !== "string" || typeof item.timestamp !== "number") return undefined;
  const clientMessageId = text(item.clientMessageId, MAX_ID_LENGTH);
  return { role: item.role, text: item.text, timestamp: item.timestamp, ...(clientMessageId ? { clientMessageId } : {}) };
}

function storedRecord(value: unknown): CodexSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauThreadId = text(item.tauThreadId, MAX_ID_LENGTH);
  const cwd = text(item.cwd, 4_096);
  if (!tauThreadId || !cwd || typeof item.updatedAt !== "number") return undefined;
  const optional = {
    codexThreadId: text(item.codexThreadId, MAX_ID_LENGTH),
    title: text(item.title, MAX_TITLE_LENGTH)?.trim() || undefined,
    titleSource: item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed" ? item.titleSource : undefined,
    usage: storedUsage(item.usage),
    model: text(item.model, MAX_ID_LENGTH),
    effort: text(item.effort, MAX_ID_LENGTH),
    observedModel: text(item.observedModel, MAX_ID_LENGTH),
  };
  return {
    backendKind: "codex",
    tauThreadId,
    cwd,
    messages: Array.isArray(item.messages) ? item.messages.flatMap((message) => { const parsed = storedMessage(message); return parsed ? [parsed] : []; }) : [],
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    updatedAt: item.updatedAt,
  };
}

function storedModel(value: unknown): CodexStoredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = text(item.id, MAX_ID_LENGTH);
  if (!id) return undefined;
  const efforts = Array.isArray(item.efforts) ? item.efforts.filter((effort): effort is string => typeof effort === "string") : [];
  const defaultEffort = text(item.defaultEffort, MAX_ID_LENGTH);
  return { id, name: text(item.name, MAX_TITLE_LENGTH) ?? id, efforts, ...(defaultEffort ? { defaultEffort } : {}), ...(item.isDefault === true ? { isDefault: true } : {}) };
}

function clone(record: CodexSessionRecord): CodexSessionRecord {
  return { ...record, messages: record.messages.map((message) => ({ ...message })), ...(record.usage ? { usage: { ...record.usage } } : {}) };
}

interface StoredFile { sessions: CodexSessionRecord[]; models: CodexStoredModel[] }

function decodeFile(value: unknown): StoredFile | undefined {
  const item = value as { sessions?: unknown; models?: unknown } | undefined;
  if (!item || !Array.isArray(item.sessions)) return undefined;
  return {
    sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry); return record ? [record] : []; }),
    models: Array.isArray(item.models) ? item.models.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [],
  };
}

export class CodexSessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, CodexSessionRecord>();
  private models: CodexStoredModel[] = [];
  private loading?: Promise<void>;

  constructor(private readonly options: { filePath: string; now?(): number; logger?: PersistedJsonLogger }) {
    this.now = options.now ?? Date.now;
  }

  /** Beside the Pi session directory, like the other backends' stores, so a dev instance never writes into the user's own. */
  static defaultPath(sessionsDir: string): string {
    return join(dirname(sessionsDir), "tau", "codex-runtime-sessions.json");
  }

  private load(): Promise<void> {
    this.loading ??= readPersistedJson(this.options.filePath, { expectedVersion: CURRENT_VERSION, decode: decodeFile, ...(this.options.logger ? { logger: this.options.logger } : {}) })
      .then((result) => {
        for (const record of result?.data.sessions ?? []) this.records.set(record.tauThreadId, record);
        this.models = result?.data.models ?? [];
      })
      .catch(() => undefined);
    return this.loading;
  }

  async get(tauThreadId: string): Promise<CodexSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? clone(record) : undefined;
  }

  async list(): Promise<CodexSessionRecord[]> {
    await this.load();
    return [...this.records.values()].sort((left, right) => right.updatedAt - left.updatedAt).map(clone);
  }

  async ensure(tauThreadId: string, cwd: string): Promise<CodexSessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd !== cwd) throw new Error("This Codex thread belongs to another workspace.");
    if (existing) return clone(existing);
    const record: CodexSessionRecord = { backendKind: "codex", tauThreadId, cwd, messages: [], updatedAt: this.now() };
    this.records.set(tauThreadId, record);
    await this.persist();
    return clone(record);
  }

  private async update(tauThreadId: string, cwd: string, change: (record: CodexSessionRecord) => void): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId)!;
    change(record);
    record.updatedAt = this.now();
    await this.persist();
  }

  setCodexThread(tauThreadId: string, cwd: string, codexThreadId: string | undefined): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { if (codexThreadId) record.codexThreadId = codexThreadId; else delete record.codexThreadId; });
  }

  setSelection(tauThreadId: string, cwd: string, selection: { model?: string | null; effort?: string | null }): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const key of ["model", "effort"] as const) {
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

  /** Codex's thread ids Tau already holds, whether started here or imported. */
  async codexThreadIds(): Promise<Set<string>> {
    await this.load();
    return new Set([...this.records.values()].flatMap((record) => record.codexThreadId ? [record.codexThreadId] : []));
  }

  /**
   * Takes over sessions the CLI ran on its own, as threads that resume them.
   * A Codex thread id Tau already holds is skipped, so importing twice adds
   * nothing; the answer is the new thread id, or `undefined` for a skipped one.
   */
  async adopt(sessions: readonly { codexThreadId: string; cwd: string; title: string; model?: string; messages: readonly CodexStoredMessage[]; updatedAt: number }[]): Promise<Array<string | undefined>> {
    const held = await this.codexThreadIds();
    const ids = sessions.map((session) => {
      if (held.has(session.codexThreadId)) return undefined;
      held.add(session.codexThreadId);
      const tauThreadId = randomUUID();
      this.records.set(tauThreadId, {
        backendKind: "codex",
        tauThreadId,
        codexThreadId: session.codexThreadId,
        cwd: session.cwd,
        messages: session.messages.map((message) => ({ ...message })),
        title: session.title.trim().slice(0, MAX_TITLE_LENGTH),
        titleSource: "derived",
        ...(session.model ? { observedModel: session.model } : {}),
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
          if (existing) throw new Error(`The Codex transcript already holds a different message '${clientMessageId}'.`);
        }
        record.messages.push({ role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    });
  }

  async listModels(): Promise<CodexStoredModel[]> {
    await this.load();
    return this.models.map((model) => ({ ...model, efforts: [...model.efforts] }));
  }

  async setModels(models: readonly CodexStoredModel[]): Promise<void> {
    await this.load();
    const next = models.flatMap((model) => { const parsed = storedModel(model); return parsed ? [parsed] : []; });
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models)) return;
    this.models = next;
    await this.persist();
  }

  private persist(): Promise<void> {
    return writePersistedJson(this.options.filePath, CURRENT_VERSION, { sessions: [...this.records.values()], models: this.models }, this.options.logger ? { logger: this.options.logger } : {});
  }
}
