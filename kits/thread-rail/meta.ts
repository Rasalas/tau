// Pure rules over the kit's thread meta, shared by both halves. No imports beyond types.
import type { UiSession } from "tau";
import type {
  RailSectionId,
  RailSections,
  RailSettings,
  RailState,
  SettledBy,
  ThreadMeta,
  ThreadMetaPatch,
} from "./protocol.js";

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_SETTINGS: RailSettings = { onMerged: true, onClosed: false };
export const EMPTY_STATE: RailState = { threads: {}, settings: DEFAULT_SETTINGS };

const SETTLED_BY: readonly SettledBy[] = ["user", "inactive", "pr-merged", "pr-closed"];
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function decodeMeta(value: unknown): ThreadMeta | undefined {
  const raw = record(value);
  const meta: ThreadMeta = {
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(number(raw.pinOrder) !== undefined ? { pinOrder: number(raw.pinOrder) } : {}),
    ...(number(raw.order) !== undefined ? { order: number(raw.order) } : {}),
    ...(number(raw.snoozedUntil) !== undefined ? { snoozedUntil: number(raw.snoozedUntil) } : {}),
    ...(number(raw.settledAt) !== undefined ? { settledAt: number(raw.settledAt) } : {}),
    ...(SETTLED_BY.includes(raw.settledBy as SettledBy) ? { settledBy: raw.settledBy as SettledBy } : {}),
    ...(number(raw.keptAt) !== undefined ? { keptAt: number(raw.keptAt) } : {}),
    ...(text(raw.settledForRequest) ? { settledForRequest: text(raw.settledForRequest) } : {}),
    ...(text(raw.siblingGroupId) ? { siblingGroupId: text(raw.siblingGroupId) } : {}),
    ...(text(raw.model) ? { model: text(raw.model) } : {}),
    ...(number(raw.activityAt) !== undefined ? { activityAt: number(raw.activityAt) } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function decodeSettings(value: unknown): RailSettings {
  const raw = record(value);
  const days = number(raw.inactiveDays);
  return {
    ...(days !== undefined && days > 0 ? { inactiveDays: days } : {}),
    onMerged: typeof raw.onMerged === "boolean" ? raw.onMerged : DEFAULT_SETTINGS.onMerged,
    onClosed: typeof raw.onClosed === "boolean" ? raw.onClosed : DEFAULT_SETTINGS.onClosed,
  };
}

export function decodeState(value: unknown): RailState {
  const raw = record(value);
  const threads: Record<string, ThreadMeta> = {};
  for (const [id, entry] of Object.entries(record(raw.threads))) {
    const meta = decodeMeta(entry);
    if (meta) threads[id] = meta;
  }
  return { threads, settings: decodeSettings(raw.settings) };
}

/** Applies patches; answers the same object when nothing changed, so callers can skip a write. */
export function applyPatches(state: RailState, patches: Readonly<Record<string, ThreadMetaPatch | null>>): RailState {
  let threads: Record<string, ThreadMeta> | undefined;
  for (const [id, patch] of Object.entries(patches)) {
    const current = (threads ?? state.threads)[id];
    let next: ThreadMeta | undefined;
    if (patch !== null) {
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete merged[key];
        else merged[key] = value;
      }
      next = decodeMeta(merged);
    }
    if (sameMeta(current, next)) continue;
    threads ??= { ...state.threads };
    if (next) threads[id] = next;
    else delete threads[id];
  }
  return threads ? { ...state, threads } : state;
}

function sameMeta(left: ThreadMeta | undefined, right: ThreadMeta | undefined): boolean {
  if (!left || !right) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key as keyof ThreadMeta] === right[key as keyof ThreadMeta]);
}

export function isSnoozed(meta: ThreadMeta | undefined, now: number): boolean {
  return meta?.snoozedUntil !== undefined && meta.snoozedUntil > now;
}

/** The section a thread is drawn in: settled beats snoozed, snoozed beats pinned. */
export function sectionOf(meta: ThreadMeta | undefined, now: number): RailSectionId {
  if (meta?.settledAt !== undefined) return "settled";
  if (isSnoozed(meta, now)) return "snoozed";
  return meta?.pinned ? "pinned" : "active";
}

/** Threads started together stay together, at the place of the first one. */
function withSiblingsTogether(threads: UiSession[], state: RailState): UiSession[] {
  const groups = new Map<string, UiSession[]>();
  for (const thread of threads) {
    const group = state.threads[thread.id]?.siblingGroupId;
    if (group) groups.set(group, [...groups.get(group) ?? [], thread]);
  }
  if ([...groups.values()].every((members) => members.length < 2)) return threads;
  const placed = new Set<string>();
  const ordered: UiSession[] = [];
  for (const thread of threads) {
    if (placed.has(thread.id)) continue;
    const group = state.threads[thread.id]?.siblingGroupId;
    for (const member of group ? groups.get(group) ?? [thread] : [thread]) {
      placed.add(member.id);
      ordered.push(member);
    }
  }
  return ordered;
}

/**
 * Splits the rail's threads into its four sections, each in its own order:
 * pins by rank; active threads newest first above the ones the user arranged;
 * snoozed threads by when they wake; settled threads latest first.
 */
export function railSections(threads: readonly UiSession[], state: RailState, now: number): RailSections {
  const sections: RailSections = { pinned: [], active: [], snoozed: [], settled: [] };
  for (const thread of threads) sections[sectionOf(state.threads[thread.id], now)].push(thread);
  const meta = (thread: UiSession): ThreadMeta => state.threads[thread.id] ?? {};
  const rank = (value: number | undefined) => value ?? Number.NEGATIVE_INFINITY;
  const byRecency = (left: UiSession, right: UiSession) => right.modifiedAt - left.modifiedAt;
  sections.pinned.sort((left, right) => rank(meta(left).pinOrder) - rank(meta(right).pinOrder) || byRecency(left, right));
  sections.active.sort((left, right) => rank(meta(left).order) - rank(meta(right).order) || byRecency(left, right));
  sections.active = withSiblingsTogether(sections.active, state);
  sections.snoozed.sort((left, right) => (meta(left).snoozedUntil ?? 0) - (meta(right).snoozedUntil ?? 0));
  sections.settled.sort((left, right) => (meta(right).settledAt ?? 0) - (meta(left).settledAt ?? 0) || byRecency(left, right));
  return sections;
}

/** Settling takes the thread off every other list. */
export function settlePatch(now: number, by: SettledBy): ThreadMetaPatch {
  return { settledAt: now, settledBy: by, pinned: null, pinOrder: null, order: null, snoozedUntil: null, keptAt: null };
}

/** Back from the shelf, at the top of the active threads, and safe from the rules until it moves again. */
export function unsettlePatch(now: number): ThreadMetaPatch {
  return { settledAt: null, settledBy: null, order: null, keptAt: now };
}

export function pinPatch(state: RailState, threadId: string, pinned: boolean, now: number): ThreadMetaPatch {
  if (!pinned) return { pinned: null, pinOrder: null };
  const ranks = Object.values(state.threads).flatMap((meta) => meta.pinned && meta.pinOrder !== undefined ? [meta.pinOrder] : []);
  const settled = state.threads[threadId]?.settledAt !== undefined;
  return { pinned: true, pinOrder: ranks.length > 0 ? Math.min(...ranks) - 1 : 0, ...(settled ? unsettlePatch(now) : {}) };
}

export function snoozePatch(until: number): ThreadMetaPatch {
  return { snoozedUntil: until, settledAt: null, settledBy: null };
}

export const WAKE_PATCH: ThreadMetaPatch = { snoozedUntil: null };

export interface RailDrop {
  sectionId: string;
  beforeThreadId?: string;
}

/** What a drop does, in the word the dragged row shows; undefined where it may not land. */
export function dropLabel(from: RailSectionId, to: string): string | undefined {
  if (to === "snoozed") return undefined;
  if (to === "settled") return from === "settled" ? undefined : "Settle";
  if (to !== "pinned" && to !== "active") return undefined;
  if (from === to) return "Move";
  if (from === "settled") return "Un-settle";
  if (from === "snoozed") return "Wake";
  return to === "pinned" ? "Pin" : "Unpin";
}

/**
 * The patches a drop makes: the dragged thread changes section, and every
 * thread of the section it lands in is ranked in the order the drop leaves.
 */
export function dropPatches(
  state: RailState,
  sections: RailSections,
  threadId: string,
  drop: RailDrop,
  now: number,
): Record<string, ThreadMetaPatch> | undefined {
  const from = sectionOf(state.threads[threadId], now);
  if (!dropLabel(from, drop.sectionId)) return undefined;
  if (drop.sectionId === "settled") return { [threadId]: settlePatch(now, "user") };
  const target = drop.sectionId as "pinned" | "active";
  const ids = sections[target].map((thread) => thread.id).filter((id) => id !== threadId);
  const at = drop.beforeThreadId ? ids.indexOf(drop.beforeThreadId) : -1;
  ids.splice(at < 0 ? ids.length : at, 0, threadId);
  const rankKey = target === "pinned" ? "pinOrder" : "order";
  const patches: Record<string, ThreadMetaPatch> = Object.fromEntries(ids.map((id, index) => [id, { [rankKey]: index }]));
  const moved: ThreadMetaPatch = {
    ...patches[threadId],
    ...(from === "settled" ? unsettlePatch(now) : {}),
    ...(from === "snoozed" ? WAKE_PATCH : {}),
    ...(target === "pinned" ? { pinned: true } : { pinned: null, pinOrder: null }),
    [rankKey]: ids.indexOf(threadId),
  };
  patches[threadId] = moved;
  return patches;
}

/** One thread as the host's sweep sees it. */
export interface SweepThread {
  id: string;
  cwd: string;
  /** When its session file last changed. */
  modifiedAt?: number;
}

/** A pull or merge request as Review Kit reports it. */
export interface SweepRequest {
  state?: "open" | "closed" | "merged";
  url: string;
}

/**
 * The checkouts whose request the sweep has to ask about: only a thread that
 * has its checkout to itself (a worktree thread), because a shared checkout's
 * branch says nothing about which of its threads the request belongs to.
 */
export function requestCheckouts(threads: readonly SweepThread[], state: RailState, running: ReadonlySet<string>, now: number): string[] {
  if (!state.settings.onMerged && !state.settings.onClosed) return [];
  const count = new Map<string, number>();
  for (const thread of threads) count.set(thread.cwd, (count.get(thread.cwd) ?? 0) + 1);
  return [...new Set(threads.filter((thread) => count.get(thread.cwd) === 1 && eligible(thread, state, running, now)).map((thread) => thread.cwd))];
}

function lastActivity(thread: SweepThread, meta: ThreadMeta | undefined): number | undefined {
  const times = [thread.modifiedAt, meta?.activityAt].filter((value): value is number => value !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function eligible(thread: SweepThread, state: RailState, running: ReadonlySet<string>, now: number): boolean {
  const meta = state.threads[thread.id];
  if (meta?.settledAt !== undefined || running.has(thread.id) || isSnoozed(meta, now)) return false;
  const activity = lastActivity(thread, meta);
  // A thread the user took off the shelf waits for new work before any rule applies again.
  return !(meta?.keptAt !== undefined && (activity === undefined || activity <= meta.keptAt));
}

/**
 * One pass of the rules: snoozes that ran out wake, and an idle thread settles
 * when its request merged or closed (as the settings ask) or when it has been
 * quiet longer than the settings allow. A running thread is never touched.
 */
export function sweepPatches(
  threads: readonly SweepThread[],
  state: RailState,
  running: ReadonlySet<string>,
  requests: ReadonlyMap<string, SweepRequest>,
  now: number,
): Record<string, ThreadMetaPatch> {
  const patches: Record<string, ThreadMetaPatch> = {};
  for (const [id, meta] of Object.entries(state.threads)) {
    if (meta.snoozedUntil !== undefined && meta.snoozedUntil <= now) patches[id] = { ...WAKE_PATCH };
  }
  const woken = applyPatches(state, patches);
  const { inactiveDays, onMerged, onClosed } = state.settings;
  for (const thread of threads) {
    if (!eligible(thread, woken, running, now)) continue;
    const meta = woken.threads[thread.id];
    const request = requests.get(thread.cwd);
    const byRequest = request && request.url !== meta?.settledForRequest
      ? request.state === "merged" && onMerged ? "pr-merged" as const
        : request.state === "closed" && onClosed ? "pr-closed" as const : undefined
      : undefined;
    if (byRequest) {
      patches[thread.id] = { ...patches[thread.id], ...settlePatch(now, byRequest), settledForRequest: request!.url };
      continue;
    }
    const activity = lastActivity(thread, meta);
    if (inactiveDays !== undefined && activity !== undefined && activity < now - inactiveDays * DAY_MS) {
      patches[thread.id] = { ...patches[thread.id], ...settlePatch(now, "inactive") };
    }
  }
  return patches;
}

/** The next time a snooze runs out, for the host's wake timer. */
export function nextWake(state: RailState, now: number): number | undefined {
  const times = Object.values(state.threads).flatMap((meta) => meta.snoozedUntil !== undefined && meta.snoozedUntil > now ? [meta.snoozedUntil] : []);
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** The snooze presets of the row menu, in local time. */
export function snoozePresets(now: Date): Array<{ id: string; label: string; until: number }> {
  const at = (date: Date, days: number, hour: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    next.setHours(hour, 0, 0, 0);
    return next.getTime();
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { id: "snooze:1h", label: "For an hour", until: now.getTime() + 60 * 60 * 1_000 },
    { id: "snooze:tomorrow", label: "Until tomorrow, 9:00", until: at(now, 1, 9) },
    { id: "snooze:next-week", label: "Until next week", until: at(now, toMonday, 9) },
  ];
}

/** "in 4 min", "until 09:00", "until Mon 09:00": when a snoozed thread wakes, briefly. */
export function wakeLabel(until: number, now: number): string {
  const minutes = Math.round((until - now) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return until - now < DAY_MS && date.getDate() === new Date(now).getDate()
    ? time
    : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
