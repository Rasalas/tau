import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { unpricedUsage, type UiModelBilling, type UsageTurn } from "tau/host-extension";
import { sessionUsageTurns } from "../usage/session-usage.js";
import type { CodexSessionStore, CodexStoredMessage } from "./session-store.js";

/**
 * Sessions the CLI ran outside Tau, read from its own home: one rollout file
 * per session under `sessions/YYYY/MM/DD/rollout-*.jsonl`. Only the visible
 * user and assistant text is kept; tools, reasoning and attachments are not.
 */

/** Fixture homes for tests and dev instances: `<root>/codex` replaces the CLI's own home. */
export const IMPORT_ROOTS_VARIABLE = "TAU_IMPORT_ROOTS";
const ROLLOUT_FILE = /^rollout-.+\.jsonl$/u;
const MAX_DEPTH = 4;
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
  messages: CodexStoredMessage[];
  /** When each prompt was sent, the ones the kept messages drop included. */
  prompts: number[];
}

export function codexSessionDirs(env: NodeJS.ProcessEnv): string[] {
  const roots = env[IMPORT_ROOTS_VARIABLE]?.split(delimiter).filter(Boolean);
  if (roots?.length) return roots.map((root) => join(resolve(root), "codex", "sessions"));
  return [join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions")];
}

function text(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const item = block as { type?: unknown; text?: unknown } | null;
      return item && ["input_text", "output_text", "text"].includes(item.type as string) && typeof item.text === "string" ? [item.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n");
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Context the CLI puts into the conversation as if the user had written it. */
const GENERATED = /^(?:<(?:environment_context|user_instructions|user_shell_command|turn_aborted)>|# AGENTS\.md instructions)/u;

function titleOf(value: string): string {
  return (value.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, MAX_TITLE);
}

type Rollout = { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };

/**
 * Visible text of a rollout. A current CLI writes each prompt twice — as a
 * response item and as a `user_message` event — and each reply as a response
 * item and an `agent_message` event; the events carry the user's own words,
 * the response items the reply, and an older rollout has only the items.
 */
export function parseCodexSession(lines: Iterable<string>, fallbackUpdatedAt: number): ParsedSession | undefined {
  const records: Rollout[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Rollout;
      if (record && typeof record === "object") records.push(record);
    } catch { /* a torn or foreign line */ }
  }
  const isItem = (record: Rollout, role: string) => record.type === "response_item" && record.payload?.type === "message" && record.payload.role === role;
  const userEvents = records.some((record) => record.type === "event_msg" && record.payload?.type === "user_message");
  const replyItems = records.some((record) => isItem(record, "assistant"));
  let sessionId = "";
  let cwd = "";
  let model: string | undefined;
  const messages: CodexStoredMessage[] = [];
  for (const record of records) {
    const payload = record.payload ?? {};
    if (record.type === "session_meta") {
      sessionId ||= string(payload.id) ?? "";
      cwd ||= string(payload.cwd) ?? "";
      continue;
    }
    if (record.type === "turn_context") { model = string(payload.model) ?? model; continue; }
    let role: "user" | "assistant" | undefined;
    let body = "";
    if (record.type === "event_msg" && payload.type === "user_message") [role, body] = ["user", string(payload.message) ?? ""];
    else if (record.type === "event_msg" && payload.type === "agent_message" && !replyItems) [role, body] = ["assistant", string(payload.message) ?? ""];
    else if (isItem(record, "assistant")) [role, body] = ["assistant", text(payload.content)];
    else if (isItem(record, "user") && !userEvents) [role, body] = ["user", text(payload.content)];
    if (!role || !body || (role === "user" && GENERATED.test(body))) continue;
    const timestamp = typeof record.timestamp === "string" && Date.parse(record.timestamp) || fallbackUpdatedAt;
    const last = messages.at(-1);
    if (role === "assistant" && last?.role === "assistant") last.text = `${last.text}\n\n${body}`;
    else messages.push({ role, text: body, timestamp });
  }
  const first = messages.find((message) => message.role === "user");
  if (!sessionId || !cwd || !first) return undefined;
  const kept = messages.length <= MAX_MESSAGES ? messages : [first, ...messages.slice(-(MAX_MESSAGES - 1))];
  const prompts = messages.flatMap((message) => message.role === "user" ? [message.timestamp] : []);
  return { sessionId, cwd, title: titleOf(first.text) || "Imported conversation", ...(model ? { model } : {}), messages: kept, prompts };
}

async function rolloutFiles(dirs: readonly string[]): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) await walk(path, depth + 1);
      else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
        const info = await stat(path).catch(() => undefined);
        if (info) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  };
  for (const dir of dirs) await walk(dir, 1);
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
export async function scanCodexSessions(dirs: readonly string[], known: (sessionId: string) => boolean): Promise<{ sessions: ImportableSession[]; truncated: boolean }> {
  const files = await rolloutFiles(dirs);
  const sessions: ImportableSession[] = [];
  for (const file of files.slice(0, MAX_SCANNED_FILES)) {
    if (file.size > MAX_FILE_BYTES) continue;
    const lines = await headLines(file.path, (read) => parseCodexSession(read, file.mtimeMs) !== undefined).catch(() => []);
    const parsed = parseCodexSession(lines, file.mtimeMs);
    if (!parsed) continue;
    sessions.push({ path: file.path, sessionId: parsed.sessionId, cwd: parsed.cwd, title: parsed.title, updatedAt: Math.round(file.mtimeMs), imported: known(parsed.sessionId) });
  }
  return { sessions, truncated: files.length > MAX_SCANNED_FILES };
}

/** A path the caller named, if it is a rollout file inside one of the homes. */
export async function rolloutWithin(dirs: readonly string[], path: unknown): Promise<string | undefined> {
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

export interface ImportOutcome {
  /** Thread ids of the sessions this call added. */
  imported: string[];
  /** Sessions Tau already held. */
  skipped: number;
  failed: Array<{ path: string; reason: string }>;
}

/** `billing` is the login's now, as work outside Tau is counted: the log does not say how it was paid. */
export async function importCodexSessions(dirs: readonly string[], paths: unknown, store: Pick<CodexSessionStore, "adopt">, billing?: UiModelBilling): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], skipped: 0, failed: [] };
  const parsed: Array<ParsedSession & { usageTurns: UsageTurn[] }> = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const file = await rolloutWithin(dirs, path);
    if (!file) { outcome.failed.push({ path: String(path), reason: "not a session file of Codex" }); continue; }
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error("larger than 16 MiB");
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      const session = parseCodexSession(lines, Date.now());
      if (session) parsed.push({ ...session, usageTurns: sessionUsageTurns("codex", lines, { sessionId: session.sessionId, prompts: session.prompts, ...(billing ? { billing } : {}) }) });
      else outcome.failed.push({ path: file, reason: "no conversation to resume" });
    } catch (error) {
      outcome.failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const ids = await store.adopt(parsed.map((session) => {
    const usage = unpricedUsage(session.usageTurns);
    return {
      codexThreadId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      ...(session.model ? { model: session.model } : {}),
      messages: session.messages,
      ...(usage ? { usage, usageTurns: session.usageTurns } : {}),
      updatedAt: session.messages.at(-1)?.timestamp ?? Date.now(),
    };
  }));
  for (const id of ids) {
    if (id) outcome.imported.push(id);
    else outcome.skipped += 1;
  }
  return outcome;
}
