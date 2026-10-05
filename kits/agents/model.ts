import { formatCost as formatMoney, THREAD_QUESTION_LABEL, type UiSession, type UiThreadUsage, type UiToolRun } from "tau";
import {
  isBusyStatus,
  isOpenStatus,
  type AgentDefinitionSummary,
  type AgentThreadLink,
  type AgentThreadStatus,
  type AgentWorkspace,
  type AgentsState,
  tauToolName,
} from "./protocol.js";

/** One row of the Agents panel: a spawned thread plus what the index knows about it. */
export interface AgentRow {
  id: string;
  threadId?: string;
  /** The thread's session file, present only once the thread index knows it. */
  path?: string;
  title: string;
  status: AgentThreadStatus;
  /** The agent definition it was started from. */
  agent?: string;
  model?: string;
  /** The parent's turn that spawned it. */
  turn?: number;
  startedAt?: number;
  endedAt?: number;
  lastTool?: string;
  pendingToolPrompt?: string;
  result?: string;
  error?: string;
  costUsd?: number;
  /** The checkout this agent worked in, when it had one of its own. */
  workspace?: AgentWorkspace;
  /** The machine it runs on, when that is not this computer. */
  machine?: AgentRowMachine;
}

/** The chip a row on another machine carries. */
export interface AgentRowMachine {
  id: string;
  name: string;
  /** Its thread's id there, once it exists. */
  thread?: string;
  offline?: boolean;
  /** Why Tau sent it there. */
  reason?: string;
}

/** "Runs on rex", with why and whether rex answers: the chip's tooltip. */
export function machineTitle(machine: AgentRowMachine): string {
  return [
    machine.offline ? `${machine.name} is offline; the thread may still be running there.` : `Runs on ${machine.name}.`,
    machine.reason,
  ].filter(Boolean).join(" ");
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
  cancelled: number;
  /** The active thread's own spend plus every agent's in the panel; undefined when nothing is counted. */
  totalCostUsd?: number;
}

const EMPTY_MODEL: AgentsPanelModel = {
  groups: [], running: 0, waiting: 0, completed: 0, failed: 0, pending: 0, cancelled: 0,
};

function usageOf(session: UiSession | undefined): UiThreadUsage | undefined {
  return session?.usage;
}

function rowOf(link: AgentThreadLink, sessions: ReadonlyMap<string, UiSession>): AgentRow {
  const session = link.threadId ? sessions.get(link.threadId) : undefined;
  const cost = link.machine ? link.machine.costUsd : usageOf(session)?.costUsd;
  return {
    id: link.id,
    ...(link.threadId ? { threadId: link.threadId } : {}),
    ...(session?.path ? { path: session.path } : {}),
    title: session?.title || link.title,
    status: link.status,
    ...(link.agent ? { agent: link.agent } : {}),
    ...(link.model ? { model: link.model } : {}),
    ...(link.turn ? { turn: link.turn } : {}),
    ...(link.startedAt ? { startedAt: link.startedAt } : {}),
    ...(link.endedAt ? { endedAt: link.endedAt } : {}),
    ...(link.lastTool ? { lastTool: link.lastTool } : {}),
    ...(link.pendingToolPrompt ? { pendingToolPrompt: link.pendingToolPrompt } : {}),
    ...(link.result ? { result: link.result } : {}),
    ...(link.error ? { error: link.error } : {}),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(link.workspace ? { workspace: link.workspace } : {}),
    ...(link.machine ? {
      machine: {
        id: link.machine.id,
        name: link.machine.name,
        ...(link.machine.thread ? { thread: link.machine.thread } : {}),
        ...(link.machine.offline ? { offline: true } : {}),
        ...(link.machine.reason ? { reason: link.machine.reason } : {}),
      },
    } : {}),
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

  const counts = { running: 0, waiting: 0, completed: 0, failed: 0, pending: 0, cancelled: 0 };
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

/** `0:04`, `3:04`, `1:02:05`: the rail's `Working m:ss` clock. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const two = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${two(seconds % 60)}`;
  return `${Math.floor(minutes / 60)}:${two(minutes % 60)}:${two(seconds % 60)}`;
}

/** The composer's own money format, so a row never says `$0.00` for a fraction of a cent. */
export function formatCost(costUsd: number | undefined): string {
  return (costUsd === undefined ? undefined : formatMoney(costUsd)) ?? "–";
}

/**
 * What an agent changed in its own worktree, then the branch: `+48 −0 · 1 file ·
 * tau/agent-1`, as the design's done row. Empty for one that shared the parent's checkout.
 */
export function worktreeLine(row: AgentRow, withBranch = true): string {
  const workspace = row.workspace;
  if (!workspace || workspace.mode !== "worktree" || !workspace.branch) return "";
  const branch = withBranch ? ` · ${workspace.branch}` : "";
  if (workspace.settled) return `${workspace.settled}${branch}`;
  const changes = workspace.changes;
  if (!changes) return withBranch ? workspace.branch : "";
  if (changes.files === 0) return `no changes${branch}`;
  const files = `${changes.files} file${changes.files === 1 ? "" : "s"}`;
  // Work that came back from another machine counts files, not lines.
  const lines = changes.added === 0 && changes.removed === 0 ? "" : `+${changes.added} −${changes.removed} · `;
  return `${lines}${files}${branch}`;
}

/** Whether the parent can still take or drop what this agent did. */
export function canSettleWorktree(row: AgentRow): boolean {
  const workspace = row.workspace;
  return Boolean(workspace?.mode === "worktree" && workspace.branch && !workspace.settled)
    && row.status !== "running" && row.status !== "waiting" && row.status !== "pending";
}

/** The amber line of an agent holding on a question: "Asks: …" (design 1c), an approval in its own words. */
export function questionLine(row: Pick<AgentRow, "pendingToolPrompt">): string {
  const asked = row.pendingToolPrompt?.replace(/^\[[^\]\n]*\]\s*/u, "").split("\n")[0];
  if (!asked) return THREAD_QUESTION_LABEL;
  return asked.startsWith("Wants to ") ? asked : `Asks: ${asked}`;
}

/** Where a row stands, the last part of its mono line: its tool now, or what it left behind. */
export function rowStand(row: AgentRow): string {
  if (row.machine?.offline && isBusyStatus(row.status)) return `${row.machine.name} offline · may still be running`;
  if (row.status === "failed") return row.error ?? "failed";
  if (row.status === "pending") return "queued";
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "waiting") return questionLine(row);
  if (row.status === "running") return row.lastTool ?? "working";
  return worktreeLine(row, false) || row.result?.split("\n")[0] || "done";
}

/** `openai/gpt-5.6-luna` reads as `gpt-5.6-luna`; the tooltip keeps the provider. */
export function shortModel(model: string | undefined): string | undefined {
  return model?.slice(model.indexOf("/") + 1) || undefined;
}

/** The three views of the Agents tab. */
export type AgentsView = "running" | "asks" | "done";

export function viewOf(status: AgentThreadStatus): AgentsView {
  if (status === "waiting") return "asks";
  return status === "running" || status === "pending" ? "running" : "done";
}

/** A question first, then work, then the queue: what needs the user leads. */
const OPEN_ORDER: Partial<Record<AgentThreadStatus, number>> = { waiting: 0, running: 1, pending: 2 };

export interface DoneSection {
  turn?: number;
  rows: AgentRow[];
}

/** Finished agents by the parent's turn that spawned them, newest turn first. */
export function doneSections(rows: readonly AgentRow[]): DoneSection[] {
  const byTurn = new Map<number | undefined, AgentRow[]>();
  for (const row of rows) {
    if (viewOf(row.status) !== "done") continue;
    byTurn.set(row.turn, [...byTurn.get(row.turn) ?? [], row]);
  }
  return [...byTurn].map(([turn, list]) => ({ ...(turn === undefined ? {} : { turn }), rows: list }))
    .sort((left, right) => (right.turn ?? -1) - (left.turn ?? -1));
}

export function doneLabel(section: DoneSection): string {
  return `Done · ${section.rows.length}${section.turn === undefined ? "" : ` — from turn ${section.turn}`}`;
}

/** The rows one view shows of a group: questions and work first; the finished ones under it by turn. */
export function viewRows(rows: readonly AgentRow[], view: AgentsView, byStatus = true): { open: AgentRow[]; done: DoneSection[] } {
  const open = view === "done" ? [] : rows
    .filter((row) => view === "asks" ? row.status === "waiting" : viewOf(row.status) !== "done")
    // Rows arrive in spawn order; sorting by status puts what needs the user first.
    .sort((left, right) => byStatus ? (OPEN_ORDER[left.status] ?? 3) - (OPEN_ORDER[right.status] ?? 3) : 0);
  return { open, done: view === "asks" ? [] : doneSections(rows) };
}


/**
 * One agent a `tau_spawn_thread` batch started, as its card row shows it. The
 * thread id comes from the tool's own result, so the card still names its
 * agents after a restart that lost the kit's live state.
 */
export type SpawnCardRow = AgentRow;

/** One count the card shows after its headline. */
export interface SpawnCardPart {
  kind: "running" | "question" | "queued" | "failed" | "done";
  text: string;
}

export interface SpawnCardModel {
  rows: SpawnCardRow[];
  /** "Started 3 agents". */
  headline: string;
  /** "2 running", "1 question": what the batch is doing, most urgent first after the work. */
  parts: SpawnCardPart[];
  /** Headline and parts in one line, for the card's accessible name. */
  summary: string;
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
    && link.spawnedBy === tauToolName(tool.name)
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
    const machine = link?.machine;
    const threadId = link?.machine ? undefined : link?.threadId ?? spawnedThreadId(tool);
    const session = threadId ? sessions.get(threadId) : undefined;
    const cost = link?.machine ? link.machine.costUsd : session?.usage?.costUsd;
    const status: AgentThreadStatus = link?.status
      ?? (tool.status === "error" ? "failed" : tool.status === "running" ? "pending" : session ? "idle" : "completed");
    const agent = link?.agent ?? (typeof tool.args.agent === "string" && tool.args.agent.trim() ? tool.args.agent.trim() : undefined);
    return {
      id: link?.id ?? tool.id,
      ...(threadId ? { threadId } : {}),
      ...(session?.path ? { path: session.path } : {}),
      title: spawnTitle(tool, link, session),
      ...(link?.model ? { model: link.model } : session?.modelProvider ? { model: `${session.modelProvider}/${session.model ?? ""}` } : {}),
      status,
      ...(agent ? { agent } : {}),
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(machine ? { machine } : {}),
    };
  });

  const count = (status: AgentThreadStatus) => rows.filter((row) => row.status === status).length;
  const working = rows.filter((row) => isBusyStatus(row.status)).length;
  const failed = count("failed");
  const pending = count("pending");
  const costs = rows.flatMap((row) => row.costUsd === undefined ? [] : [row.costUsd]);
  const finished = working + pending === 0 ? rows.length - failed : 0;
  const parts: SpawnCardPart[] = ([
    ["running", count("running"), `${count("running")} running`],
    ["question", count("waiting"), plural(count("waiting"), "question", "questions")],
    ["queued", pending, `${pending} queued`],
    ["failed", failed, `${failed} failed`],
    ["done", finished, failed > 0 ? `${finished} done` : "all done"],
  ] as const).flatMap(([kind, amount, text]) => amount > 0 ? [{ kind, text }] : []);
  const headline = `Started ${plural(rows.length, "agent", "agents")}`;
  return {
    rows,
    headline,
    parts,
    summary: [headline, ...parts.map((part) => part.text)].join(" · "),
    status: working > 0 ? "running" : failed > 0 ? "failed" : pending > 0 ? "pending" : "completed",
    ...(costs.length > 0 ? { totalCostUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

/** One definition in the panel: a starting point, with what already runs from it. */
export interface DefinitionRow {
  definition: AgentDefinitionSummary;
  /** Agents of the thread on screen started from it that are not finished. */
  open: number;
  /** "anthropic/… · read-only · shared", what the file sets beyond its prompt. */
  settings: string;
}

export function definitionRows(
  definitions: readonly AgentDefinitionSummary[],
  state: AgentsState | undefined,
  activeThreadId: string | undefined,
): DefinitionRow[] {
  const links = (state?.links ?? []).filter((link) => link.parentThreadId === activeThreadId && isOpenStatus(link.status));
  return definitions.map((definition) => ({
    definition,
    open: links.filter((link) => link.agent === definition.name).length,
    settings: [
      definition.runtime,
      definition.model,
      definition.access,
      definition.workspace,
      definition.machine ? `on ${definition.machine}` : undefined,
      definition.tools ? `${definition.tools.length} tool${definition.tools.length === 1 ? "" : "s"}` : undefined,
    ].filter(Boolean).join(" · "),
  }));
}
