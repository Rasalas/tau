import type { HostEvent, ThreadIndexSnapshot } from "../../src/shared/contracts";
import type { UsageLimitsSummary } from "../../kits/usage/protocol";
import type { LimitGroup } from "../../kits/usage/accounts";
import { juicebarGroups, type Juicebar } from "../../kits/usage/juicebars";
import type { UsageTone } from "../../kits/usage/tones";

/** A reading older than this shows faded with its age (widgets and the Android card alike). */
export const WIDGET_STALE_MS = 15 * 60_000;
/** Finished threads stay in the Threads widget this long. */
const ENDED_KEPT_MS = 24 * 60 * 60_000;
const THREADS_KEPT = 8;

export interface WidgetWindow {
  label: string;
  /** "5h", "wk", "mo": the medium widget's column head. */
  short: string;
  usedPercent: number;
  resetsAt?: number;
  level?: "warn" | "fail";
  pace?: "on" | "ahead" | "runs-out" | "spent";
  paceAt?: number;
}
/** Display fields only: never an account id or token. `poolKey` is the hashed identity that merges one plan across hosts. */
export interface WidgetAccount {
  poolKey?: string;
  label: string;
  plan?: string;
  tone: UsageTone;
  /** Asset name of the provider mark in the widget extension. */
  mark?: string;
  checkedAt: number;
  windows: WidgetWindow[];
}
export interface UsageSnapshot { version: 2; hostId: string; machine: string; updatedAt: number; expiresAt: number; accounts: WidgetAccount[] }

export type WidgetThreadState = "waiting" | "running" | "done" | "failed";
export interface WidgetThread {
  id: string;
  title: string;
  project?: string;
  state: WidgetThreadState;
  startedAt?: number;
  endedAt?: number;
  /** When the open question came. */
  askedAt?: number;
  /** The question, or why the turn failed. */
  reason?: string;
}
export interface ThreadsSnapshot { version: 1; hostId: string; machine: string; updatedAt: number; threads: WidgetThread[] }

const MARKS: Readonly<Record<string, string>> = {
  codex: "mark-codex", "openai-codex": "mark-codex", openai: "mark-openai", chatgpt: "mark-codex",
  "claude-code": "mark-claude-code", anthropic: "mark-anthropic", claude: "mark-claude-code",
  opencode: "mark-opencode", "opencode-go": "mark-opencode",
  gemini: "mark-gemini", google: "mark-gemini", "google-gemini": "mark-gemini", antigravity: "mark-antigravity",
  pi: "mark-pi", cursor: "mark-cursor", grok: "mark-grok", xai: "mark-grok",
};
/** A plan wears its product's mark, as the Usage page draws it: a ChatGPT plan Codex's, a Claude plan Claude Code's. */
const PLAN_MARKS: Readonly<Record<string, string>> = { openai: "mark-codex", "openai-codex": "mark-codex", anthropic: "mark-claude-code", claude: "mark-claude-code" };

function markOf(group: LimitGroup): string | undefined {
  const key = (name: string) => name.split("@")[0]!.toLowerCase().replace(/[_.\s]/gu, "-");
  const account = group.members[0]!;
  if (group.members.length > 1 && group.shown.identity) return PLAN_MARKS[key(group.shown.identity.provider)] ?? MARKS[key(group.shown.identity.provider)];
  if (account.runtime === "pi" && account.id.startsWith("pi:")) return PLAN_MARKS[key(account.id.slice(3))] ?? MARKS[key(account.id.slice(3))];
  return MARKS[key(account.runtime)];
}

function shortLabel(window: Juicebar["window"]): string {
  if (window.kind === "weekly") return "wk";
  if (window.kind === "monthly") return "mo";
  if (window.windowMinutes && window.windowMinutes < 24 * 60) return `${Math.round(window.windowMinutes / 60)}h`;
  if (window.kind === "session") return "5h";
  return window.label.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 3) || "·";
}

function paceOf(bar: Juicebar): Pick<WidgetWindow, "pace" | "paceAt"> {
  switch (bar.state.kind) {
    case "exhausted": return { pace: "spent" };
    case "forecast": return { pace: "runs-out", paceAt: bar.state.at };
    case "pace": case "ahead": return { pace: "ahead" };
    case "lasts": case "steady": return { pace: "on" };
    default: return {};
  }
}

/**
 * The Plan limits widget's accounts: every account once, in the sidebar's
 * order (OpenAI, Anthropic, Google, Pi, others), with the windows it shows by
 * default. Old readings stay; the widget fades them by `checkedAt`.
 */
export function widgetUsage(summary: UsageLimitsSummary, now: number): WidgetAccount[] {
  const readable = { ...summary, accounts: summary.accounts.filter((account) => !account.unavailable && Number.isFinite(account.checkedAt) && account.checkedAt <= now + 60_000) };
  return juicebarGroups(readable, {}, now).map(({ group, tone, bars }) => {
    const mark = markOf(group);
    const plan = group.shown.plan?.slice(0, 40);
    return {
      ...(group.shown.identity ? { poolKey: `${group.shown.identity.provider}:${group.shown.identity.key}` } : {}),
      label: (group.members.length > 1 ? group.label.split(" · ")[0]! : group.label).slice(0, 60),
      ...(plan ? { plan } : {}),
      tone,
      ...(mark ? { mark } : {}),
      checkedAt: group.shown.checkedAt,
      windows: bars.filter((bar) => Number.isFinite(bar.window.usedPercent)).map((bar): WidgetWindow => ({
        label: bar.window.label.slice(0, 30),
        short: shortLabel(bar.window),
        usedPercent: Math.max(0, Math.min(100, bar.window.usedPercent)),
        ...(Number.isFinite(bar.window.resetsAt) ? { resetsAt: bar.window.resetsAt } : {}),
        ...(bar.level === "warn" || bar.level === "fail" ? { level: bar.level } : {}),
        ...paceOf(bar),
      })),
    };
  }).filter((account) => account.windows.length > 0);
}

export function usageSnapshot(hostId: string, machine: string, summary: UsageLimitsSummary, now: number): UsageSnapshot {
  const accounts = widgetUsage(summary, now);
  // Android's card drops the snapshot at `expiresAt`; only fresh readings keep it.
  const fresh = accounts.filter((account) => now - account.checkedAt < WIDGET_STALE_MS).map((account) => account.checkedAt + WIDGET_STALE_MS);
  return { version: 2, hostId, machine: machine.slice(0, 60), updatedAt: now, expiresAt: fresh.length > 0 ? Math.min(now + WIDGET_STALE_MS, ...fresh) : now, accounts };
}

interface Tracked extends WidgetThread {
  /** A run is on, whatever its question. */
  active: boolean;
  failed?: boolean;
  asking: Set<string>;
}

/**
 * What the Threads widget and the Live Activity show of one host: a thread
 * that asks first, then running ones, then those that ended. Sub-agents stay
 * out; they report to the thread that spawned them.
 */
export class ThreadBoard {
  private rows = new Map<string, Tracked>();
  private titles = new Map<string, { title: string; project?: string; child: boolean }>();

  constructor(private readonly now: () => number) {}

  private row(id: string): Tracked {
    let row = this.rows.get(id);
    if (!row) { row = { id, title: "", state: "done", active: false, asking: new Set() }; this.rows.set(id, row); }
    return row;
  }

  private settle(row: Tracked): void {
    if (row.asking.size > 0) row.state = "waiting";
    else if (row.active) { row.state = "running"; delete row.askedAt; if (!row.failed) delete row.reason; }
    else row.state = row.failed ? "failed" : "done";
  }

  index(index: Pick<ThreadIndexSnapshot, "sessions" | "runs">): void {
    for (const session of index.sessions) this.titles.set(session.id, { title: session.title, ...(session.projectName ? { project: session.projectName } : {}), child: Boolean(session.parentThreadId) });
    for (const [id, startedAt] of Object.entries(index.runs ?? {})) {
      const row = this.row(id);
      row.active = true; row.startedAt = startedAt; delete row.endedAt; delete row.failed;
      this.settle(row);
    }
  }

  /** True when the event changed what a widget shows. */
  apply(event: HostEvent): boolean {
    const at = this.now();
    if (event.type === "thread-index") { this.index(event.threadIndex); return true; }
    if (event.type === "agent-status") {
      // An end of a run this board never saw start says nothing new.
      if (!event.running && !this.rows.get(event.sessionId)?.active) return false;
      const row = this.row(event.sessionId);
      if (event.running) {
        if (!row.active) { row.startedAt = event.startedAt ?? at; delete row.endedAt; delete row.failed; delete row.reason; }
        row.active = true;
      } else {
        row.active = false; row.endedAt = at;
      }
      this.settle(row);
      return true;
    }
    if (event.type === "extension-ui-prompt") {
      const row = this.row(event.sessionId);
      if (row.asking.size === 0) row.askedAt = at;
      row.asking.add(event.prompt.id);
      row.reason = [event.prompt.title, event.prompt.message].filter((part) => part?.trim()).join(" — ").slice(0, 120);
      this.settle(row);
      return true;
    }
    if (event.type === "extension-ui-resolved") {
      const row = this.rows.get(event.sessionId);
      if (!row?.asking.delete(event.id)) return false;
      this.settle(row);
      return true;
    }
    if (event.type === "error" && event.sessionId) {
      const row = this.row(event.sessionId);
      row.failed = true; row.reason = event.message.slice(0, 120);
      if (!row.active) row.endedAt = at;
      this.settle(row);
      return true;
    }
    return false;
  }

  threads(): WidgetThread[] {
    const at = this.now();
    const rank = { waiting: 0, running: 1, done: 2, failed: 2 } as const;
    return [...this.rows.values()]
      .filter((row) => !this.titles.get(row.id)?.child && (row.state === "waiting" || row.state === "running" || at - (row.endedAt ?? 0) < ENDED_KEPT_MS))
      .sort((left, right) => rank[left.state] - rank[right.state]
        || (left.state === "waiting" ? (left.askedAt ?? 0) - (right.askedAt ?? 0) : 0)
        || (left.state === "running" ? (left.startedAt ?? 0) - (right.startedAt ?? 0) : (right.endedAt ?? 0) - (left.endedAt ?? 0)))
      .slice(0, THREADS_KEPT)
      .map(({ id, state, startedAt, endedAt, askedAt, reason }) => {
        const named = this.titles.get(id);
        return {
          id, title: (named?.title || "Agent work").slice(0, 80), ...(named?.project ? { project: named.project.slice(0, 40) } : {}), state,
          ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined && state !== "running" && state !== "waiting" ? { endedAt } : {}),
          ...(askedAt !== undefined && state === "waiting" ? { askedAt } : {}), ...(reason && (state === "waiting" || state === "failed") ? { reason } : {}),
        };
      });
  }
}
