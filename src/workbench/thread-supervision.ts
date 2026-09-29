import type { UiProject, UiSession, UiThreadUsage } from "../shared/contracts";
import type { ThreadActivitySnapshot } from "./thread-store";
import type { DraftThread } from "./draft-threads";
import { threadRowStatus, type ThreadRowStatus } from "./thread-row-status";

/**
 * What a thread is doing right now, in the words a supervisor needs: a phone
 * screen shows this and nothing else. `waiting` outranks `running` because a
 * question is the only state that needs the user before anything continues.
 */
export type ThreadSupervisionStatus = "waiting" | "running" | "failed" | "done";

export interface ThreadSupervisionRow {
  id: string;
  /** How `switchSession` addresses the thread. */
  path: string;
  title: string;
  projectName: string;
  /** What the project's mark is coloured by, as on a rail row. */
  projectPath?: string;
  workspaceId?: string;
  /** The project's short label, e.g. its Git branch. */
  projectLabel?: string;
  usage?: UiThreadUsage;
  status: ThreadSupervisionStatus;
  /** What the row's badge says, from the derivation the desktop rail uses too. */
  state: ThreadRowStatus;
  /** Set while the thread is running: the host's start of the run, for the elapsed timer. */
  startedAt?: number;
  /** A finished run the user has not looked at yet. */
  unread: boolean;
  modifiedAt: number;
  pinned: boolean;
  settled: boolean;
  backendKind?: string;
  modelProvider?: string;
}

const RANK: Record<ThreadSupervisionStatus, number> = { waiting: 0, running: 1, failed: 2, done: 3 };

export function threadSupervisionStatus(id: string, activity: ThreadActivitySnapshot): ThreadSupervisionStatus {
  if (activity.waitingThreadIds.includes(id)) return "waiting";
  if (activity.runningThreadIds.includes(id)) return "running";
  if (activity.failedThreadIds.includes(id) || activity.limitedThreadIds.includes(id)) return "failed";
  return "done";
}

/** Which threads the user pinned and settled; both live in preferences. */
export interface ThreadOrganization {
  pinned?: readonly string[];
  settled?: readonly string[];
}

function rowFor(thread: UiSession, activity: ThreadActivitySnapshot, organization: ThreadOrganization): ThreadSupervisionRow {
  const status = threadSupervisionStatus(thread.id, activity);
  const startedAt = activity.runningStartedAt[thread.id];
  return {
    id: thread.id,
    path: thread.path,
    title: thread.title || "Untitled thread",
    projectName: thread.projectName,
    projectPath: thread.projectPath,
    ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
    ...(thread.projectLabel ? { projectLabel: thread.projectLabel } : {}),
    ...(thread.usage ? { usage: thread.usage } : {}),
    status,
    state: threadRowStatus(thread.id, activity, thread),
    ...(startedAt === undefined ? {} : { startedAt }),
    unread: activity.unreadThreadIds.includes(thread.id),
    modifiedAt: thread.modifiedAt,
    pinned: organization.pinned?.includes(thread.id) ?? false,
    // A thread that needs the user again is not settled, whatever the list says.
    settled: status === "done" && (organization.settled?.includes(thread.id) ?? false),
    ...(thread.backendKind ? { backendKind: thread.backendKind } : {}),
    ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
  };
}

const worstFirst = (left: ThreadSupervisionRow, right: ThreadSupervisionRow) =>
  RANK[left.status] - RANK[right.status] || right.modifiedAt - left.modifiedAt;

/**
 * The threads a supervisor sees first: everything that needs attention, then
 * the rest by recency. `limit` keeps the list a screen tall rather than an
 * index — opening a thread is one tap away either way.
 */
export function threadSupervisionRows(
  threads: readonly UiSession[],
  activity: ThreadActivitySnapshot,
  limit = 12,
  organization: ThreadOrganization = {},
): ThreadSupervisionRow[] {
  const rows = threads.map((thread) => rowFor(thread, activity, organization));
  rows.sort(worstFirst);
  return rows.slice(0, limit);
}

export type ThreadListSection = "pinned" | "active" | "settled";

export interface ThreadListGroup {
  id: ThreadListSection;
  /** Empty for the one unlabelled group, the active threads. */
  label: string;
  rows: ThreadSupervisionRow[];
  /** Rows past what the group shows; "Show more" reveals them. */
  hidden: number;
}

export interface ThreadListOptions extends ThreadOrganization {
  /** Keeps threads whose title, project or label contain it, ignoring case. */
  query?: string;
  /** Keeps the threads of this project. */
  project?: Pick<UiProject, "path" | "workspaceId">;
  /** How many active and settled rows show before "Show more". */
  shown?: Partial<Record<"active" | "settled", number>>;
  /** Rows of threads kept elsewhere (another machine's), placed among these by the same order before paging. */
  extra?: readonly ThreadSupervisionRow[];
}

/** Another machine's thread as a list row: running or idle, as far as that machine's list says. */
export function outsideRow(key: string, thread: UiSession, options: { running?: boolean; settled?: boolean } = {}): ThreadSupervisionRow {
  return {
    id: key,
    path: thread.path,
    title: thread.title || "Untitled thread",
    projectName: thread.projectName,
    projectPath: thread.projectPath,
    ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
    ...(thread.projectLabel ? { projectLabel: thread.projectLabel } : {}),
    ...(thread.usage ? { usage: thread.usage } : {}),
    status: options.running ? "running" : "done",
    state: options.running ? { activity: "working", label: "Working" } : { activity: "idle", label: "Idle" },
    unread: false,
    modifiedAt: thread.modifiedAt,
    pinned: false,
    settled: !options.running && options.settled === true,
    ...(thread.backendKind ? { backendKind: thread.backendKind } : {}),
    ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
  };
}

/** A thread belongs to a project by its id, or by its path where one side has no id. */
export function inProject(thread: Pick<UiSession, "workspaceId" | "projectPath">, project: Pick<UiProject, "path" | "workspaceId">): boolean {
  return project.workspaceId !== undefined && thread.workspaceId !== undefined
    ? thread.workspaceId === project.workspaceId
    : thread.projectPath === project.path;
}

export const THREAD_LIST_PAGE: Record<"active" | "settled", number> = { active: 40, settled: 10 };

/**
 * The compact thread list: pinned threads, then the active
 * ones worst first, then a shelf of settled ones by recency. A thread an agent
 * spawned stays with its parent (the Agents panel lists it) unless it asks the
 * user something.
 */
export function threadListGroups(
  threads: readonly UiSession[],
  activity: ThreadActivitySnapshot,
  options: ThreadListOptions = {},
): ThreadListGroup[] {
  const query = options.query?.trim().toLowerCase();
  const project = options.project;
  const rows = threads
    .filter((thread) => !thread.parentThreadId || activity.waitingThreadIds.includes(thread.id))
    // A session nobody wrote in yet (the one a host opens at start) is no thread to list.
    .filter((thread) => listed(thread, activity))
    .filter((thread) => !project || inProject(thread, project))
    .map((thread) => rowFor(thread, activity, options))
    .concat(options.extra ?? [])
    .filter((row) => !query || [row.title, row.projectName, row.projectLabel ?? ""].some((text) => text.toLowerCase().includes(query)));
  const pinned = rows.filter((row) => row.pinned && !row.settled).sort(worstFirst);
  const active = rows.filter((row) => !row.pinned && !row.settled).sort(worstFirst);
  const settled = rows.filter((row) => row.settled).sort((left, right) => right.modifiedAt - left.modifiedAt);
  const page = (id: "active" | "settled", list: ThreadSupervisionRow[]) => {
    const shown = options.shown?.[id] ?? THREAD_LIST_PAGE[id];
    return { rows: list.slice(0, shown), hidden: Math.max(0, list.length - shown) };
  };
  const groups: ThreadListGroup[] = [];
  if (pinned.length > 0) groups.push({ id: "pinned", label: "Pinned", rows: pinned, hidden: 0 });
  if (active.length > 0) groups.push({ id: "active", label: "", ...page("active", active) });
  if (settled.length > 0) groups.push({ id: "settled", label: "Settled", ...page("settled", settled) });
  return groups;
}

/** A session the list shows: someone wrote in it, or it is at work or asking. */
function listed(thread: UiSession, activity: ThreadActivitySnapshot): boolean {
  return thread.messageCount > 0 || activity.runningThreadIds.includes(thread.id) || activity.waitingThreadIds.includes(thread.id);
}

/**
 * The drafts the compact list shows above its active threads: those of the
 * filtered project, less any whose thread the list shows already (its row
 * takes over once the host has it).
 */
export function threadListDrafts(
  drafts: readonly DraftThread[],
  threads: readonly UiSession[],
  activity: ThreadActivitySnapshot,
  project?: Pick<UiProject, "path" | "workspaceId">,
): DraftThread[] {
  return drafts.filter((draft) => {
    if (project && !inProject({ workspaceId: draft.workspaceId, projectPath: draft.projectPath }, project)) return false;
    const thread = draft.sessionId ? threads.find((candidate) => candidate.id === draft.sessionId) : undefined;
    return !thread || !listed(thread, activity);
  });
}

/** The compact list's threads top to bottom, every page of it. */
export function threadListOrder(threads: readonly UiSession[], activity: ThreadActivitySnapshot, options: Omit<ThreadListOptions, "shown"> = {}): string[] {
  return threadListGroups(threads, activity, { ...options, shown: { active: Infinity, settled: Infinity } }).flatMap((group) => group.rows.map((row) => row.id));
}

export const THREAD_SUPERVISION_LABELS: Record<ThreadSupervisionStatus, string> = {
  waiting: "Waiting for an answer",
  running: "Running",
  failed: "Failed",
  done: "Done",
};

/** A row's age as the compact list and the desktop rail show it: `now`, `5m`, `3h`, then days (`40d`). */
export function threadAge(modifiedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - modifiedAt) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

