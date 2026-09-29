import { getClientStorage } from "tau";
import { groupAccounts, type LimitGroup } from "./accounts.js";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "./protocol.js";
import { quotaState, type QuotaState } from "./quota.js";
import { toneOf, type UsageTone } from "./tones.js";

/** A window of one model ("Weekly · Opus"), as Juicebar tells them apart. */
export function isModelWindow(window: Pick<UsageLimitWindow, "id" | "label">): boolean {
  return window.label.includes(" · ") || window.id.startsWith("model.");
}

function rank(window: UsageLimitWindow): number {
  if (isModelWindow(window)) return 3;
  return window.kind === "session" ? 0 : window.kind === "weekly" ? 1 : window.kind === "monthly" ? 2 : 3;
}

/** Short windows first, then the week, the month, a model's; the same order on every read. */
export function orderWindows(windows: readonly UsageLimitWindow[]): UsageLimitWindow[] {
  return [...windows].sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
}

/**
 * Before the user chooses: the 5-hour and weekly windows, not a model's; an
 * account with neither (a monthly plan) shows its first window.
 */
export function shownByDefault(window: UsageLimitWindow, windows: readonly UsageLimitWindow[]): boolean {
  if (isModelWindow(window)) return false;
  const usual = (entry: UsageLimitWindow) => !isModelWindow(entry) && (entry.kind === "session" || entry.kind === "weekly");
  return usual(window) || (!windows.some(usual) && orderWindows(windows)[0] === window);
}

/** Where a window's choice is kept: the account as `groupAccounts` keys it, so each machine's copy shares it. */
export function choiceKey(group: Pick<LimitGroup, "key">, window: Pick<UsageLimitWindow, "id">): string {
  return `${group.key}|${window.id}`;
}

export type JuicebarLevel = "fail" | "warn" | "stale";

export interface Juicebar {
  window: UsageLimitWindow;
  /** 0–100. */
  left: number;
  state: QuotaState;
  level?: JuicebarLevel;
}

export interface JuicebarGroup {
  group: LimitGroup;
  tone: UsageTone;
  bars: Juicebar[];
}

/** At or below this much left a bar turns to the warn colour, as Juicebar's does. */
const LOW_LEFT = 10;
const TONE_ORDER: readonly UsageTone[] = ["openai", "anthropic", "google", "pi", "other"];

function levelOf(state: QuotaState, left: number): JuicebarLevel | undefined {
  if (state.kind === "expired" || state.kind === "stale") return "stale";
  if (state.kind === "exhausted") return "fail";
  if (state.kind === "forecast" || left <= LOW_LEFT) return "warn";
  return undefined;
}

/** The provider an account's colour follows: a shared one its identity's, Pi its plan's, else its runtime's. */
export function toneOfGroup(group: LimitGroup): UsageTone {
  const account = group.members[0]!;
  if (group.members.length > 1 && group.shown.identity) return toneOf(group.shown.identity.provider);
  return toneOf(account.id.startsWith("pi:") ? account.id.slice(3) : account.runtime);
}

/**
 * The bars the sidebar's foot draws: every account once across machines, in
 * a fixed order, each with the windows shown by the user's choice or the
 * default. An account without windows (an API key) draws none.
 */
export function juicebarGroups(limits: UsageLimitsSummary | undefined, choices: Readonly<Record<string, boolean>>, now: number): JuicebarGroup[] {
  if (!limits) return [];
  const history = limits.history ?? [];
  return groupAccounts(limits.accounts)
    .filter((group) => group.shown.windows.length > 0)
    .map((group): JuicebarGroup => {
      const account: UsageLimitAccount = group.shown;
      const bars = orderWindows(account.windows)
        .filter((window) => choices[choiceKey(group, window)] ?? shownByDefault(window, account.windows))
        .map((window): Juicebar => {
          const left = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
          const state = quotaState(account, window, history, now);
          const level = levelOf(state, left);
          return { window, left, state, ...(level ? { level } : {}) };
        });
      return { group, tone: toneOfGroup(group), bars };
    })
    .filter((entry) => entry.bars.length > 0)
    .sort((left, right) => TONE_ORDER.indexOf(left.tone) - TONE_ORDER.indexOf(right.tone) || left.group.label.localeCompare(right.group.label));
}

const CHOICES_KEY = "tau.usage.sidebar-windows";

/** Which windows the foot shows, chosen per device; unchosen ones follow `shownByDefault`. */
export function createJuicebarChoices() {
  let choices: Record<string, boolean> | undefined;
  const listeners = new Set<() => void>();
  const read = (): Record<string, boolean> => {
    if (choices) return choices;
    try {
      const stored = JSON.parse(getClientStorage()?.get(CHOICES_KEY) ?? "null") as unknown;
      choices = stored && typeof stored === "object" ? stored as Record<string, boolean> : {};
    } catch {
      choices = {};
    }
    return choices;
  };
  return {
    getSnapshot: read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(key: string, shown: boolean): void {
      choices = { ...read(), [key]: shown };
      try { getClientStorage()?.set(CHOICES_KEY, JSON.stringify(choices)); } catch { /* kept for this run */ }
      for (const listener of [...listeners]) listener();
    },
  };
}

export type JuicebarChoices = ReturnType<typeof createJuicebarChoices>;
