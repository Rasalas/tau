import type { AttentionItem, AttentionReason } from "./protocol.js";

export type NotificationMode = "off" | "notification" | "sound" | "both";
export type SoundName = "chime" | "ping";

/** The user's choices, kept in the host's config (`values` and `options` of this kit) like any setting. */
export interface NotificationSettings {
  mode: NotificationMode;
  sound: SoundName;
  /** While the window has focus and another thread is on screen, a toast in the window replaces the system notification. */
  toasts: boolean;
  /** Notify (and play the sound) for the thread on screen in a focused window too. */
  whenFocused: boolean;
}

// Opt-in: nothing is shown, sounded or badged until the user picks a mode.
export const DEFAULT_SETTINGS: NotificationSettings = { mode: "off", sound: "chime", toasts: false, whenFocused: false };

export const MODES: ReadonlyArray<{ value: NotificationMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "notification", label: "Notification" },
  { value: "sound", label: "Sound" },
  { value: "both", label: "Both" },
];

export const SOUNDS: ReadonlyArray<{ value: SoundName; label: string }> = [
  { value: "chime", label: "Chime" },
  { value: "ping", label: "Ping" },
];

export function readMode(value: string | undefined): NotificationMode {
  return MODES.some((mode) => mode.value === value) ? value as NotificationMode : DEFAULT_SETTINGS.mode;
}

export function readSound(value: string | undefined): SoundName {
  return SOUNDS.some((sound) => sound.value === value) ? value as SoundName : DEFAULT_SETTINGS.sound;
}

/** How one piece of news reaches this client's user. */
export interface Presentation {
  system: boolean;
  sound: boolean;
  toast: boolean;
}

/** Where the user is relative to the thread: elsewhere, in this window on another thread, or looking at it. */
export type Whereabouts = "background" | "other-thread" | "on-screen";

/**
 * How loud one piece of news is here. The mode says which of notification
 * and sound this client uses at all; a toast can stand in for the notification
 * while the window has focus, and the thread on screen speaks only when asked to.
 */
export function presentation(settings: NotificationSettings, where: Whereabouts): Presentation {
  const notifies = settings.mode === "notification" || settings.mode === "both";
  const sounds = settings.mode === "sound" || settings.mode === "both";
  if (where === "on-screen") return settings.whenFocused ? { system: notifies, sound: sounds, toast: false } : { system: false, sound: false, toast: false };
  if (where === "other-thread" && settings.toasts) return { system: false, sound: sounds, toast: true };
  return { system: notifies, sound: sounds, toast: false };
}

/** The badge is the count of threads with unseen news, unless this client turned it all off. */
export function badgeCount(settings: NotificationSettings, items: readonly AttentionItem[]): number {
  return settings.mode === "off" ? 0 : items.length;
}

const HEADLINES: Record<AttentionReason, string> = {
  completed: "Finished",
  failed: "Stopped with an error",
  question: "Waiting for your answer",
  approval: "Waiting for your approval",
};

export const headline = (reason: AttentionReason): string => HEADLINES[reason];

/** Title and body of one notification for one or several threads, newest first. */
export function describe(items: readonly AttentionItem[], titleOf: (item: AttentionItem) => string): { title: string; body: string } {
  const [first] = items;
  if (!first) return { title: "", body: "" };
  if (items.length === 1) return { title: titleOf(first), body: HEADLINES[first.reason] };
  const names = items.slice(0, 3).map(titleOf).join(", ");
  return { title: `${items.length} threads need you`, body: items.length > 3 ? `${names} and ${items.length - 3} more` : names };
}
