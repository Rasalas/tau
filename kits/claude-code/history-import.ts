import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { unpricedUsage, type UiModelBilling, type UsageTurn } from "tau/host-extension";
import { sessionUsageTurns } from "../usage/session-usage.js";
import type { ClaudeRuntimeSessionStore, ClaudeStoredMessage } from "./session-store.js";

/**
 * Sessions the CLI ran outside Tau, read from its own home: one JSONL file per
 * session under `projects/<encoded cwd>/<session id>.jsonl`. Only the visible
 * user and assistant text is kept; tools, thinking and attachments are not.
 */

/** Fixture homes for tests and dev instances: `<root>/claude-code` replaces the CLI's own home. */
export const IMPORT_ROOTS_VARIABLE = "TAU_IMPORT_ROOTS";
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SCANNED_FILES = 500;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const HEAD_CHUNK_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_TITLE = 100;

export interface ImportableSession {
  path: string;
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  /** Tau already holds this session, imported or started here. */
  imported: boolean;
}

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  title: string;
  model?: string;
  messages: ClaudeStoredMessage[];
  /** When each prompt was sent, the ones the kept messages drop included. */
  prompts: number[];
}

/** The CLI's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
}

export function claudeProjectDirs(env: NodeJS.ProcessEnv): string[] {
  const roots = env[IMPORT_ROOTS_VARIABLE]?.split(delimiter).filter(Boolean);
  if (roots?.length) return roots.map((root) => join(resolve(root), "claude-code", "projects"));
  return [join(claudeConfigDir(env), "projects")];
}

function text(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
      ? [((block as { text: string }).text).trim()]
      : [])
    .filter(Boolean)
    .join("\n");
}

/** Slash-command echoes and reminders the CLI writes as user entries. */
const GENERATED = /^<(?:command-|local-command-|system-reminder|bash-)/u;

function titleOf(value: string): string {
  return (value.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, MAX_TITLE);
}

/** Visible text of a transcript; `undefined` without a resumable session id or a user message. */
export function parseClaudeSession(lines: Iterable<string>, fallback: { sessionId?: string; updatedAt: number }): ParsedSession | undefined {
  let sessionId = fallback.sessionId ?? "";
  let cwd = "";
  let summary: string | undefined;
  let model: string | undefined;
  const messages: ClaudeStoredMessage[] = [];
  for (const line of lines) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!record || typeof record !== "object") continue;
    if (record.type === "summary" && typeof record.summary === "string") { summary ??= record.summary.trim() || undefined; continue; }
    if (typeof record.aiTitle === "string" && record.aiTitle.trim()) summary = record.aiTitle.trim();
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) continue;
    if (typeof record.sessionId === "string" && record.sessionId) sessionId = record.sessionId;
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = record.message as { content?: unknown; model?: unknown } | undefined;
    const body = text(message?.content);
    if (!body || (record.type === "user" && GENERATED.test(body))) continue;
    if (record.type === "assistant" && typeof message?.model === "string" && message.model !== "<synthetic>") model = message.model;
    const timestamp = typeof record.timestamp === "string" && Date.parse(record.timestamp) || fallback.updatedAt;
    const last = messages.at(-1);
    // One reply arrives as one entry per content block; tool results between them are skipped.
    if (record.type === "assistant" && last?.role === "assistant") last.text = `${last.text}\n\n${body}`;
    else messages.push({ role: record.type, text: body, timestamp });
  }
  const first = messages.find((message) => message.role === "user");
  if (!UUID.test(sessionId) || !cwd || !first) return undefined;
  // The first prompt names the conversation; the newest messages are the ones worth reading.
  const kept = messages.length <= MAX_MESSAGES ? messages : [first, ...messages.slice(-(MAX_MESSAGES - 1))];
  const prompts = messages.flatMap((message) => message.role === "user" ? [message.timestamp] : []);
  return { sessionId, cwd, title: titleOf(summary ?? first.text) || "Imported conversation", ...(model ? { model } : {}), messages: kept, prompts };
}

async function sessionFiles(dirs: readonly string[]): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const dir of dirs) {
    const projects = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const entries = await readdir(join(dir, project.name), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const path = join(dir, project.name, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/** Complete lines from the start of a file, read until `enough` says so or the cap is reached. */
async function headLines(path: string, enough: (lines: string[]) => boolean): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let lines: string[] = [];
    for (let offset = 0; offset < MAX_HEAD_BYTES; offset += HEAD_CHUNK_BYTES) {
      const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, HEAD_CHUNK_BYTES, offset);
      buffer += decoder.write(chunk.subarray(0, bytesRead));
      const done = bytesRead < HEAD_CHUNK_BYTES;
      const parts = buffer.split("\n");
      buffer = done ? "" : parts.pop() ?? "";
      lines = lines.concat(parts.filter(Boolean));
      if (done || enough(lines)) break;
    }
    return lines;
  } finally {
    await handle.close();
  }
}

/** The newest sessions of the CLI's home, from the head of each file. */
export async function scanClaudeSessions(dirs: readonly string[], known: (sessionId: string) => boolean): Promise<{ sessions: ImportableSession[]; truncated: boolean }> {
  const files = await sessionFiles(dirs);
  const sessions: ImportableSession[] = [];
  for (const file of files.slice(0, MAX_SCANNED_FILES)) {
    if (file.size > MAX_FILE_BYTES) continue;
    const fallback = { sessionId: file.path.slice(-42, -6), updatedAt: file.mtimeMs };
    const lines = await headLines(file.path, (read) => parseClaudeSession(read, fallback) !== undefined).catch(() => []);
    const parsed = parseClaudeSession(lines, fallback);
    if (!parsed) continue;
    sessions.push({ path: file.path, sessionId: parsed.sessionId, cwd: parsed.cwd, title: parsed.title, updatedAt: Math.round(file.mtimeMs), imported: known(parsed.sessionId) });
  }
  return { sessions, truncated: files.length > MAX_SCANNED_FILES };
}

/** A path the caller named, if it is a session file inside one of the homes. */
export async function sessionFileWithin(dirs: readonly string[], path: unknown): Promise<string | undefined> {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) return undefined;
  const real = await realpath(path).catch(() => undefined);
  if (!real) return undefined;
  for (const dir of dirs) {
    const root = await realpath(dir).catch(() => undefined);
    const inside = root ? relative(root, real) : "..";
    if (!inside.startsWith("..") && !isAbsolute(inside)) return real;
  }
  return undefined;
}

/** The session a file holds, and what its responses used, each prompt's apart. */
export async function readClaudeSession(path: string, billing?: UiModelBilling): Promise<(ParsedSession & { usageTurns: UsageTurn[] }) | undefined> {
  const info = await stat(path);
  if (info.size > MAX_FILE_BYTES) throw new Error("larger than 16 MiB");
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const session = parseClaudeSession(lines, { sessionId: path.slice(-42, -6), updatedAt: info.mtimeMs });
  return session && { ...session, usageTurns: sessionUsageTurns("agent-sdk", lines, { sessionId: session.sessionId, prompts: session.prompts, ...(billing ? { billing } : {}) }) };
}

export interface ImportOutcome {
  /** Thread ids of the sessions this call added. */
  imported: string[];
  /** Sessions Tau already held. */
  skipped: number;
  failed: Array<{ path: string; reason: string }>;
}

/** `billing` is the login's now, as work outside Tau is counted: the log does not say how it was paid. */
export async function importClaudeSessions(
  dirs: readonly string[],
  paths: unknown,
  store: Pick<ClaudeRuntimeSessionStore, "adopt">,
  billing?: UiModelBilling,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], skipped: 0, failed: [] };
  const parsed: Array<ParsedSession & { usageTurns: UsageTurn[]; updatedAt: number }> = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const file = await sessionFileWithin(dirs, path);
    if (!file) { outcome.failed.push({ path: String(path), reason: "not a session file of Claude Code" }); continue; }
    try {
      const session = await readClaudeSession(file, billing);
      if (!session) { outcome.failed.push({ path: file, reason: "no conversation to resume" }); continue; }
      parsed.push({ ...session, updatedAt: session.messages.at(-1)?.timestamp ?? Date.now() });
    } catch (error) {
      outcome.failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const ids = await store.adopt(parsed.map((session) => {
    const usage = unpricedUsage(session.usageTurns);
    return { ...session, claudeSessionId: session.sessionId, ...(usage ? { usage } : {}) };
  }));
  for (const id of ids) {
    if (id) outcome.imported.push(id);
    else outcome.skipped += 1;
  }
  return outcome;
}
