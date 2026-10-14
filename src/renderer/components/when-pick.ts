import type { ClientStorage } from "../../workbench/client-storage";

/** One time a `WhenPicker` offers: "Tomorrow", shown as "Thu 09:00". */
export interface WhenPreset {
  /** Stable across days, so a remembered pick finds its row again: "tomorrow", not a date. */
  id: string;
  label: string;
  /** The time, short, at the row's end. */
  when: string;
  /** Epoch ms. */
  at: number;
}

/** The row a picker had last: a preset's id, or `custom` for a date and time of the user's own. */
export type WhenPick = string;

export const CUSTOM_WHEN = "custom";

const key = (rememberKey: string) => `when-pick:${rememberKey}`;

/** The pick saved under `rememberKey`, when there is one. */
export function readWhenPick(storage: ClientStorage, rememberKey: string): WhenPick | undefined {
  return storage.get(key(rememberKey)) ?? undefined;
}

/**
 * Saves a pick so the picker opens on it next time (API 1.64.0). Call it when
 * the pick is used, not while the user browses the list.
 */
export function rememberWhenPick(storage: ClientStorage, rememberKey: string, pick: WhenPick): void {
  storage.set(key(rememberKey), pick);
}

/** `YYYY-MM-DDTHH:mm` in local time, what a datetime-local field reads and writes. */
export function localDateTimeInput(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Thu 09:00", or "09:00" for later today: a time as a row or a chip shows it. */
export function shortWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const days = (at - now) / 86_400_000;
  if (days > 0 && days < 6) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/**
 * The presets the Plan sheet offers for a message, in local time: soon,
 * tomorrow morning and afternoon, and next Monday morning.
 */
export function planPresets(now: Date): WhenPreset[] {
  const hour = 3_600_000;
  const at = (days: number, hourOfDay: number) => {
    const next = new Date(now);
    next.setDate(next.getDate() + days);
    next.setHours(hourOfDay, 0, 0, 0);
    return next.getTime();
  };
  const nowMs = now.getTime();
  const inOne = nowMs + hour;
  const evening = at(0, 18);
  const tomorrow = at(1, 9);
  const afternoon = at(1, 14);
  const monday = at(((8 - now.getDay()) % 7) || 7, 9);
  return [
    { id: "1h", label: "In 1 hour", at: inOne, when: shortWhen(inOne, nowMs) },
    ...(evening - nowMs > hour ? [{ id: "evening", label: "This evening", at: evening, when: shortWhen(evening, nowMs) }] : []),
    { id: "tomorrow", label: "Tomorrow morning", at: tomorrow, when: shortWhen(tomorrow, nowMs) },
    { id: "tomorrow-afternoon", label: "Tomorrow afternoon", at: afternoon, when: shortWhen(afternoon, nowMs) },
    // On a Sunday next Monday is tomorrow.
    ...(monday !== tomorrow ? [{ id: "next-week", label: "Next week", at: monday, when: shortWhen(monday, nowMs) }] : []),
  ];
}
