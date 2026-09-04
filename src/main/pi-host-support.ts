import { basename, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { ClientTurnIdentity, PreparedPrompt, ThreadBackendKind, UiSkillDraft } from "../shared/contracts.js";

const EXTERNAL_THREAD_PATH_PREFIX = "tau-thread:";

export type ClientTurnRequest = string | ClientTurnIdentity;

export function externalThreadPath(kind: ThreadBackendKind, threadId: string): string {
  return `${EXTERNAL_THREAD_PATH_PREFIX}${kind}:${threadId}`;
}

export function externalThreadFromPath(path: string): { kind: ThreadBackendKind; threadId: string } | undefined {
  if (!path.startsWith(EXTERNAL_THREAD_PATH_PREFIX)) return undefined;
  const rest = path.slice(EXTERNAL_THREAD_PATH_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split === rest.length - 1) return undefined;
  return { kind: rest.slice(0, split), threadId: rest.slice(split + 1) };
}

export function clientIdentityForRequest(request?: ClientTurnRequest): ClientTurnIdentity | undefined {
  if (!request) return undefined;
  return typeof request === "string" ? { clientTurnId: request, clientMessageId: request } : request;
}

/** Describes how to re-prepare a prompt whose owning Pi session changed after preflight. */
/** What a prepared prompt must be re-prepared with when its thread changed. */
export function promptRebindForThread(
  prepared: PreparedPrompt | undefined,
  sessionId: string | undefined,
): { skill?: UiSkillDraft } | undefined {
  if (!prepared) return undefined;
  const changed = (prepared.tauThreadId !== undefined && prepared.tauThreadId !== sessionId)
    || (prepared.sessionId !== undefined && prepared.sessionId !== sessionId)
    || (prepared.providerSessionId !== undefined && prepared.providerSessionId !== sessionId);
  if (!changed) return undefined;
  return prepared.skill
    ? { skill: { source: "skill", name: prepared.skill.name, visibleText: prepared.visibleText, command: prepared.skill.command } }
    : {};
}

export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right) && resolve(left!) === resolve(right!);
}

export async function findKnownWorkspacePath(cwd: string, candidates: Iterable<string>): Promise<string> {
  const requested = await realpath(cwd).catch(() => resolve(cwd));
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => resolve(candidate));
    if (canonical === requested) return canonical;
  }
  throw new Error("Workspace is not a known Tau project.");
}

export function workspaceLabel(cwd: string): string {
  return basename(cwd) || cwd;
}
