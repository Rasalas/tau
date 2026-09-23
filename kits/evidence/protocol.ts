/**
 * Evidence Kit's contract between its halves, and what other kits may call.
 * Core knows none of it: it routes the commands by extension id and lists the
 * frames only as turn attachments with a media type.
 */

export const EVIDENCE_EXTENSION_ID = "tau.evidence";

/** Event with `{ threadId }` whenever a thread's frames changed. */
export const EVIDENCE_CHANGED_EVENT = "changed";
/** Event with `{ paused: Record<threadId, reason> }` whenever a pause starts or ends. */
export const EVIDENCE_PAUSED_EVENT = "paused";

/** Host extensions that may pause and resume capture (the hand-over ticket's kit adds its id here). */
export const EVIDENCE_PAUSE_CALLERS: readonly string[] = [];

/** Where a frame came from: the Preview's page, or the window the agent drives. */
export type EvidenceSource = "preview" | "screen";

/** What took it: the turn's start or end, an agent action, the clock, or the agent on purpose. */
export type EvidenceTrigger = "turn-start" | "action" | "periodic" | "turn-end" | "agent";

export interface EvidenceFrame {
  id: string;
  at: number;
  source: EvidenceSource;
  trigger: EvidenceTrigger;
  caption: string;
  width: number;
  height: number;
  /** Bytes of the frame and of its thumbnail. */
  size: number;
  thumbSize: number;
  mediaType: string;
  /** The page, for a Preview frame. */
  url?: string;
  /** The app and its window's title, for a screen frame. */
  app?: string;
  title?: string;
}

export interface EvidenceTurn {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  frames: EvidenceFrame[];
}

export interface EvidenceThread {
  threadId: string;
  turns: EvidenceTurn[];
}

/** The kit's settings, as `services.settings` answers them for a project. */
export interface EvidenceSettings {
  preview: boolean;
  screen: boolean;
  retentionDays: number;
  threadMegabytes: number;
}

export const SETTING_KEYS = {
  preview: "preview",
  screen: "screen",
  retentionDays: "retention-days",
  threadMegabytes: "thread-mb",
} as const;

export const DEFAULT_SETTINGS: EvidenceSettings = { preview: true, screen: true, retentionDays: 14, threadMegabytes: 50 };
export const RETENTION_CHOICES = [3, 7, 14, 30, 90] as const;
export const THREAD_MEGABYTE_CHOICES = [10, 25, 50, 100, 200] as const;

/** At most this many frames a turn; the first one and the agent's own stay. */
export const FRAMES_PER_TURN = 60;
export const FRAME_WIDTH = 960;
export const THUMB_WIDTH = 160;
/** A running turn looks at the Preview this often; an unchanged page is dropped. */
export const PERIODIC_MS = 10_000;

export function readEvidenceSettings(settings: { options: Record<string, boolean>; values: Record<string, string> } | undefined): EvidenceSettings {
  const number = (key: string, choices: readonly number[], fallback: number): number => {
    const value = Number(settings?.values[key]);
    return choices.includes(value) ? value : fallback;
  };
  return {
    preview: settings?.options[SETTING_KEYS.preview] ?? DEFAULT_SETTINGS.preview,
    screen: settings?.options[SETTING_KEYS.screen] ?? DEFAULT_SETTINGS.screen,
    retentionDays: number(SETTING_KEYS.retentionDays, RETENTION_CHOICES, DEFAULT_SETTINGS.retentionDays),
    threadMegabytes: number(SETTING_KEYS.threadMegabytes, THREAD_MEGABYTE_CHOICES, DEFAULT_SETTINGS.threadMegabytes),
  };
}

export interface EvidenceHostCommands {
  "list": { input: { threadId: string }; output: EvidenceThread };
  /** A frame or its thumbnail as a data URL; `null` once it is gone. */
  "image": { input: { threadId: string; id: string; thumb?: boolean }; output: string | null };
  "delete-turn": { input: { threadId: string; turnId: string }; output: void };
  "pause": { input: { threadId: string; reason: string }; output: void };
  "resume": { input: { threadId: string }; output: void };
  "paused": { input: undefined; output: Record<string, string> };
}

/**
 * What the desktop half publishes with `provideService`. `pause` holds every
 * capture of the thread — and every Preview capture, since the Preview is
 * shared — until `resume`; a hand-over to the user calls it before a login.
 */
export const EVIDENCE_SERVICE = "tau.evidence/capture";

export interface EvidenceCaptureService {
  pause(threadId: string, reason: string): Promise<void>;
  resume(threadId: string): Promise<void>;
  list(threadId: string): Promise<EvidenceThread>;
  image(threadId: string, id: string, thumb?: boolean): Promise<string | null>;
  /** Hears the thread whose frames changed; returns the unsubscribe. */
  subscribe(listener: (threadId: string) => void): () => void;
}

/** What the window half answers `encode` with: the frame, its thumbnail and a small grey copy to compare. */
export interface EncodedFrame {
  /** JPEG, base64. */
  frame: string;
  width: number;
  height: number;
  thumb: string;
  /** One byte of brightness per pixel, base64, `lumaWidth` × `lumaHeight`. */
  luma: string;
  lumaWidth: number;
  lumaHeight: number;
}

/** Computer Use's contract, copied rather than imported (a kit never imports another kit): the part this kit reads. */
export const COMPUTER_USE_EXTENSION_ID = "tau.computer-use";
export const COMPUTER_USE_TOOL_PREFIX = "computer_use_";

export interface ScreenAction {
  id: string;
  kind: "click" | "double-click" | "right-click" | "drag" | "type" | "key" | "scroll";
  at: number;
  text?: string;
  keys?: string[];
  direction?: "up" | "down" | "left" | "right";
}

export interface ScreenWindow {
  pid: number;
  windowId?: number;
  app?: string;
  title?: string;
}

export interface ScreenState {
  threadId: string;
  window?: ScreenWindow;
  frame?: { seq: number; at: number; width: number; height: number; mimeType: string; window: ScreenWindow };
  actions: ScreenAction[];
}

export interface ScreenFrame {
  seq: number;
  data: string;
  mimeType: string;
  window: ScreenWindow;
}

/** Preview Kit's `evidence-frame` answer, copied the same way. */
export const PREVIEW_EXTENSION_ID = "tau.preview";

export type PreviewEvidenceFrame =
  | { data: string; width: number; height: number; url: string; title: string; visible: boolean }
  | { skipped: "closed" | "secret" | "empty" };
