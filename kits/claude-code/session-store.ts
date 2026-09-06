import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseSkillEnvelope, readPersistedJson, writePersistedJson, type PersistedJsonLogger, type ThreadTitleSource, type UiMessage, type UiSkillInvocation, type UiThreadUsage } from "tau/host-extension";

/** Bumped when the on-disk shape changes; `load()` stays backward compatible. */
const CURRENT_VERSION = 1;

/** Large messages are represented as UTF-8-safe chunks on disk, never dropped. */
const TEXT_CHUNK_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;


export type ClaudeTitleSource = ThreadTitleSource;

export interface ClaudeStoredMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
  skill?: UiSkillInvocation;
}

export interface ClaudeRuntimeSessionRecord {
  backendKind: "claude-code";
  /** Stable Tau thread key; never use the provider's session id here. */
  tauThreadId: string;
  claudeSessionId: string;
  cwd: string;
  started: boolean;
  /** A launch attempt is durable before the child process is spawned. */
  attempted: boolean;
  attemptCount: number;
  /** A missing resumed session gets at most one fresh-session recovery. */
  createFallbackUsed: boolean;
  lastAttemptAt?: number;
  lastAttemptOutcome?: "pending" | "started" | "missing" | "failed" | "aborted";
  messages: ClaudeStoredMessage[];
  title?: string;
  titleSource?: ClaudeTitleSource;
  /** Tokens and cost of every turn so far, so the index shows them after a restart. */
  usage?: UiThreadUsage;
  updatedAt: number;
}

export interface ClaudeRuntimeSessionStoreOptions {
  filePath: string;
  now?(): number;
  logger?: PersistedJsonLogger;
  /**
   * @deprecated Skill knowledge is request-scoped. Pass it to appendExchange
   * instead; this option is accepted only for source compatibility and never
   * migrates records.
   */
  knownSkillNames?: readonly string[];
}

export interface ClaudeExchangeOptions {
  /**
   * Catalog names proven by the runtime owner for this one append request.
   * They are never retained by the app-data store or applied to old records.
   */
  knownSkillNames?: Iterable<string>;
}

interface StoredMessageOnDisk {
  role: "user" | "assistant";
  text?: string;
  textChunks?: string[];
  timestamp: number;
  clientMessageId?: string;
  skill?: UiSkillInvocation;
}

function chunkText(value: string, maxBytes = TEXT_CHUNK_BYTES): string[] {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const part = value.slice(index, index + width);
    const partBytes = Buffer.byteLength(part, "utf8");
    if (index > start && bytes + partBytes > maxBytes) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += partBytes;
    index += width;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

function serializeMessage(message: ClaudeStoredMessage): StoredMessageOnDisk {
  const chunks = chunkText(message.text);
  return {
    role: message.role,
    ...(chunks.length === 1 ? { text: chunks[0] } : { textChunks: chunks }),
    timestamp: message.timestamp,
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    ...(message.skill ? { skill: { ...message.skill } } : {}),
  };
}

function serializeRecord(record: ClaudeRuntimeSessionRecord): Omit<ClaudeRuntimeSessionRecord, "messages"> & { messages: StoredMessageOnDisk[] } {
  return { ...record, messages: record.messages.map(serializeMessage) };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

function storedSkill(value: unknown): UiSkillInvocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const name = boundedString(item.name, MAX_ID_LENGTH);
  const command = boundedString(item.command, MAX_ID_LENGTH);
  const copyText = typeof item.copyText === "string" ? item.copyText : undefined;
  if (!name || !command || !copyText || !SKILL_NAME.test(name)) return undefined;
  if (!/^\/(?:skill:)?[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(command)) return undefined;
  const commandName = command.replace(/^\/skill:/u, "").replace(/^\//u, "");
  if (commandName !== name) return undefined;
  return { name, command, copyText };
}

function skillCopyText(skill: Pick<UiSkillInvocation, "command">, visibleText: string): string {
  return visibleText ? `${skill.command} ${visibleText}` : skill.command;
}

function runtimeLikeEnvelope(text: string): boolean {
  return /^(?:\uFEFF)?(?:(?:[ \t]{0,3})\r?\n)*[ \t]{0,3}<skill(?:[ \t\r\n>])/u.test(text);
}

function visibleStoredText(
  role: "user" | "assistant",
  text: string,
  metadata: UiSkillInvocation | undefined,
  knownSkills: ReadonlySet<string>,
): string {
  if (role !== "user") return text;
  // A runtime envelope is hidden only when the host persisted matching,
  // validated skill metadata with it. Without that proof, unknown and
  // malformed wrappers are ordinary user text and must survive reload.
  const envelope = parseSkillEnvelope(text);
  if (envelope && metadata && knownSkills.has(metadata.name)) {
    const parsedName = envelope.name;
    const commandName = metadata.command.replace(/^\/skill:/u, "").replace(/^\//u, "");
    if (parsedName === metadata.name && parsedName === commandName) return envelope.userMessage;
  }
  return text;
}

function visibleStoredTitle(text: string): string {
  // Titles have no skill metadata channel. Never derive a title from raw
  // runtime syntax or a local location; use a generic safe label instead.
  return /<skill\b/iu.test(text) ? "Skill invocation" : text;
}

function storedMessage(value: unknown): ClaudeStoredMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  const rawText = typeof item.text === "string"
    ? item.text
    : Array.isArray(item.textChunks) && item.textChunks.every((chunk) => typeof chunk === "string")
      ? item.textChunks.join("")
      : undefined;
  const timestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp) ? item.timestamp : undefined;
  if (rawText === undefined || timestamp === undefined) return undefined;
  const clientMessageId = boundedString(item.clientMessageId, MAX_ID_LENGTH);
  const parsedSkill = item.role === "user" ? storedSkill(item.skill) : undefined;
  // Disk reads are deliberately lossless. A raw runtime-looking value is
  // never reinterpreted later when another workspace happens to know the same
  // skill; only appendExchange may normalize a new, Tau-authorized request.
  const text = rawText;
  // Structured metadata is usable after reload only when the stored text is
  // already the visible projection. Legacy raw envelopes remain plain text,
  // even if they carry forged or stale metadata, so they cannot turn into a
  // chip (or lose their body) after a later catalog change.
  const metadataIsConsistent = parsedSkill !== undefined
    && !runtimeLikeEnvelope(rawText)
    && parsedSkill.copyText === skillCopyText(parsedSkill, text);
  const skill = metadataIsConsistent ? parsedSkill : undefined;
  return {
    role: item.role,
    text,
    timestamp,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(skill ? { skill } : {}),
  };
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;

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

function storedRecord(value: unknown): ClaudeRuntimeSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  // Read the pre-backend-ownership key once for migration, but always expose
  // the canonical Tau thread name to the rest of the application.
  const tauThreadId = boundedString(item.tauThreadId ?? item.tauSessionId, MAX_ID_LENGTH);
  const claudeSessionId = boundedString(item.claudeSessionId, MAX_ID_LENGTH);
  const cwd = boundedString(item.cwd, 4_096);
  const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined;
  if (!tauThreadId || !claudeSessionId || !UUID.test(claudeSessionId) || !cwd || updatedAt === undefined) return undefined;
  const messages = Array.isArray(item.messages)
    ? item.messages.flatMap((message) => {
      const parsed = storedMessage(message);
      return parsed ? [parsed] : [];
    })
    : [];
  const rawTitle = typeof item.title === "string" && item.title.length <= MAX_TITLE_LENGTH && item.title.trim()
    ? item.title
    : undefined;
  const title = rawTitle ? visibleStoredTitle(rawTitle) : undefined;
  const titleSource = item.titleSource === "derived" || item.titleSource === "generated" || item.titleSource === "renamed"
    ? item.titleSource
    : undefined;
  return {
    backendKind: "claude-code",
    tauThreadId,
    claudeSessionId,
    cwd,
    started: item.started === true,
    attempted: item.attempted === true || item.started === true,
    attemptCount: typeof item.attemptCount === "number" && Number.isInteger(item.attemptCount) && item.attemptCount >= 0
      ? item.attemptCount
      : item.started === true ? 1 : 0,
    createFallbackUsed: item.createFallbackUsed === true,
    ...(typeof item.lastAttemptAt === "number" && Number.isFinite(item.lastAttemptAt) ? { lastAttemptAt: item.lastAttemptAt } : {}),
    ...(item.lastAttemptOutcome === "pending" || item.lastAttemptOutcome === "started" || item.lastAttemptOutcome === "missing" || item.lastAttemptOutcome === "failed" || item.lastAttemptOutcome === "aborted"
      ? { lastAttemptOutcome: item.lastAttemptOutcome }
      : {}),
    messages,
    ...(title ? { title } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(storedUsage(item.usage) ? { usage: storedUsage(item.usage) } : {}),
    updatedAt,
  };
}

function cloneMessage(message: ClaudeStoredMessage): ClaudeStoredMessage {
  return {
    ...message,
    ...(message.skill ? { skill: { ...message.skill } } : {}),
  };
}

function cloneRecord(record: ClaudeRuntimeSessionRecord): ClaudeRuntimeSessionRecord {
  return { ...record, messages: record.messages.map(cloneMessage), ...(record.usage ? { usage: { ...record.usage } } : {}) };
}

function sameStoredMessage(left: ClaudeStoredMessage, right: ClaudeStoredMessage): boolean {
  return left.role === right.role
    && left.text === right.text
    && left.timestamp === right.timestamp
    && left.clientMessageId === right.clientMessageId
    && JSON.stringify(left.skill ?? null) === JSON.stringify(right.skill ?? null);
}

/** Accepts the current `{ sessions: [...] }` shape and a legacy bare array of sessions. */
function decodeSessions(value: unknown): ClaudeRuntimeSessionRecord[] | undefined {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : undefined;
  if (!values) return undefined;
  return values.flatMap((item) => {
    const record = storedRecord(item);
    return record ? [record] : [];
  });
}

/** App-data persistence for Claude session ids and the visible Tau projection. */
export class ClaudeRuntimeSessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, ClaudeRuntimeSessionRecord>();
  private loaded = false;
  private loading?: Promise<void>;

  constructor(private readonly options: ClaudeRuntimeSessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Beside the Pi session directory: `~/.pi/agent/tau/` for the default store,
   * and a dev instance's own `.tau-dev/tau/` when its sessions are redirected,
   * so a test thread never lands in the user's real sidebar.
   */
  static defaultPath(sessionsDir: string): string {
    return join(dirname(sessionsDir), "tau", "claude-runtime-sessions.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.readFromDisk();
    await this.loading;
  }

  /**
   * Kept as a compatibility no-op for older host callers. Skill catalogs are
   * request-scoped and must never be retained by this app-data store: in
   * particular, opening a workspace where a skill exists cannot reinterpret
   * or rewrite a raw message belonging to another workspace or thread.
   */
  async setKnownSkillNames(_names: Iterable<string>): Promise<void> {
    await this.load();
  }

  private async readFromDisk(): Promise<void> {
    try {
      const result = await readPersistedJson(this.options.filePath, {
        expectedVersion: CURRENT_VERSION,
        decode: decodeSessions,
        logger: this.options.logger,
      });
      if (result) {
        for (const record of result.data) this.records.set(record.tauThreadId, record);
        await chmod(this.options.filePath, 0o600).catch(() => undefined);
      }
    } catch {
      // Missing or corrupt app state must not prevent the workbench from opening.
      this.records.clear();
    } finally {
      this.loaded = true;
    }
  }

  async get(tauThreadId: string): Promise<ClaudeRuntimeSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauThreadId);
    return record ? cloneRecord(record) : undefined;
  }

  /** Returns the durable adapter sessions for startup/index recovery. */
  async list(cwd?: string): Promise<ClaudeRuntimeSessionRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => cwd === undefined || record.cwd === cwd)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneRecord);
  }

  async ensure(tauThreadId: string, cwd: string): Promise<ClaudeRuntimeSessionRecord> {
    await this.load();
    const existing = this.records.get(tauThreadId);
    if (existing && existing.cwd === cwd) return cloneRecord(existing);
    if (existing) throw new Error("Claude runtime session belongs to another workspace.");
    const record: ClaudeRuntimeSessionRecord = {
      backendKind: "claude-code",
      tauThreadId,
      claudeSessionId: randomUUID(),
      cwd,
      started: false,
      attempted: false,
      attemptCount: 0,
      createFallbackUsed: false,
      messages: [],
      updatedAt: this.now(),
    };
    this.records.set(tauThreadId, record);
    await this.persist();
    return cloneRecord(record);
  }

  async markStarted(tauThreadId: string, cwd: string): Promise<void> {
    const record = await this.ensure(tauThreadId, cwd);
    const current = this.records.get(tauThreadId);
    if (!current || current.claudeSessionId !== record.claudeSessionId || current.started) return;
    current.started = true;
    current.attempted = true;
    current.lastAttemptOutcome = "started";
    current.updatedAt = this.now();
    await this.persist();
  }

  /** Records the attempt before a child process is created. */
  async markAttempted(tauThreadId: string, cwd: string): Promise<ClaudeRuntimeSessionRecord> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) throw new Error("Claude runtime session could not be persisted.");
    record.attempted = true;
    record.attemptCount += 1;
    record.lastAttemptAt = this.now();
    record.lastAttemptOutcome = "pending";
    record.updatedAt = this.now();
    await this.persist();
    return cloneRecord(record);
  }

  async markAttemptOutcome(
    tauThreadId: string,
    cwd: string,
    outcome: "started" | "missing" | "failed" | "aborted",
  ): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) return;
    record.attempted = true;
    record.lastAttemptOutcome = outcome;
    record.updatedAt = this.now();
    await this.persist();
  }

  /** Replaces the thread's running total; the backend sums turns itself. */
  async recordUsage(tauThreadId: string, cwd: string, usage: UiThreadUsage): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) return;
    record.usage = { ...usage };
    record.updatedAt = this.now();
    await this.persist();
  }

  async markCreateFallbackUsed(tauThreadId: string, cwd: string): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record || record.createFallbackUsed) return;
    record.createFallbackUsed = true;
    record.updatedAt = this.now();
    await this.persist();
  }

  async appendExchange(
    tauThreadId: string,
    cwd: string,
    messages: readonly UiMessage[],
    options: ClaudeExchangeOptions = {},
  ): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) return;
    const knownSkills = new Set([...options.knownSkillNames ?? []].filter((name) => SKILL_NAME.test(name)));
    const additions: ClaudeStoredMessage[] = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const parsedSkill = message.role === "user" && message.skill
        ? storedSkill(message.skill)
        : undefined;
      const visibleText = visibleStoredText(message.role, message.text, parsedSkill, knownSkills);
      const clientMessageId = boundedString(message.clientMessageId, MAX_ID_LENGTH);
      const stored: ClaudeStoredMessage = {
        role: message.role,
        text: visibleText,
        timestamp: message.timestamp,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(parsedSkill && knownSkills.has(parsedSkill.name)
          && parsedSkill.copyText === skillCopyText(parsedSkill, visibleText)
          && (!runtimeLikeEnvelope(message.text) || parseSkillEnvelope(message.text) !== undefined)
          ? { skill: parsedSkill }
          : {}),
      };
      // Only a stable client id makes a replay idempotent. Identical replays
      // are ignored after verification; a conflicting replay is rejected so
      // append-only history can never be silently replaced.
      if (stored.clientMessageId) {
        const existing = [...record.messages, ...additions].find((item) => item.clientMessageId === stored.clientMessageId);
        if (existing) {
          if (sameStoredMessage(existing, stored)) continue;
          throw new Error(`Claude transcript already contains a conflicting message id '${stored.clientMessageId}'.`);
        }
      }
      additions.push(stored);
    }
    record.messages.push(...additions);
    record.updatedAt = this.now();
    await this.persist();
  }

  async setTitle(tauThreadId: string, cwd: string, title: string, source: ClaudeTitleSource): Promise<void> {
    await this.ensure(tauThreadId, cwd);
    const record = this.records.get(tauThreadId);
    if (!record) return;
    const safeTitle = visibleStoredTitle(title).slice(0, MAX_TITLE_LENGTH);
    if (safeTitle) record.title = safeTitle;
    else delete record.title;
    record.titleSource = source;
    record.updatedAt = this.now();
    await this.persist();
  }

  private persist(): Promise<void> {
    const sessions = [...this.records.values()].map(serializeRecord);
    return writePersistedJson(this.options.filePath, CURRENT_VERSION, { sessions }, { logger: this.options.logger });
  }
}
