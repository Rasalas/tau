import type { AttentionItem, AttentionReason } from "./protocol.js";

export type NotificationMode = "off" | "notification" | "sound" | "both";
export type SoundName = "chime" | "ping";

/** One client's own choices; another machine attached to the same host keeps its own. */
export interface NotificationSettings {
  mode: NotificationMode;
  sound: SoundName;
  /** A toast inside the window while it has focus and another thread is on screen. */
  toasts: boolean;
  /** The system notification (and sound) even while the window has focus. */
  whenFocused: boolean;
}

export const DEFAULT_SETTINGS: NotificationSettings = { mode: "notification", sound: "chime", toasts: false, whenFocused: false };

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

/**
 * The host already decided the thread is not on screen in a focused window.
 * What is left is how loud to be: out of focus the mode decides; in focus
 * (another thread on screen) only the two opt-ins do.
 */
export function presentation(settings: NotificationSettings, focused: boolean): Presentation {
  const notifies = settings.mode === "notification" || settings.mode === "both";
  const sounds = settings.mode === "sound" || settings.mode === "both";
  if (!focused) return { system: notifies, sound: sounds, toast: false };
  return {
    system: notifies && settings.whenFocused,
    sound: sounds && (settings.whenFocused || settings.toasts),
    toast: settings.toasts,
  };
}

/** The badge is the count of threads with unseen news, unless this client turned it all off. */
export function badgeCount(settings: NotificationSettings, items: readonly AttentionItem[]): number {
  return settings.mode === "off" ? 0 : items.length;
}

const HEADLINES: Record<AttentionReason, string> = {
  completed: "Finished",
  failed: "Stopped with an error",
  question: "Waiting for your answer",
};

/** Title and body of one notification for one or several threads, newest first. */
export function describe(items: readonly AttentionItem[], titleOf: (item: AttentionItem) => string): { title: string; body: string } {
  const [first] = items;
  if (!first) return { title: "", body: "" };
  if (items.length === 1) return { title: titleOf(first), body: HEADLINES[first.reason] };
  const names = items.slice(0, 3).map(titleOf).join(", ");
  return { title: `${items.length} threads need you`, body: items.length > 3 ? `${names} and ${items.length - 3} more` : names };
}
