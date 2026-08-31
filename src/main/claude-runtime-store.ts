import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { UiMessage, UiSkillInvocation } from "../shared/contracts.js";
import { visibleSkillEnvelopeText } from "./skill-invocation.js";

const MAX_TEXT_LENGTH = 512 * 1024;
const MAX_TITLE_LENGTH = 120;
const MAX_ID_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export type ClaudeTitleSource = "derived" | "generated" | "renamed";

export interface ClaudeStoredMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  clientMessageId?: string;
  skill?: UiSkillInvocation;
}

export interface ClaudeRuntimeSessionRecord {
  backendKind: "claude-code";
  tauSessionId: string;
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
  updatedAt: number;
}

export interface ClaudeRuntimeSessionStoreOptions {
  filePath: string;
  now?(): number;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

function storedSkill(value: unknown): Pick<UiSkillInvocation, "name" | "command"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const name = boundedString(item.name, MAX_ID_LENGTH);
  const command = boundedString(item.command, MAX_ID_LENGTH);
  if (!name || !command || !SKILL_NAME.test(name)) return undefined;
  if (!/^\/(?:skill:)?[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(command)) return undefined;
  return { name, command };
}

function skillCopyText(skill: Pick<UiSkillInvocation, "command">, visibleText: string): string {
  return visibleText ? `${skill.command} ${visibleText}` : skill.command;
}

function visibleStoredText(role: "user" | "assistant", text: string): string {
  if (role !== "user") return text;
  const envelope = visibleSkillEnvelopeText(text);
  if (envelope !== undefined) return envelope;
  return /^\uFEFF?(?:[ \t]*\r?\n)*[ \t]*<skill\b/iu.test(text) ? "Skill invocation" : text;
}

function visibleStoredTitle(text: string): string {
  const visible = visibleStoredText("user", text);
  // A malformed title must never turn runtime attributes or a local path into
  // sidebar data. Complete envelopes already return only their visible suffix.
  return visible === text && /<skill\b|\blocation\s*=/iu.test(text) ? "Skill invocation" : visible;
}

function storedMessage(value: unknown): ClaudeStoredMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  const rawText = typeof item.text === "string" && item.text.length <= MAX_TEXT_LENGTH ? item.text : undefined;
  const timestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp) ? item.timestamp : undefined;
  if (rawText === undefined || timestamp === undefined) return undefined;
  const text = visibleStoredText(item.role, rawText);
  const clientMessageId = boundedString(item.clientMessageId, MAX_ID_LENGTH);
  const parsedSkill = item.role === "user" ? storedSkill(item.skill) : undefined;
  const skill = parsedSkill ? { ...parsedSkill, copyText: skillCopyText(parsedSkill, text) } : undefined;
  return {
    role: item.role,
    text,
    timestamp,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(skill ? { skill } : {}),
  };
}

function storedRecord(value: unknown): ClaudeRuntimeSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const tauSessionId = boundedString(item.tauSessionId, MAX_ID_LENGTH);
  const claudeSessionId = boundedString(item.claudeSessionId, MAX_ID_LENGTH);
  const cwd = boundedString(item.cwd, 4_096);
  const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined;
  if (!tauSessionId || !claudeSessionId || !UUID.test(claudeSessionId) || !cwd || updatedAt === undefined) return undefined;
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
    tauSessionId,
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
  return { ...record, messages: record.messages.map(cloneMessage) };
}

/** App-data persistence for Claude session ids and the visible Tau projection. */
export class ClaudeRuntimeSessionStore {
  private readonly now: () => number;
  private readonly records = new Map<string, ClaudeRuntimeSessionRecord>();
  private loaded = false;
  private loading?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ClaudeRuntimeSessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  static defaultPath(agentDir: string): string {
    return join(agentDir, "tau", "claude-runtime-sessions.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.readFromDisk();
    await this.loading;
  }

  private async readFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.filePath, "utf8")) as unknown;
      const values = parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : [];
      for (const value of values) {
        const record = storedRecord(value);
        if (record) this.records.set(record.tauSessionId, record);
      }
      await chmod(this.options.filePath, 0o600).catch(() => undefined);
    } catch {
      // Missing or corrupt app state must not prevent the workbench from opening.
      this.records.clear();
    } finally {
      this.loaded = true;
    }
  }

  async get(tauSessionId: string): Promise<ClaudeRuntimeSessionRecord | undefined> {
    await this.load();
    const record = this.records.get(tauSessionId);
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

  async ensure(tauSessionId: string, cwd: string): Promise<ClaudeRuntimeSessionRecord> {
    await this.load();
    const existing = this.records.get(tauSessionId);
    if (existing && existing.cwd === cwd) return cloneRecord(existing);
    if (existing) throw new Error("Claude runtime session belongs to another workspace.");
    const record: ClaudeRuntimeSessionRecord = {
      backendKind: "claude-code",
      tauSessionId,
      claudeSessionId: randomUUID(),
      cwd,
      started: false,
      attempted: false,
      attemptCount: 0,
      createFallbackUsed: false,
      messages: [],
      updatedAt: this.now(),
    };
    this.records.set(tauSessionId, record);
    await this.persist();
    return cloneRecord(record);
  }

  async markStarted(tauSessionId: string, cwd: string): Promise<void> {
    const record = await this.ensure(tauSessionId, cwd);
    const current = this.records.get(tauSessionId);
    if (!current || current.claudeSessionId !== record.claudeSessionId || current.started) return;
    current.started = true;
    current.attempted = true;
    current.lastAttemptOutcome = "started";
    current.updatedAt = this.now();
    await this.persist();
  }

  /** Records the attempt before a child process is created. */
  async markAttempted(tauSessionId: string, cwd: string): Promise<ClaudeRuntimeSessionRecord> {
    await this.ensure(tauSessionId, cwd);
    const record = this.records.get(tauSessionId);
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
    tauSessionId: string,
    cwd: string,
    outcome: "started" | "missing" | "failed" | "aborted",
  ): Promise<void> {
    await this.ensure(tauSessionId, cwd);
    const record = this.records.get(tauSessionId);
    if (!record) return;
    record.attempted = true;
    record.lastAttemptOutcome = outcome;
    record.updatedAt = this.now();
    await this.persist();
  }

  async markCreateFallbackUsed(tauSessionId: string, cwd: string): Promise<void> {
    await this.ensure(tauSessionId, cwd);
    const record = this.records.get(tauSessionId);
    if (!record || record.createFallbackUsed) return;
    record.createFallbackUsed = true;
    record.updatedAt = this.now();
    await this.persist();
  }

  async appendExchange(
    tauSessionId: string,
    cwd: string,
    messages: readonly UiMessage[],
  ): Promise<void> {
    await this.ensure(tauSessionId, cwd);
    const record = this.records.get(tauSessionId);
    if (!record) return;
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const visibleText = visibleStoredText(message.role, message.text);
      const parsedSkill = message.role === "user" && message.skill
        ? storedSkill(message.skill)
        : undefined;
      const stored: ClaudeStoredMessage = {
        role: message.role,
        text: visibleText,
        timestamp: message.timestamp,
        ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
        ...(parsedSkill ? { skill: { ...parsedSkill, copyText: skillCopyText(parsedSkill, visibleText) } } : {}),
      };
      // Only a stable client id makes a user turn idempotent. Timestamp/text
      // pairs are not identities: two identical assistant replies can be
      // legitimate turns and must remain in the append-only history.
      const existing = stored.clientMessageId
        ? record.messages.findIndex((item) => item.role === stored.role && item.clientMessageId === stored.clientMessageId)
        : -1;
      if (existing >= 0) record.messages[existing] = stored;
      else record.messages.push(stored);
    }
    record.updatedAt = this.now();
    await this.persist();
  }

  async setTitle(tauSessionId: string, cwd: string, title: string, source: ClaudeTitleSource): Promise<void> {
    await this.ensure(tauSessionId, cwd);
    const record = this.records.get(tauSessionId);
    if (!record) return;
    const safeTitle = visibleStoredTitle(title).slice(0, MAX_TITLE_LENGTH);
    if (safeTitle) record.title = safeTitle;
    else delete record.title;
    record.titleSource = source;
    record.updatedAt = this.now();
    await this.persist();
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const contents = `${JSON.stringify({ version: 1, sessions: [...this.records.values()] }, null, 2)}\n`;
      const directory = dirname(this.options.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700).catch(() => undefined);
      const temporary = `${this.options.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600).catch(() => undefined);
        await rename(temporary, this.options.filePath);
        await chmod(this.options.filePath, 0o600).catch(() => undefined);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    return this.writeQueue;
  }
}
