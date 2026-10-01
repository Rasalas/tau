import type { UsageLimitAccount, UsageLimitWindow } from "../../kits/usage/protocol";
import { groupAccounts, type LimitGroup } from "../../kits/usage/accounts";
import { toneOf, type UsageTone } from "../../kits/usage/tones";

/**
 * What the app hands the phone's widgets and its running-threads notification or Live Activity:
 * one snapshot per host, the same on iOS (App Group) and Android (SharedPreferences). Display
 * fields only, never tokens or account ids. Android reads it in `widgets/WidgetModel.kt`.
 */
export interface WidgetSnapshot {
  version: 2;
  hostId: string;
  /** The host's name as the phone calls it ("Mac mini"). */
  machine: string;
  updatedAt: number;
  /** Absent until the host answered once; the platform keeps the last accounts meanwhile. */
  accounts?: WidgetAccount[];
  /** Waiting and running threads, then the latest finished ones; at most `MAX_THREADS`. */
  threads: WidgetThread[];
}

export interface WidgetWindow {
  label: string;
  /** "5h", "wk", "mo": a bar's caption. */
  short: string;
  usedPercent: number;
  resetsAt?: number;
}

export interface WidgetAccount {
  /** Pools one subscription seen through several hosts or runtimes. */
  poolKey?: string;
  label: string;
  plan?: string;
  tone: UsageTone;
  /** The mark the app draws for it: `codex`, `claude-code`, `gemini`, `opencode`, `pi`, or none. */
  mark?: string;
  checkedAt: number;
  /** The windows the sidebar's juicebars show by default, short ones first. */
  windows: WidgetWindow[];
}

export type WidgetThreadState = "question" | "running" | "done" | "failed";

export interface WidgetThread {
  id: string;
  title: string;
  project?: string;
  state: WidgetThreadState;
  /** When the thread entered this state: a run's start, a question's arrival, a turn's end. */
  since: number;
  updatedAt: number;
  /** A question's own title. */
  detail?: string;
}

export const WIDGET_SNAPSHOT_VERSION = 2;
export const MAX_THREADS = 8;
/** Finished threads stay this long. */
export const FINISHED_MS = 3 * 60 * 60_000;
const TONE_ORDER: readonly UsageTone[] = ["openai", "anthropic", "google", "pi", "other"];

// As kits/usage/juicebars.ts, which mobile cannot import (it needs the extension API).
const isModelWindow = (window: UsageLimitWindow) => window.label.includes(" · ") || window.id.startsWith("model.");
const rank = (window: UsageLimitWindow) => isModelWindow(window) ? 3 : window.kind === "session" ? 0 : window.kind === "weekly" ? 1 : window.kind === "monthly" ? 2 : 3;
function shownWindows(windows: readonly UsageLimitWindow[]): UsageLimitWindow[] {
  const ordered = [...windows].sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
  const usual = ordered.filter((window) => !isModelWindow(window) && (window.kind === "session" || window.kind === "weekly"));
  return usual.length > 0 ? usual : ordered.slice(0, 1);
}
function toneOfGroup(group: LimitGroup): UsageTone {
  const account = group.members[0]!;
  if (group.members.length > 1 && group.shown.identity) return toneOf(group.shown.identity.provider);
  return toneOf(account.id.startsWith("pi:") ? account.id.slice(3) : account.runtime);
}

function markOf(name: string): string | undefined {
  const key = name.split("@")[0]!.toLowerCase();
  if (/^(codex|openai|chatgpt)/u.test(key)) return "codex";
  if (/^(claude|anthropic)/u.test(key)) return "claude-code";
  if (/^(gemini|google|antigravity|vertex)/u.test(key)) return "gemini";
  if (key.startsWith("opencode")) return "opencode";
  return key === "pi" ? "pi" : undefined;
}

/** A shared plan wears its product's mark, a Pi account its provider's, anything else its runtime's (as `providerMark`). */
function markOfGroup(group: LimitGroup): string | undefined {
  if (group.members.length > 1 && group.shown.identity) return markOf(group.shown.identity.provider);
  const account = group.members[0]!;
  return markOf(account.id.startsWith("pi:") ? account.id.slice(3) : account.runtime);
}

function shortLabel(window: UsageLimitWindow): string {
  if (window.windowMinutes && window.windowMinutes % 60 === 0 && window.windowMinutes < 24 * 60) return `${window.windowMinutes / 60}h`;
  if (window.kind === "session") return "5h";
  if (window.kind === "weekly") return "wk";
  if (window.kind === "monthly") return "mo";
  return window.label.slice(0, 3).toLowerCase();
}

/**
 * Each account once, in the juicebars' order, with the windows they show by default. `keepStale`
 * keeps old readings, which the widgets draw faded instead of dropping.
 */
export function widgetAccounts(accounts: readonly UsageLimitAccount[], now: number, keepStale = false): WidgetAccount[] {
  const current = accounts.filter((account) => !account.unavailable && account.windows.length > 0 && Number.isFinite(account.checkedAt)
    && account.checkedAt <= now + 60_000 && (keepStale || now - account.checkedAt < 15 * 60_000));
  return groupAccounts(current).map((group): WidgetAccount => {
    const mark = markOfGroup(group);
    return {
      ...(group.shown.identity ? { poolKey: `${group.shown.identity.provider}:${group.shown.identity.key}` } : {}),
      label: group.label.slice(0, 100),
      ...(group.shown.plan ? { plan: group.shown.plan.slice(0, 40) } : {}),
      tone: toneOfGroup(group),
      ...(mark ? { mark } : {}),
      checkedAt: group.shown.checkedAt,
      windows: shownWindows(group.shown.windows).filter((window) => Number.isFinite(window.usedPercent)).map((window) => ({
        label: window.label.slice(0, 50), short: shortLabel(window), usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        ...(Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
      })),
    };
  }).sort((left, right) => TONE_ORDER.indexOf(left.tone) - TONE_ORDER.indexOf(right.tone) || left.label.localeCompare(right.label));
}

const RANK: Record<WidgetThreadState, number> = { question: 0, running: 1, done: 2, failed: 2 };

/** Waiting first, then running (longest first), then the latest finished; old finished ones leave. */
export function widgetThreads(threads: Iterable<WidgetThread>, now: number): WidgetThread[] {
  return [...threads]
    .filter((thread) => thread.state === "question" || thread.state === "running" || now - thread.since <= FINISHED_MS)
    .sort((left, right) => RANK[left.state] - RANK[right.state] || (RANK[left.state] < 2 ? left.since - right.since : right.since - left.since))
    .slice(0, MAX_THREADS)
    .map((thread) => ({ ...thread, title: thread.title.slice(0, 100), ...(thread.project ? { project: thread.project.slice(0, 60) } : {}), ...(thread.detail ? { detail: thread.detail.slice(0, 120) } : {}) }));
}
