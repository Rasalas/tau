// Pure side of the agent-facing thread directory: how a thread is described and picked.
import type { UiSession } from "tau";
import { isSnoozed, sectionOf } from "./meta.js";
import type { RailSectionId, SettledBy, ThreadMeta } from "./protocol.js";

/** One request a thread links, as Review Kit's `thread-request-links` reports it. */
export interface DirectoryRequest {
  url: string;
  repository: string;
  number: number;
  state: "open" | "closed" | "merged" | null;
  title: string | null;
  headBranch: string | null;
}

/** The one link to a thread: the id is the reference, the reader's client draws the current title. */
export function threadLink(threadId: string, title: string): string {
  const label = title.replace(/[[\]\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim() || threadId;
  return `[${label}](tau://thread?${new URLSearchParams({ thread: threadId }).toString()})`;
}

export interface DirectoryThread {
  threadId: string;
  /** Paste this to mention the thread; it shows the thread's title at the time it is read. */
  link: string;
  title: string;
  project: string;
  branch: string | null;
  /** Where the rail draws it. */
  state: RailSectionId;
  pinned: boolean;
  snoozed: boolean;
  snoozedUntil: string | null;
  settled: boolean;
  settledAt: string | null;
  settledBy: SettledBy | null;
  archived: boolean;
  running: boolean;
  /** The thread asking. */
  current: boolean;
  parentThreadId: string | null;
  updatedAt: string;
  pullRequests?: DirectoryRequest[];
}

const iso = (at: number | undefined): string | null => at === undefined ? null : new Date(at).toISOString();

export function describeThread(session: UiSession, meta: ThreadMeta | undefined, facts: { now: number; running: boolean; current: boolean }): DirectoryThread {
  const snoozed = isSnoozed(meta, facts.now);
  return {
    threadId: session.id,
    link: threadLink(session.id, session.title),
    title: session.title,
    project: session.projectName,
    branch: session.projectLabel ?? null,
    state: sectionOf(meta, facts.now),
    pinned: meta?.pinned === true,
    snoozed,
    snoozedUntil: snoozed ? iso(meta?.snoozedUntil) : null,
    settled: meta?.settledAt !== undefined,
    settledAt: iso(meta?.settledAt),
    settledBy: meta?.settledBy ?? null,
    archived: meta?.archivedAt !== undefined,
    running: facts.running,
    current: facts.current,
    parentThreadId: session.parentThreadId ?? null,
    updatedAt: new Date(session.modifiedAt).toISOString(),
  };
}

export const DIRECTORY_LIMIT = 30;
export const DIRECTORY_MAX = 100;

export interface DirectoryFilter {
  query?: string;
  state?: RailSectionId;
  settled?: boolean;
  snoozed?: boolean;
  includeSubagents?: boolean;
  limit?: number;
}

/**
 * The threads a listing shows, newest first: archived ones only when asked for by
 * `state`, agents' child threads only with `includeSubagents`. A thread matches `query`
 * by the words of its title, project or branch, or by being in `requestMatches`.
 */
export function selectThreads(threads: readonly DirectoryThread[], filter: DirectoryFilter, requestMatches: ReadonlySet<string> = new Set()): { threads: DirectoryThread[]; total: number } {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const kept = threads
    .filter((thread) => filter.state ? thread.state === filter.state : !thread.archived)
    .filter((thread) => filter.includeSubagents || !thread.parentThreadId)
    .filter((thread) => filter.settled === undefined || thread.settled === filter.settled)
    .filter((thread) => filter.snoozed === undefined || thread.snoozed === filter.snoozed)
    .filter((thread) => {
      if (words.length === 0 || requestMatches.has(thread.threadId)) return true;
      const text = [thread.title, thread.project, thread.branch].filter(Boolean).join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DIRECTORY_LIMIT), 1), DIRECTORY_MAX);
  return { threads: kept.slice(0, limit), total: kept.length };
}
