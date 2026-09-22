import { formatCost as formatMoney, type UiSession, type UiThreadUsage, type UiToolRun } from "tau";
import {
  isBusyStatus,
  type AgentThreadLink,
  type AgentThreadStatus,
  type AgentWorkspace,
  type AgentsState,
} from "./protocol.js";

/** One row of the Agents panel: a spawned thread plus what the index knows about it. */
export interface AgentRow {
  id: string;
  threadId?: string;
  /** The thread's session file, present only once the thread index knows it. */
  path?: string;
  title: string;
  status: AgentThreadStatus;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  lastTool?: string;
  pendingToolPrompt?: string;
  result?: string;
  error?: string;
  costUsd?: number;
  /** The checkout this agent worked in, when it had one of its own. */
  workspace?: AgentWorkspace;
}

export interface AgentGroup {
  parentThreadId: string;
  parentTitle: string;
  /** The group holds the thread the user is reading. */
  active: boolean;
  rows: AgentRow[];
}

export interface AgentsPanelModel {
  groups: AgentGroup[];
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  pending: number;
  /** The active thread's own spend plus every agent's in the panel; undefined when nothing is counted. */
  totalCostUsd?: number;
}

const EMPTY_MODEL: AgentsPanelModel = {
  groups: [], running: 0, waiting: 0, completed: 0, failed: 0, pending: 0,
};

function usageOf(session: UiSession | undefined): UiThreadUsage | undefined {
  return session?.usage;
}

function rowOf(link: AgentThreadLink, sessions: ReadonlyMap<string, UiSession>): AgentRow {
  const session = link.threadId ? sessions.get(link.threadId) : undefined;
  const cost = usageOf(session)?.costUsd;
  return {
    id: link.id,
    ...(link.threadId ? { threadId: link.threadId } : {}),
    ...(session?.path ? { path: session.path } : {}),
    title: session?.title || link.title,
    status: link.status,
    ...(link.model ? { model: link.model } : {}),
    ...(link.startedAt ? { startedAt: link.startedAt } : {}),
    ...(link.endedAt ? { endedAt: link.endedAt } : {}),
    ...(link.lastTool ? { lastTool: link.lastTool } : {}),
    ...(link.pendingToolPrompt ? { pendingToolPrompt: link.pendingToolPrompt } : {}),
    ...(link.result ? { result: link.result } : {}),
    ...(link.error ? { error: link.error } : {}),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(link.workspace ? { workspace: link.workspace } : {}),
  };
}

/**
 * A child the thread index names but no live link covers: after a restart that
 * lost the kit's own index, the session file is still the record.
 */
function indexRow(session: UiSession): AgentRow {
  const cost = session.usage?.costUsd;
  return {
    id: session.id,
    threadId: session.id,
    ...(session.path ? { path: session.path } : {}),
    title: session.title,
    status: "idle",
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/**
 * What the Agents panel draws for the thread on screen: its own agents, and —
 * when that thread is itself an agent — its siblings under the parent it came
 * from.
 *
 * Rows come from the links the host published and from the thread index, which
 * reads the link off each child's own session file; a fresh machine or a lost
 * links file therefore changes what a row says, not whether it is there.
 */
export function agentsPanelModel(
  state: AgentsState | undefined,
  activeThreadId: string | undefined,
  threads: readonly UiSession[],
  siblings: { ids: readonly string[]; running: readonly string[] } = { ids: [], running: [] },
): AgentsPanelModel {
  const links = state?.links ?? [];
  const sessions = new Map(threads.map((session) => [session.id, session] as const));
  const byParent = new Map<string, AgentThreadLink[]>();
  for (const link of links) {
    byParent.set(link.parentThreadId, [...byParent.get(link.parentThreadId) ?? [], link]);
  }
  const linkOf = new Map(links.filter((link) => link.threadId).map((link) => [link.threadId!, link] as const));
  const indexed = new Map<string, UiSession[]>();
  for (const session of threads) {
    if (!session.parentThreadId || linkOf.has(session.id)) continue;
    indexed.set(session.parentThreadId, [...indexed.get(session.parentThreadId) ?? [], session]);
  }
  // Threads started from the same prompt on other models: siblings without a parent.
  const siblingRows = siblings.ids.flatMap((id) => {
    const session = id === activeThreadId ? undefined : sessions.get(id);
    return session ? [{ ...indexRow(session), status: siblings.running.includes(id) ? "running" as const : "idle" as const }] : [];
  });
  if (byParent.size === 0 && indexed.size === 0 && siblingRows.length === 0) return EMPTY_MODEL;

  const spawned = (threadId: string) => byParent.has(threadId) || indexed.has(threadId);
  const parentOf = (threadId: string) => linkOf.get(threadId)?.parentThreadId ?? sessions.get(threadId)?.parentThreadId;

  // A thread that is itself an agent shows the family it belongs to, so the
  // user reading a child still sees its siblings and the thread above it.
  const own = activeThreadId ? parentOf(activeThreadId) : undefined;
  const roots = new Set<string>();
  if (activeThreadId && spawned(activeThreadId)) roots.add(activeThreadId);
  if (own) roots.add(own);
  // Depth 2: a child that spawned its own agents shows both levels.
  for (const root of [...roots]) {
    for (const link of byParent.get(root) ?? []) {
      if (link.threadId && spawned(link.threadId)) roots.add(link.threadId);
    }
    for (const session of indexed.get(root) ?? []) if (spawned(session.id)) roots.add(session.id);
  }

  const titleOf = (threadId: string) =>
    sessions.get(threadId)?.title || linkOf.get(threadId)?.title || "This thread";

  const groups: AgentGroup[] = [...roots]
    .map((parentThreadId) => ({
      parentThreadId,
      parentTitle: titleOf(parentThreadId),
      active: parentThreadId === activeThreadId,
      rows: [
        ...(byParent.get(parentThreadId) ?? [])
          .slice()
          .sort((left, right) => left.spawnedAt - right.spawnedAt)
          .map((link) => rowOf(link, sessions)),
        ...(indexed.get(parentThreadId) ?? [])
          .slice()
          .sort((left, right) => left.modifiedAt - right.modifiedAt)
          .map((session) => indexRow(session)),
      ],
    }))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.parentTitle.localeCompare(right.parentTitle));
  if (siblingRows.length > 0) groups.push({ parentThreadId: "siblings", parentTitle: "Same prompt, other models", active: false, rows: siblingRows });

  const counts = { running: 0, waiting: 0, completed: 0, failed: 0, pending: 0 };
  let cost = 0;
  let counted = false;
  for (const group of groups) {
    for (const row of group.rows) {
      counts[row.status === "idle" ? "completed" : row.status] += 1;
      if (row.costUsd !== undefined) { cost += row.costUsd; counted = true; }
    }
  }
  const ownCost = activeThreadId ? usageOf(sessions.get(activeThreadId))?.costUsd : undefined;
  if (ownCost !== undefined) { cost += ownCost; counted = true; }

  return {
    groups,
    ...counts,
    ...(counted ? { totalCostUsd: cost } : {}),
  };
}

/** `1.2s`, `3m 04s`, `1h 02m` — the same shape at every scale, so rows do not jump. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The composer's own money format, so a row never says `$0.00` for a fraction of a cent. */
export function formatCost(costUsd: number | undefined): string {
  return (costUsd === undefined ? undefined : formatMoney(costUsd)) ?? "–";
}

/** The one line under a row's title: what it is doing, or what it said. */
/**
 * The branch of an agent that worked in its own worktree, with what it changed
 * there. Empty for one that shared the parent's checkout.
 */
export function worktreeLine(row: AgentRow): string {
  const workspace = row.workspace;
  if (!workspace || workspace.mode !== "worktree" || !workspace.branch) return "";
  if (workspace.settled) return `${workspace.branch} · ${workspace.settled}`;
  const changes = workspace.changes;
  if (!changes) return workspace.branch;
  if (changes.files === 0) return `${workspace.branch} · no changes`;
  return `${workspace.branch} · ${changes.files} file${changes.files === 1 ? "" : "s"} +${changes.added} −${changes.removed}`;
}

/** Whether the parent can still take or drop what this agent did. */
export function canSettleWorktree(row: AgentRow): boolean {
  const workspace = row.workspace;
  return Boolean(workspace?.mode === "worktree" && workspace.branch && !workspace.settled)
    && row.status !== "running" && row.status !== "waiting" && row.status !== "pending";
}

export function activityLine(row: AgentRow): string {
  if (row.status === "failed") return row.error ?? "Failed";
  if (row.status === "pending") return "Queued for a free slot";
  if (row.status === "waiting") return row.pendingToolPrompt ? `Needs you: ${row.pendingToolPrompt}` : "Waiting for you";
  if (row.status === "running") return row.lastTool ? `▸ ${row.lastTool}` : "Working";
  return row.result ?? row.lastTool ?? "Finished";
}


/**
 * One agent a `tau_spawn_thread` batch started, as its card row shows it. The
 * thread id comes from the tool's own result, so the card still names its
 * agents after a restart that lost the kit's live state.
 */
export interface SpawnCardRow {
  id: string;
  threadId?: string;
  /** The session file, present once the thread index knows the thread. */
  path?: string;
  title: string;
  status: AgentThreadStatus;
  costUsd?: number;
}

export interface SpawnCardModel {
  rows: SpawnCardRow[];
  /** "Started 3 agents · 2 working". */
  headline: string;
  /** The batch as a whole, for the card's status dot. */
  status: AgentThreadStatus;
  totalCostUsd?: number;
}

function jsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The thread a spawn call reported; its result is JSON with the new thread's id. */
export function spawnedThreadId(tool: UiToolRun): string | undefined {
  const result = jsonRecord(tool.output);
  const threadId = result?.threadId ?? result?.id;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

/**
 * The link a spawn call made. Its result names the thread; a call whose result
 * is not readable falls back to the link this thread spawned in that window,
 * which is what a card of a run replayed from a session file has to work from.
 */
function linkFor(tool: UiToolRun, links: readonly AgentThreadLink[], taken: ReadonlySet<string>): AgentThreadLink | undefined {
  const threadId = spawnedThreadId(tool);
  if (threadId) {
    const matched = links.find((link) => link.threadId === threadId || link.id === threadId);
    if (matched) return matched;
  }
  const endedAt = tool.endedAt ?? Number.MAX_SAFE_INTEGER;
  return links.find((link) => !taken.has(link.id)
    && link.spawnedBy === tool.name
    && link.spawnedAt >= tool.startedAt
    && link.spawnedAt <= endedAt + 2_000);
}

function spawnTitle(tool: UiToolRun, link: AgentThreadLink | undefined, session: UiSession | undefined): string {
  if (session?.title) return session.title;
  if (link?.title) return link.title;
  const title = tool.args.title ?? tool.args.prompt;
  const text = typeof title === "string" ? title.trim().split("\n")[0] : "";
  return text ? (text.length > 60 ? `${text.slice(0, 59)}…` : text) : "Agent";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the card says about a batch: its rows, its headline and its dot. */
export function spawnCardModel(
  tools: readonly UiToolRun[],
  state: AgentsState | undefined,
  threads: readonly UiSession[],
): SpawnCardModel {
  const links = state?.links ?? [];
  const sessions = new Map(threads.map((session) => [session.id, session] as const));
  const taken = new Set<string>();
  const rows = tools.map((tool) => {
    const link = linkFor(tool, links, taken);
    if (link) taken.add(link.id);
    const threadId = link?.threadId ?? spawnedThreadId(tool);
    const session = threadId ? sessions.get(threadId) : undefined;
    const cost = session?.usage?.costUsd;
    const status: AgentThreadStatus = link?.status
      ?? (tool.status === "error" ? "failed" : tool.status === "running" ? "pending" : session ? "idle" : "completed");
    return {
      id: link?.id ?? tool.id,
      ...(threadId ? { threadId } : {}),
      ...(session?.path ? { path: session.path } : {}),
      title: spawnTitle(tool, link, session),
      status,
      ...(cost === undefined ? {} : { costUsd: cost }),
    };
  });

  const working = rows.filter((row) => isBusyStatus(row.status)).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const costs = rows.flatMap((row) => row.costUsd === undefined ? [] : [row.costUsd]);
  const tail = working > 0
    ? `${working} working`
    : failed > 0 ? `${failed} failed` : pending > 0 ? `${pending} queued` : "all done";
  return {
    rows,
    headline: `Started ${plural(rows.length, "agent", "agents")} · ${tail}`,
    status: working > 0 ? "running" : failed > 0 ? "failed" : pending > 0 ? "pending" : "completed",
    ...(costs.length > 0 ? { totalCostUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
  };
}
