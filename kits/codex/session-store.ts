import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_ID, appendUsageTurn, legacyUsageTurn, mergeTallies, readPersistedJson, readUsageTurns, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiThreadUsage, type UsageTally, type UsageTurn } from "tau/host-extension";

/**
 * App-data persistence for Codex threads: the Tau thread → Codex thread
 * mapping, the visible transcript, title, usage and the chosen model and
 * effort. Codex keeps the full conversation itself, under its own home.
 */
const CURRENT_VERSION = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;

export interface CodexStoredMessage {
  /** The id the transcript showed it under, so tool cards anchored to it find it again. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
}

export interface CodexSessionRecord {
  backendKind: "codex";
  tauThreadId: string;
  /** The instance the thread runs on; absent for the default one. */
  instance?: string;
  /** Account executing this thread; backend ownership remains with instance. */
  accountInstance?: string;
  /** Canonical session home; account changes must keep it. */
  sessionHome?: string;
  serviceTier?: string;
  /** Codex's thread id, once one was started; a resume needs it. */
  codexThreadId?: string;
  cwd: string;
  messages: CodexStoredMessage[];
  title?: string;
  titleSource?: ThreadTitleSource;
  usage?: UiThreadUsage;
  /** Each turn's tokens, dated; threads from before turns were kept have only `usage`. */
  usageTurns?: UsageTurn[];
  /** What the user picked; sent with every turn. */
  model?: string;
  effort?: string;
  /** The interaction mode, when it is not `default`; sent with every turn as Codex's collaboration mode. */
  mode?: string;
  /** What the thread last ran on; shown before a session exists, never sent. */
  observedModel?: string;
  /** The only tools the thread keeps, as Pi names them; set when it was created. */
  tools?: string[];
  updatedAt: number;
}

/** A model the account offers, kept so the picker is not empty before a session exists. */
export interface CodexStoredModel {
  id: string;
  name: string;
  efforts: string[];
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
  defaultServiceTier?: string;
  defaultEffort?: string;
  isDefault?: boolean;
  /** It takes images; absent when `model/list` did not say. */
  images?: boolean;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;

/** A thread's turns; a thread from before turns were kept has one, from its total. */
export function usageTurnsOf(record: CodexSessionRecord): UsageTurn[] {
  if (record.usageTurns) return record.usageTurns.map((turn) => ({ ...turn }));
  const model = record.model ?? record.observedModel;
  return record.usage && record.usage.turns > 0 ? [legacyUsageTurn(record.usage, record.updatedAt, { provider: "openai", ...(model ? { model } : {}) })] : [];
}

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
  const id = text(item.id, MAX_ID_LENGTH);
  return { ...(id ? { id } : {}), role: item.role, text: item.text, timestamp: item.timestamp, ...(clientMessageId ? { clientMessageId } : {}) };
}

function storedRecord(value: unknown): CodexSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauThreadId = text(item.tauThreadId, MAX_ID_LENGTH);
  const cwd = text(item.cwd, 4_096);
  if (!tauThreadId || !cwd || typeof item.updatedAt !== "number") return undefined;
  const optional = {
    codexThreadId: text(item.codexThreadId, MAX_ID_LENGTH),
    instance: instanceOf(item.instance),
    accountInstance: text(item.accountInstance, 48),
    sessionHome: text(item.sessionHome, 4096),
    serviceTier: text(item.serviceTier, MAX_ID_LENGTH),
    title: text(item.title, MAX_TITLE_LENGTH)?.trim() || undefined,
    titleSource: item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed" ? item.titleSource : undefined,
    usage: storedUsage(item.usage),
    usageTurns: readUsageTurns(item.usageTurns),
    model: text(item.model, MAX_ID_LENGTH),
    effort: text(item.effort, MAX_ID_LENGTH),
    mode: text(item.mode, MAX_ID_LENGTH),
    observedModel: text(item.observedModel, MAX_ID_LENGTH),
    tools: storedTools(item.tools),
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

function instanceOf(value: unknown): string | undefined {
  const id = text(value, 48);
  return id && id !== DEFAULT_INSTANCE_ID ? id : undefined;
}

function storedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const tools = value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0 && tool.length <= 128);
  return tools.length === value.length ? tools : undefined;
}

function storedModel(value: unknown): CodexStoredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = text(item.id, MAX_ID_LENGTH);
  if (!id) return undefined;
  const efforts = Array.isArray(item.efforts) ? item.efforts.filter((effort): effort is string => typeof effort === "string") : [];
  const defaultEffort = text(item.defaultEffort, MAX_ID_LENGTH);
  return {
    id,
    name: text(item.name, MAX_TITLE_LENGTH) ?? id,
    efforts,
    ...(Array.isArray(item.serviceTiers) ? { serviceTiers: item.serviceTiers.flatMap((entry) => {
      const tier = entry as { id?: unknown; name?: unknown; description?: unknown };
      const tierId = text(tier?.id, MAX_ID_LENGTH);
      return tierId ? [{ id: tierId, name: text(tier.name, MAX_TITLE_LENGTH) ?? tierId, ...(text(tier.description, 4096) ? { description: text(tier.description, 4096) } : {}) }] : [];
    }) } : {}),
    ...(text(item.defaultServiceTier, MAX_ID_LENGTH) ? { defaultServiceTier: text(item.defaultServiceTier, MAX_ID_LENGTH) } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(item.isDefault === true ? { isDefault: true } : {}),
    ...(typeof item.images === "boolean" ? { images: item.images } : {}),
  };
}

function clone(record: CodexSessionRecord): CodexSessionRecord {
  return {
    ...record,
    messages: record.messages.map((message) => ({ ...message })),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.usageTurns ? { usageTurns: record.usageTurns.map((turn) => ({ ...turn })) } : {}),
    ...(record.tools ? { tools: [...record.tools] } : {}),
  };
}

/** `models` is the default instance's list, as before instances; `instanceModels` the others'. */
interface StoredFile { sessions: CodexSessionRecord[]; models: CodexStoredModel[]; instanceModels?: Record<string, CodexStoredModel[]> }

function storedModels(value: unknown): CodexStoredModel[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const model = storedModel(entry); return model ? [model] : []; }) : [];
}

function decodeFile(value: unknown): StoredFile | undefined {
  const item = value as { sessions?: unknown; models?: unknown; instanceModels?: unknown } | undefined;
  if (!item || !Array.isArray(item.sessions)) return undefined;
  const instanceModels = item.instanceModels && typeof item.instanceModels === "object"
    ? Object.fromEntries(Object.entries(item.instanceModels as Record<string, unknown>).flatMap(([id, models]) => instanceOf(id) ? [[id, storedModels(models)]] : []))
    : {};
  return {
    sessions: item.sessions.flatMap((entry) => { const record = storedRecord(entry); return record ? [record] : []; }),
    models: storedModels(item.models),
    instanceModels,
  };
}

function sameInstance(record: CodexSessionRecord, instance: string | undefined): boolean {
  return (record.instance ?? DEFAULT_INSTANCE_ID) === (instance ?? DEFAULT_INSTANCE_ID);
}

export class CodexSessionStore {
  /** Each thread's turns merged per model, by the turn list they came from; a new turn replaces the list. */
  private readonly merged = new WeakMap<readonly UsageTurn[], UsageTally[]>();
  private readonly now: () => number;
  private readonly records = new Map<string, CodexSessionRecord>();
  /** The account's models per instance; the default instance under its id. */
  private models = new Map<string, CodexStoredModel[]>();
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
        this.models = new Map([[DEFAULT_INSTANCE_ID, result?.data.models ?? []], ...Object.entries(result?.data.instanceModels ?? {})]);
      })
      .catch(() => undefined);
    return this.loading;
  }

  /** What a listed thread was billed for, per model, for its row before it opens. */
  talliesOf(tauThreadId: string): UsageTally[] {
    const record = this.records.get(tauThreadId);
    if (!record?.usageTurns) return record ? mergeTallies(usageTurnsOf(record)) : [];
    let merged = this.merged.get(record.usageTurns);
    if (!merged) this.merged.set(record.usageTurns, merged = mergeTallies(record.usageTurns));
    return merged.map((tally) => ({ ...tally }));
  }

  async get(tauThreadId: string): Promise<CodexSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? clone(record) : undefined;
  }

  /** Every thread, or those of one instance (`default` included). */
  async list(instance?: string): Promise<CodexSessionRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => instance === undefined || sameInstance(record, instance))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  /** The thread's record, created on the given instance when it has none. */
  async ensure(tauThreadId: string, cwd: string, instance?: string): Promise<CodexSessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd !== cwd) throw new Error("This Codex thread belongs to another workspace.");
    if (existing && instance !== undefined && !sameInstance(existing, instance)) throw new Error("This Codex thread runs on another instance.");
    if (existing) return clone(existing);
    const owner = instanceOf(instance);
    const record: CodexSessionRecord = { backendKind: "codex", tauThreadId, ...(owner ? { instance: owner } : {}), cwd, messages: [], updatedAt: this.now() };
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

  setSelection(tauThreadId: string, cwd: string, selection: { model?: string | null; effort?: string | null; mode?: string | null; serviceTier?: string | null }): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      for (const key of ["model", "effort", "mode", "serviceTier"] as const) {
        const value = selection[key];
        if (value === undefined) continue;
        if (value) record[key] = value; else delete record[key];
      }
    });
  }

  setSessionHome(tauThreadId: string, cwd: string, sessionHome: string): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => {
      if (record.sessionHome && record.sessionHome !== sessionHome) throw new Error("This Codex thread belongs to a different shared session home. Restore its instance configuration to continue.");
      record.sessionHome = sessionHome;
    });
  }

  async setAccount(tauThreadId: string, cwd: string, accountInstance: string): Promise<void> {
    const previous = await this.ensure(tauThreadId, cwd);
    try {
      await this.update(tauThreadId, cwd, (record) => { record.accountInstance = accountInstance; delete record.serviceTier; });
    } catch (error) {
      this.records.set(tauThreadId, previous);
      throw error;
    }
  }

  /** Restricts a new thread to these tools for good. */
  setTools(tauThreadId: string, cwd: string, tools: readonly string[]): Promise<void> {
    return this.update(tauThreadId, cwd, (record) => { record.tools = [...tools]; });
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
  async adopt(sessions: readonly { codexThreadId: string; cwd: string; title: string; model?: string; messages: readonly CodexStoredMessage[]; usage?: UiThreadUsage; usageTurns?: readonly UsageTurn[]; updatedAt: number }[]): Promise<Array<string | undefined>> {
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
        ...(session.usage ? { usage: { ...session.usage } } : {}),
        ...(session.usageTurns?.length ? { usageTurns: session.usageTurns.map((turn) => ({ ...turn })) } : {}),
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
        const id = text(message.id, MAX_ID_LENGTH);
        record.messages.push({ ...(id ? { id } : {}), role: message.role, text: message.text, timestamp: message.timestamp, ...(clientMessageId ? { clientMessageId } : {}) });
      }
    });
  }

  async listModels(instance = DEFAULT_INSTANCE_ID): Promise<CodexStoredModel[]> {
    await this.load();
    return (this.models.get(instance) ?? []).map((model) => ({ ...model, efforts: [...model.efforts] }));
  }

  async setModels(models: readonly CodexStoredModel[], instance = DEFAULT_INSTANCE_ID): Promise<void> {
    await this.load();
    const next = storedModels(models);
    if (next.length === 0 || JSON.stringify(next) === JSON.stringify(this.models.get(instance) ?? [])) return;
    this.models.set(instance, next);
    await this.persist();
  }

  /** Takes a thread's record out for the host's trash; the CLI's own history stays where it is. */
  async take(tauThreadId: string): Promise<CodexSessionRecord | undefined> {
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
    if (!record || record.tauThreadId !== tauThreadId) throw new Error("This is not the Codex thread that was deleted.");
    if (this.records.has(tauThreadId)) throw new Error("A Codex thread with this id exists again; it was not restored.");
    this.records.set(tauThreadId, record);
    await this.persist();
  }

  private persist(): Promise<void> {
    const { [DEFAULT_INSTANCE_ID]: models = [], ...instanceModels } = Object.fromEntries(this.models);
    return writePersistedJson(this.options.filePath, CURRENT_VERSION, {
      sessions: [...this.records.values()],
      models,
      ...(Object.keys(instanceModels).length ? { instanceModels } : {}),
    }, this.options.logger ? { logger: this.options.logger } : {});
  }
}
