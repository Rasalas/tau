import { delimiter, join, resolve } from "node:path";
import type { UiThreadUsage } from "tau/host-extension";
import type { OpenCodeClient, OpenCodeMessage, OpenCodeSession } from "./client.js";
import { sessionUsage } from "./events.js";
import type { OpenCodeSessionStore, OpenCodeStoredMessage } from "./session-store.js";

/**
 * Sessions OpenCode ran outside Tau, asked of an OpenCode server over the
 * user's own data: `GET /experimental/session` lists them across projects,
 * `GET /session/:id/message` holds each one's conversation. Only the visible
 * user and assistant text is kept; tools, reasoning and files are not.
 */

/** Fixture homes for tests and dev instances: `<root>/opencode` replaces OpenCode's own folders. */
export const IMPORT_ROOTS_VARIABLE = "TAU_IMPORT_ROOTS";
const MAX_SCANNED = 500;
const MAX_MESSAGES = 200;
const MAX_TITLE = 100;
const DEFAULT_TITLE = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T/u;

export interface ImportableSession {
  /** OpenCode's session id; onboarding hands it back to import it. */
  path: string;
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  imported: boolean;
}

/** The home an import reads: the fixture root's `opencode` folder when one is set, else OpenCode's own. */
export function importHome(env: NodeJS.ProcessEnv): string | undefined {
  const root = env[IMPORT_ROOTS_VARIABLE]?.split(delimiter).find(Boolean);
  return root ? join(resolve(root), "opencode") : undefined;
}

function titleOf(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, MAX_TITLE);
}

/** Visible text of a conversation; an assistant's text parts of one run join into one reply. */
export function visibleMessages(messages: readonly OpenCodeMessage[]): { messages: OpenCodeStoredMessage[]; model?: { provider: string; id: string } } {
  const kept: OpenCodeStoredMessage[] = [];
  let model: { provider: string; id: string } | undefined;
  for (const message of messages) {
    const role = message.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
      .map((part) => String(part.text).trim())
      .filter(Boolean)
      .join("\n\n");
    if (role === "assistant" && message.info.providerID && message.info.modelID) model = { provider: message.info.providerID, id: message.info.modelID };
    if (!text) continue;
    const timestamp = message.info.time?.created ?? Date.now();
    const last = kept.at(-1);
    if (role === "assistant" && last?.role === "assistant") last.text = `${last.text}\n\n${text}`;
    else kept.push({ role, text, timestamp });
  }
  const first = kept.find((message) => message.role === "user");
  const bounded = kept.length <= MAX_MESSAGES || !first ? kept : [first, ...kept.slice(-(MAX_MESSAGES - 1))];
  return { messages: bounded, ...(model ? { model } : {}) };
}

function sessionTitle(session: OpenCodeSession, messages: readonly OpenCodeStoredMessage[]): string {
  const own = session.title?.trim();
  if (own && !DEFAULT_TITLE.test(own)) return own.slice(0, MAX_TITLE);
  return titleOf(messages.find((message) => message.role === "user")?.text ?? "") || "Imported conversation";
}

/** The newest top-level sessions across the server's projects; sub-agents' sessions stay out. */
export async function scanOpenCodeSessions(client: OpenCodeClient, known: (sessionId: string) => boolean): Promise<{ sessions: ImportableSession[]; truncated: boolean }> {
  const listed = await client.listAllSessions({ roots: true, limit: MAX_SCANNED + 1 });
  const sessions = listed.filter((session) => !session.parentID && !session.time?.archived && session.directory).slice(0, MAX_SCANNED).map((session): ImportableSession => ({
    path: session.id,
    sessionId: session.id,
    cwd: session.directory,
    title: session.title && !DEFAULT_TITLE.test(session.title) ? session.title.slice(0, MAX_TITLE) : "Untitled conversation",
    updatedAt: session.time?.updated ?? session.time?.created ?? 0,
    imported: known(session.id),
  }));
  return { sessions, truncated: listed.length > MAX_SCANNED };
}

export interface ImportOutcome {
  imported: string[];
  skipped: number;
  failed: Array<{ path: string; reason: string }>;
}

export async function importOpenCodeSessions(client: OpenCodeClient, ids: unknown, store: Pick<OpenCodeSessionStore, "adopt">): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], skipped: 0, failed: [] };
  const wanted = (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string");
  for (const id of Array.isArray(ids) ? ids : []) if (typeof id !== "string") outcome.failed.push({ path: String(id), reason: "not a session of OpenCode" });
  if (wanted.length === 0) return outcome;
  const listed = new Map((await client.listAllSessions({ limit: 5_000 })).map((session) => [session.id, session]));
  const parsed: Array<{ sessionId: string; cwd: string; title: string; model?: { provider: string; id: string }; usage?: UiThreadUsage; messages: OpenCodeStoredMessage[]; updatedAt: number }> = [];
  for (const id of wanted) {
    const session = listed.get(id);
    if (!session) { outcome.failed.push({ path: id, reason: "not a session of OpenCode" }); continue; }
    try {
      const visible = visibleMessages(await client.messages(session.directory, id));
      if (!visible.messages.some((message) => message.role === "user")) { outcome.failed.push({ path: id, reason: "no conversation to resume" }); continue; }
      parsed.push({
        sessionId: id,
        cwd: session.directory,
        title: sessionTitle(session, visible.messages),
        ...(visible.model ? { model: visible.model } : {}),
        ...(session.tokens ? { usage: sessionUsage(session.tokens, session.cost, visible.messages.filter((message) => message.role === "user").length) } : {}),
        messages: visible.messages,
        updatedAt: session.time?.updated ?? visible.messages.at(-1)?.timestamp ?? Date.now(),
      });
    } catch (error) {
      outcome.failed.push({ path: id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const id of await store.adopt(parsed)) {
    if (id) outcome.imported.push(id);
    else outcome.skipped += 1;
  }
  return outcome;
}
