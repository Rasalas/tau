import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { AcpSessionUpdate } from "./events.js";
import type { AcpAgentSession } from "./session.js";
import type { AcpSessionStore, AcpStoredMessage } from "./session-store.js";

/**
 * Sessions an ACP agent ran outside Tau, asked of the agent itself, the way
 * OpenCode's are asked of its server: `session/list` names them with their
 * folder and `session/load` replays each one's conversation. Only the visible
 * user and agent text is kept; tools, thoughts and plans are not. Tau reads
 * no agent's files: an agent that does not list its sessions over ACP cannot
 * be asked, and the scan says so instead of finding nothing.
 */

/** Fixture homes for tests and dev instances: `<root>/<backend kind>` replaces the agent's own home. */
export const IMPORT_ROOTS_VARIABLE = "TAU_IMPORT_ROOTS";
const MAX_SCANNED = 500;
const MAX_LISTED = 5_000;
const MAX_PAGES = 50;
const MAX_MESSAGES = 200;
const MAX_TITLE = 100;
const MAX_ID = 200;
/** What a scan or an import may wait for: the agent starts, signs in and answers, or the onboarding moves on. */
export const IMPORT_TIMEOUTS = { handshakeMs: 20_000, signInMs: 20_000, sessionMs: 30_000 } as const;

export interface AcpImportableSession {
  /** The agent's session id; onboarding hands it back to import it. */
  path: string;
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  /** Tau already holds this session, imported or started here. */
  imported: boolean;
}

export interface AcpScan {
  sessions: AcpImportableSession[];
  truncated: boolean;
  /** Why this agent's sessions cannot be imported at all; shown instead of an empty list. */
  unsupported?: string;
}

export interface AcpImportOutcome {
  /** Thread ids of the sessions this call added. */
  imported: string[];
  /** Sessions Tau already held. */
  skipped: number;
  failed: Array<{ path: string; reason: string }>;
}

/** The agent, started and signed in for an import; `onUpdate` receives each loaded session's replay. */
export type OpenImportSession = (onUpdate: (update: AcpSessionUpdate) => void) => Promise<AcpAgentSession>;

interface ListedSession { sessionId: string; cwd: string; title?: string; updatedAt: number }

/** The home an import reads: `<root>/<kind>` when a fixture root is set, else the agent's own. */
export function importHome(env: NodeJS.ProcessEnv, kind: string): string | undefined {
  const root = env[IMPORT_ROOTS_VARIABLE]?.split(delimiter).find(Boolean);
  return root ? join(resolve(root), kind) : undefined;
}

/** Why an agent's sessions cannot be imported, or `undefined` when they can. */
export function importUnsupported(session: AcpAgentSession, agent: string): string | undefined {
  const capabilities = session.initialized?.agentCapabilities;
  const version = session.initialized?.agentInfo?.version;
  const release = version ? `${agent} ${version}` : agent;
  if (!capabilities?.sessionCapabilities?.list) return `${release} does not list its sessions to other apps, so Tau cannot find them.`;
  if (!capabilities.loadSession) return `${release} does not replay a session to other apps, so Tau cannot show its conversation.`;
  return undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function listedSession(value: unknown): ListedSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const sessionId = boundedText(item.sessionId, MAX_ID);
  const cwd = boundedText(item.cwd, 4_096);
  if (!sessionId || !cwd || !isAbsolute(cwd)) return undefined;
  const title = typeof item.title === "string" ? item.title.trim().slice(0, MAX_TITLE) : "";
  return { sessionId, cwd, ...(title ? { title } : {}), updatedAt: timeOf(item.updatedAt) ?? 0 };
}

/** The agent's sessions newest first, page by page up to `limit`; entries without an id or an absolute folder are left out. */
export async function listAcpSessions(session: AcpAgentSession, limit = MAX_SCANNED): Promise<{ sessions: ListedSession[]; truncated: boolean }> {
  const byId = new Map<string, ListedSession>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await session.request<{ sessions?: unknown; nextCursor?: unknown } | null>("session/list", cursor ? { cursor } : {});
    for (const entry of Array.isArray(answer?.sessions) ? answer.sessions : []) {
      const listed = listedSession(entry);
      if (listed && !byId.has(listed.sessionId)) byId.set(listed.sessionId, listed);
    }
    const next = typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : undefined;
    cursor = next !== cursor ? next : undefined;
    if (!cursor || byId.size > limit) break;
  }
  const sessions = [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  return { sessions: sessions.slice(0, limit), truncated: sessions.length > limit || cursor !== undefined };
}

function textOf(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

/**
 * Collects a loaded session's replay into messages: chunks of one side make
 * one message, and agent text a tool call interrupts continues after a blank line.
 */
export class AcpReplay {
  private messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  private interrupted = false;

  readonly onUpdate = (update: AcpSessionUpdate): void => {
    const role = update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "assistant" : undefined;
    if (!role) {
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") this.interrupted = true;
      return;
    }
    const text = textOf(update.content);
    if (!text) return;
    const last = this.messages.at(-1);
    if (last?.role === role) last.text += role === "assistant" && this.interrupted ? `\n\n${text}` : text;
    else this.messages.push({ role, text });
    this.interrupted = false;
  };

  reset(): void {
    this.messages = [];
    this.interrupted = false;
  }

  /** What the replay showed, trimmed and bounded: the first prompt and the newest messages. The agent dates none, so each takes `at`. */
  take(at: number): AcpStoredMessage[] {
    const messages = this.messages.flatMap((message): AcpStoredMessage[] => {
      const text = message.text.trim();
      return text ? [{ role: message.role, text, timestamp: at }] : [];
    });
    this.reset();
    const first = messages.find((message) => message.role === "user");
    return messages.length <= MAX_MESSAGES || !first ? messages : [first, ...messages.slice(-(MAX_MESSAGES - 1))];
  }
}

function titleOf(listed: ListedSession, messages: readonly AcpStoredMessage[]): string {
  if (listed.title) return listed.title;
  const prompt = messages.find((message) => message.role === "user")?.text ?? "";
  return (prompt.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, MAX_TITLE) || "Imported conversation";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The newest sessions the agent lists, or why it lists none. */
export async function scanAcpSessions(open: OpenImportSession, known: (sessionId: string) => boolean, agent: string): Promise<AcpScan> {
  const session = await open(() => undefined);
  try {
    const unsupported = importUnsupported(session, agent);
    if (unsupported) return { sessions: [], truncated: false, unsupported };
    const listed = await listAcpSessions(session);
    return {
      sessions: listed.sessions.map((entry) => ({
        path: entry.sessionId,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title ?? "Untitled conversation",
        updatedAt: entry.updatedAt,
        imported: known(entry.sessionId),
      })),
      truncated: listed.truncated,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Loads each named session once, in one agent process, and keeps a thread for each one Tau does not hold yet. */
export async function importAcpSessions(open: OpenImportSession, ids: unknown, store: Pick<AcpSessionStore, "adopt" | "acpSessionIds">, agent: string): Promise<AcpImportOutcome> {
  const outcome: AcpImportOutcome = { imported: [], skipped: 0, failed: [] };
  const named = Array.isArray(ids) ? ids : [];
  for (const id of named) if (typeof id !== "string") outcome.failed.push({ path: String(id), reason: `not a session of ${agent}` });
  const held = await store.acpSessionIds();
  const wanted = [...new Set(named.filter((id): id is string => typeof id === "string"))].filter((id) => {
    if (!held.has(id)) return true;
    outcome.skipped += 1;
    return false;
  });
  if (wanted.length === 0) return outcome;
  const replay = new AcpReplay();
  const session = await open(replay.onUpdate);
  const parsed: Array<{ acpSessionId: string; cwd: string; title: string; messages: AcpStoredMessage[]; updatedAt: number }> = [];
  try {
    const unsupported = importUnsupported(session, agent);
    if (unsupported) throw new Error(unsupported);
    const listed = new Map((await listAcpSessions(session, MAX_LISTED)).sessions.map((entry) => [entry.sessionId, entry]));
    for (const id of wanted) {
      const entry = listed.get(id);
      if (!entry) { outcome.failed.push({ path: id, reason: `not a session of ${agent}` }); continue; }
      replay.reset();
      try {
        // A session of its own folder and without Tau's tools: the replay is all this load is for.
        await session.request("session/load", { sessionId: id, cwd: entry.cwd, mcpServers: [] });
      } catch (error) {
        outcome.failed.push({ path: id, reason: errorText(error) });
        continue;
      }
      const updatedAt = entry.updatedAt || Date.now();
      const messages = replay.take(updatedAt);
      if (!messages.some((message) => message.role === "user")) { outcome.failed.push({ path: id, reason: "no conversation to resume" }); continue; }
      parsed.push({ acpSessionId: id, cwd: entry.cwd, title: titleOf(entry, messages), messages, updatedAt });
    }
  } finally {
    await session.close().catch(() => undefined);
  }
  for (const id of await store.adopt(parsed)) {
    if (id) outcome.imported.push(id);
    else outcome.skipped += 1;
  }
  return outcome;
}
