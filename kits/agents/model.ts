import { formatCost as formatMoney, type UiSession, type UiThreadUsage } from "tau";
import {
  isOpenStatus,
  type AgentThreadLink,
  type AgentThreadStatus,
  type AgentsState,
} from "./protocol.js";

/** One row of the Agents panel: a spawned thread plus what the index knows about it. */
export interface AgentRow {
  id: string;
  threadId?: string;
  /** The thread's path, so a click can switch to it. */
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
  /** Agents working under threads this panel does not show. */
  runningElsewhere: number;
  /** A thread to jump to when the panel is empty but work is running elsewhere. */
  jumpTo?: { threadId: string; path?: string; title: string };
}

const EMPTY_MODEL: AgentsPanelModel = {
  groups: [], running: 0, waiting: 0, completed: 0, failed: 0, pending: 0, runningElsewhere: 0,
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
 * from. Everything else running is offered as one jump.
 *
 * Rows come from the links the host published and from the thread index, which
 * reads the link off each child's own session file; a fresh machine or a lost
 * links file therefore changes what a row says, not whether it is there.
 */
export function agentsPanelModel(
  state: AgentsState | undefined,
  activeThreadId: string | undefined,
  threads: readonly UiSession[],
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
  if (byParent.size === 0 && indexed.size === 0) return EMPTY_MODEL;

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

  const shown = new Set(groups.flatMap((group) => group.rows.map((row) => row.id)));
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

  const elsewhere = links.filter((link) => !shown.has(link.id) && isOpenStatus(link.status));
  const jump = elsewhere[0];
  const jumpParent = jump ? sessions.get(jump.parentThreadId) : undefined;

  return {
    groups,
    ...counts,
    ...(counted ? { totalCostUsd: cost } : {}),
    runningElsewhere: elsewhere.length,
    ...(jump ? {
      jumpTo: {
        threadId: jump.parentThreadId,
        ...(jumpParent?.path ? { path: jumpParent.path } : {}),
        title: titleOf(jump.parentThreadId),
      },
    } : {}),
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
export function activityLine(row: AgentRow): string {
  if (row.status === "failed") return row.error ?? "Failed";
  if (row.status === "pending") return "Queued for a free slot";
  if (row.status === "waiting") return row.pendingToolPrompt ? `Needs you: ${row.pendingToolPrompt}` : "Waiting for you";
  if (row.status === "running") return row.lastTool ? `▸ ${row.lastTool}` : "Working";
  return row.result ?? row.lastTool ?? "Finished";
}
